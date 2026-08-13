/**
 * Two-factor authentication for Firebase.
 *
 * Supports email OTP (default) or Google Authenticator TOTP when `MFA_USE_TOTP=true`.
 * Recovery codes are a fallback in both modes. Disable/regenerate require re-verification
 * with the active factor.
 */

const crypto = require('crypto');
const { generateSecret, generateURI, verifySync } = require('otplib');

const { onCall } = require('firebase-functions/v2/https');

const {
    auth,
    db,
    FieldValue,
    Timestamp,
    fail,
    requireAuth,
    sha256,
    deterministicId,
    stamps,
    touch,
    assertRateLimit,
    withLogging,
} = require('./common');

const { sendOtpEmail, RESEND_API_KEY, RESEND_FROM } = require('./email');

const REGION = process.env.FIREBASE_REGION || 'me-central1';

/** When true, login/setup/disable use TOTP (Google Authenticator) instead of email OTP. */
const MFA_USE_TOTP = process.env.MFA_USE_TOTP === 'true';
const TOTP_ISSUER = process.env.MFA_TOTP_ISSUER || 'Expense Tracker';
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000;

const TOTP_EPOCH_TOLERANCE = 1;

const MFA_STATE_COLLECTION = 'mfa_state';
const MFA_CHALLENGES_COLLECTION = 'mfa_challenges';

const RESEND_COOLDOWN_MS = 60 * 1000;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_RESENDS_PER_WINDOW = 5;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const VERIFIED_FRESHNESS_MS = 10 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;

const maskEmail = (email) => {
    const [local, domain] = String(email || '').split('@');
    if (!local || !domain) return 'your registered email';
    return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
};

const mfaStateRef = (uid) => db.collection(MFA_STATE_COLLECTION).doc(uid);

const generateRecoveryCode = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i += 1) {
        code += alphabet[crypto.randomInt(alphabet.length)];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
};

const hashRecoveryCode = (code) => sha256(String(code || '').trim().toUpperCase().replace(/[\s-]/g, ''));

const getUserDoc = async (uid) => {
    const snapshot = await db.collection('users').doc(uid).get();
    return snapshot.exists ? snapshot.data() : null;
};

const requireVerifiedEmail = async (uid) => {
    const authUser = await auth.getUser(uid);
    if (!authUser.emailVerified) {
        throw fail('EMAIL_NOT_VERIFIED', 403);
    }
    return authUser;
};

const isTotpEnabledForUser = async (uid) => {
    if (!MFA_USE_TOTP) return false;
    const snapshot = await mfaStateRef(uid).get();
    return !!snapshot.data()?.totp_secret;
};

const verifyTotpToken = (secret, token) => {
    const trimmed = String(token || '').trim();
    if (!/^\d{6}$/.test(trimmed)) return false;
    return verifySync({ token: trimmed, secret: String(secret || ''), epochTolerance: TOTP_EPOCH_TOLERANCE });
};

const handleSetupTotp = async (uid) => {
    await requireVerifiedEmail(uid);

    const userDoc = await getUserDoc(uid);
    if (userDoc?.mfa_enabled) {
        throw fail('MFA_ALREADY_ENABLED', 409);
    }

    const authUser = await auth.getUser(uid);
    const email = String(authUser.email || '').trim();
    if (!email) throw fail('TOTP_SETUP_FAILED', 500);

    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: email, secret });
    const now = Date.now();

    await mfaStateRef(uid).set(
        {
            user_id: uid,
            totp_pending_secret: secret,
            totp_pending_at: now,
            ...touch(),
        },
        { merge: true }
    );

    return {
        success: true,
        otpauthUrl,
        manualEntryKey: secret,
        factor: 'totp',
    };
};

const handleConfirmTotpSetup = async (uid, otp) => {
    await requireVerifiedEmail(uid);

    const ref = mfaStateRef(uid);
    const snapshot = await ref.get();
    const state = snapshot.exists ? snapshot.data() : {};
    const now = Date.now();

    const pendingSecret = state.totp_pending_secret;
    if (!pendingSecret) {
        return { success: false, error: 'TOTP_SETUP_NOT_STARTED', status: 400 };
    }

    if (state.totp_pending_at && now - state.totp_pending_at > TOTP_SETUP_TTL_MS) {
        await ref.set(
            {
                totp_pending_secret: FieldValue.delete(),
                totp_pending_at: FieldValue.delete(),
                ...touch(),
            },
            { merge: true }
        );
        return { success: false, error: 'TOTP_SETUP_EXPIRED', status: 400 };
    }

    if (!verifyTotpToken(pendingSecret, otp)) {
        return { success: false, error: 'INVALID_OTP', status: 400 };
    }

    await ref.set(
        {
            totp_secret: pendingSecret,
            totp_pending_secret: FieldValue.delete(),
            totp_pending_at: FieldValue.delete(),
            ...touch(),
        },
        { merge: true }
    );

    await db.collection('users').doc(uid).set({ mfa_enabled: true, ...touch() }, { merge: true });

    return { success: true, mfa: true, factor: 'totp' };
};

const createTotpChallenge = async (uid, normalizedPurpose, email) => {
    const ref = mfaStateRef(uid);
    const snapshot = await ref.get();
    const state = snapshot.exists ? snapshot.data() : {};
    const now = Date.now();

    if (state.lockedUntil && now < state.lockedUntil) {
        return {
            success: false,
            error: 'TOO_MANY_ATTEMPTS',
            status: 429,
            retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
        };
    }

    if (!state.totp_secret) {
        throw fail('TOTP_NOT_CONFIGURED', 400);
    }

    const challengeId = deterministicId('mfa', uid, normalizedPurpose, String(now));

    await db.collection(MFA_CHALLENGES_COLLECTION).doc(challengeId).set({
        user_id: uid,
        purpose: normalizedPurpose,
        factor: 'totp',
        expires_at: Timestamp.fromMillis(now + OTP_TTL_MS),
        attempts: 0,
        verified: false,
        ...stamps(),
    });

    await ref.set(
        {
            user_id: uid,
            active_challenge_id: challengeId,
            active_purpose: normalizedPurpose,
            lockedUntil: null,
            ...touch(),
        },
        { merge: true }
    );

    return {
        success: true,
        challengeId,
        factor: 'totp',
        maskedEmail: maskEmail(email),
        expiresInSeconds: OTP_TTL_MS / 1000,
    };
};

const handleCreateChallenge = async (uid, purpose) => {
    const normalizedPurpose = String(purpose || 'login').trim();
    if (!['login', 'disable', 'regenerate'].includes(normalizedPurpose)) {
        throw fail('INVALID_PURPOSE', 400);
    }

    await assertRateLimit(uid, `mfaCreateChallenge:${normalizedPurpose}`, {
        max: 10,
        windowMs: 60 * 60 * 1000,
    });

    const userDoc = await getUserDoc(uid);
    if (normalizedPurpose === 'login') {
        if (!userDoc?.mfa_enabled) {
            throw fail('MFA_NOT_ENABLED', 400);
        }
    } else if (!userDoc?.mfa_enabled) {
        throw fail('MFA_NOT_ENABLED', 400);
    }

    const authUser = await requireVerifiedEmail(uid);
    const email = String(authUser.email || '').trim().toLowerCase();
    if (!email) throw fail('OTP_SEND_FAILED', 500);

    if (MFA_USE_TOTP && (await isTotpEnabledForUser(uid))) {
        return createTotpChallenge(uid, normalizedPurpose, email);
    }

    const ref = mfaStateRef(uid);
    const snapshot = await ref.get();
    const state = snapshot.exists ? snapshot.data() : {};
    const now = Date.now();

    if (state.lockedUntil && now < state.lockedUntil) {
        return {
            success: false,
            error: 'TOO_MANY_ATTEMPTS',
            status: 429,
            retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
        };
    }

    if (!state.windowStart || now - state.windowStart > RESEND_WINDOW_MS) {
        state.windowStart = now;
        state.resendCount = 0;
    }

    if (state.otpSentAt && now - state.otpSentAt < RESEND_COOLDOWN_MS) {
        if (state.active_challenge_id && state.active_purpose === normalizedPurpose) {
            return {
                success: true,
                challengeId: state.active_challenge_id,
                maskedEmail: maskEmail(email),
                cooldownSeconds: Math.ceil((RESEND_COOLDOWN_MS - (now - state.otpSentAt)) / 1000),
                expiresInSeconds: OTP_TTL_MS / 1000,
                alreadySent: true,
            };
        }

        return {
            success: false,
            error: 'RESEND_COOLDOWN',
            status: 429,
            retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - (now - state.otpSentAt)) / 1000),
        };
    }

    if ((state.resendCount || 0) >= MAX_RESENDS_PER_WINDOW) {
        state.lockedUntil = now + LOCKOUT_MS;
        await ref.set({ ...state, ...touch() }, { merge: true });
        return {
            success: false,
            error: 'TOO_MANY_RESENDS',
            status: 429,
            retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000),
        };
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const challengeId = deterministicId('mfa', uid, normalizedPurpose, String(now));

    await db.collection(MFA_CHALLENGES_COLLECTION).doc(challengeId).set({
        user_id: uid,
        purpose: normalizedPurpose,
        code_hash: sha256(`${challengeId}:${code}`),
        expires_at: Timestamp.fromMillis(now + OTP_TTL_MS),
        attempts: 0,
        verified: false,
        ...stamps(),
    });

    await ref.set(
        {
            user_id: uid,
            otpSentAt: now,
            resendCount: (state.resendCount || 0) + 1,
            windowStart: state.windowStart || now,
            lockedUntil: null,
            active_challenge_id: challengeId,
            active_purpose: normalizedPurpose,
            ...touch(),
        },
        { merge: true }
    );

    const otpPurpose = normalizedPurpose === 'login' ? 'mfa_login' : 'mfa_security';

    await sendOtpEmail({
        to: email,
        purpose: otpPurpose,
        code,
        expiresMinutes: OTP_TTL_MS / 60000,
    });

    return {
        success: true,
        challengeId,
        maskedEmail: maskEmail(email),
        cooldownSeconds: RESEND_COOLDOWN_MS / 1000,
        expiresInSeconds: OTP_TTL_MS / 1000,
        factor: 'email',
    };
};

const verifyRecoveryCode = async (uid, rawCode) => {
    const normalized = String(rawCode || '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{8,16}$/.test(normalized)) {
        return { success: false, error: 'INVALID_OTP', status: 400 };
    }

    const userRef = db.collection('users').doc(uid);

    const result = await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(userRef);
        if (!snapshot.exists) throw fail('USER_NOT_FOUND', 404);

        const data = snapshot.data();
        if (!data.mfa_enabled) throw fail('MFA_NOT_ENABLED', 400);

        const hashes = Array.isArray(data.mfa_recovery_code_hashes) ? data.mfa_recovery_code_hashes : [];
        const targetHash = hashRecoveryCode(normalized);
        const index = hashes.findIndex((entry) => entry === targetHash);
        if (index < 0) {
            return { success: false, error: 'INVALID_OTP', status: 400 };
        }

        const nextHashes = [...hashes];
        nextHashes.splice(index, 1);

        tx.set(
            userRef,
            {
                mfa_recovery_code_hashes: nextHashes,
                ...touch(),
            },
            { merge: true }
        );

        return { success: true };
    });

    return result;
};

const handleVerifyChallenge = async (uid, challengeId, otp, allowRecoveryCode) => {
    const trimmedOtp = String(otp || '').trim();

    if (!challengeId) throw fail('INVALID_CHALLENGE', 400);

    const ref = db.collection(MFA_CHALLENGES_COLLECTION).doc(String(challengeId));
    const snapshot = await ref.get();
    if (!snapshot.exists) {
        return { success: false, error: 'OTP_NOT_REQUESTED', status: 400 };
    }

    const challenge = snapshot.data();
    if (challenge.user_id !== uid) {
        return { success: false, error: 'OTP_NOT_REQUESTED', status: 400 };
    }

    const now = Date.now();
    const stateRef = mfaStateRef(uid);
    const stateSnapshot = await stateRef.get();
    const state = stateSnapshot.exists ? stateSnapshot.data() : {};

    if (state.lockedUntil && now < state.lockedUntil) {
        return {
            success: false,
            error: 'TOO_MANY_ATTEMPTS',
            status: 429,
            retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
        };
    }

    if (challenge.expires_at.toMillis() < now) {
        await ref.delete().catch(() => undefined);
        return { success: false, error: 'OTP_EXPIRED', status: 400 };
    }

    const isSixDigit = /^\d{6}$/.test(trimmedOtp);
    if (!isSixDigit) {
        if (challenge.purpose === 'login' && allowRecoveryCode !== false) {
            const recoveryResult = await verifyRecoveryCode(uid, trimmedOtp);
            if (recoveryResult.success) {
                await ref.delete().catch(() => undefined);
                await stateRef.set(
                    {
                        login_verified_at: now,
                        failCount: 0,
                        active_challenge_id: null,
                        active_purpose: null,
                        ...touch(),
                    },
                    { merge: true }
                );
                return { success: true, message: 'Recovery code accepted' };
            }
            return recoveryResult;
        }
        return { success: false, error: 'INVALID_OTP', status: 400 };
    }

    if (challenge.factor === 'totp' || (MFA_USE_TOTP && state.totp_secret)) {
        if (!verifyTotpToken(state.totp_secret, trimmedOtp)) {
            const failCount = (state.failCount || 0) + 1;
            if (failCount >= MAX_VERIFY_ATTEMPTS) {
                await stateRef.set(
                    {
                        failCount: 0,
                        lockedUntil: now + LOCKOUT_MS,
                        active_challenge_id: null,
                        active_purpose: null,
                        ...touch(),
                    },
                    { merge: true }
                );
                await ref.delete().catch(() => undefined);
                return {
                    success: false,
                    error: 'TOO_MANY_ATTEMPTS',
                    status: 429,
                    retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000),
                };
            }

            await db.collection(MFA_CHALLENGES_COLLECTION).doc(String(challengeId)).set(
                { attempts: (challenge.attempts || 0) + 1, ...touch() },
                { merge: true }
            );
            await stateRef.set({ failCount, ...touch() }, { merge: true });

            return {
                success: false,
                error: 'INVALID_OTP',
                status: 400,
                attemptsRemaining: MAX_VERIFY_ATTEMPTS - failCount,
            };
        }

        await ref.delete().catch(() => undefined);

        const verifiedPatch = {
            failCount: 0,
            active_challenge_id: null,
            active_purpose: null,
            ...touch(),
        };

        if (challenge.purpose === 'login') {
            verifiedPatch.login_verified_at = now;
        } else if (challenge.purpose === 'disable') {
            verifiedPatch.disable_verified_at = now;
        } else if (challenge.purpose === 'regenerate') {
            verifiedPatch.regenerate_verified_at = now;
        }

        await stateRef.set(verifiedPatch, { merge: true });

        return { success: true, message: 'Code verified', purpose: challenge.purpose, factor: 'totp' };
    }

    const expected = sha256(`${challengeId}:${trimmedOtp}`);
    if (expected !== challenge.code_hash) {
        const failCount = (state.failCount || 0) + 1;
        if (failCount >= MAX_VERIFY_ATTEMPTS) {
            await stateRef.set(
                {
                    failCount: 0,
                    lockedUntil: now + LOCKOUT_MS,
                    otpSentAt: null,
                    active_challenge_id: null,
                    active_purpose: null,
                    ...touch(),
                },
                { merge: true }
            );
            await ref.delete().catch(() => undefined);
            return {
                success: false,
                error: 'TOO_MANY_ATTEMPTS',
                status: 429,
                retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000),
            };
        }

        await db.collection(MFA_CHALLENGES_COLLECTION).doc(String(challengeId)).set(
            { attempts: (challenge.attempts || 0) + 1, ...touch() },
            { merge: true }
        );
        await stateRef.set({ failCount, ...touch() }, { merge: true });

        return {
            success: false,
            error: 'INVALID_OTP',
            status: 400,
            attemptsRemaining: MAX_VERIFY_ATTEMPTS - failCount,
        };
    }

    await ref.delete().catch(() => undefined);

    const verifiedPatch = {
        failCount: 0,
        active_challenge_id: null,
        active_purpose: null,
        ...touch(),
    };

    if (challenge.purpose === 'login') {
        verifiedPatch.login_verified_at = now;
    } else if (challenge.purpose === 'disable') {
        verifiedPatch.disable_verified_at = now;
    } else if (challenge.purpose === 'regenerate') {
        verifiedPatch.regenerate_verified_at = now;
    }

    await stateRef.set(verifiedPatch, { merge: true });

    return { success: true, message: 'Code verified', purpose: challenge.purpose };
};

const handleSetEnabled = async (uid, enabled) => {
    const nextEnabled = !!enabled;
    const userRef = db.collection('users').doc(uid);

    if (nextEnabled) {
        if (MFA_USE_TOTP) {
            throw fail('TOTP_SETUP_REQUIRED', 400);
        }
        await requireVerifiedEmail(uid);
        await userRef.set({ mfa_enabled: true, ...touch() }, { merge: true });
        return { success: true, mfa: true, factor: 'email' };
    }

    const stateSnapshot = await mfaStateRef(uid).get();
    const state = stateSnapshot.exists ? stateSnapshot.data() : {};
    const now = Date.now();

    if (!state.disable_verified_at || now - state.disable_verified_at > VERIFIED_FRESHNESS_MS) {
        return { success: false, error: 'OTP_VERIFICATION_REQUIRED', status: 403 };
    }

    await userRef.set(
        {
            mfa_enabled: false,
            mfa_recovery_code_hashes: FieldValue.delete(),
            ...touch(),
        },
        { merge: true }
    );

    await mfaStateRef(uid).set(
        {
            disable_verified_at: null,
            regenerate_verified_at: null,
            login_verified_at: null,
            totp_secret: FieldValue.delete(),
            totp_pending_secret: FieldValue.delete(),
            totp_pending_at: FieldValue.delete(),
            ...touch(),
        },
        { merge: true }
    );

    return { success: true, mfa: false };
};

const writeRecoveryCodes = async (uid) => {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await getUserDoc(uid);
    if (!userDoc?.mfa_enabled) {
        throw fail('MFA_NOT_ENABLED', 400);
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    const hashes = codes.map((code) => hashRecoveryCode(code));

    await userRef.set(
        {
            mfa_recovery_code_hashes: hashes,
            ...touch(),
        },
        { merge: true }
    );

    return codes;
};

const handleCreateRecoveryCodes = async (uid) => {
    await requireVerifiedEmail(uid);

    const userDoc = await getUserDoc(uid);
    if (!userDoc?.mfa_enabled) {
        throw fail('MFA_NOT_ENABLED', 400);
    }

    const existing = Array.isArray(userDoc.mfa_recovery_code_hashes) ? userDoc.mfa_recovery_code_hashes : [];
    if (existing.length > 0) {
        throw fail('RECOVERY_CODES_ALREADY_EXIST', 409);
    }

    const recoveryCodes = await writeRecoveryCodes(uid);
    return { success: true, recoveryCodes };
};

const handleRegenerateRecoveryCodes = async (uid) => {
    const stateSnapshot = await mfaStateRef(uid).get();
    const state = stateSnapshot.exists ? stateSnapshot.data() : {};
    const now = Date.now();

    if (!state.regenerate_verified_at || now - state.regenerate_verified_at > VERIFIED_FRESHNESS_MS) {
        return { success: false, error: 'OTP_VERIFICATION_REQUIRED', status: 403 };
    }

    const recoveryCodes = await writeRecoveryCodes(uid);

    await mfaStateRef(uid).set({ regenerate_verified_at: null, ...touch() }, { merge: true });

    return { success: true, recoveryCodes };
};

/**
 * Email MFA callable — Appwrite MFA/recovery-code parity for Firebase builds.
 */
const mfaActions = onCall(
    {
        region: REGION,
        maxInstances: 10,
        secrets: [RESEND_API_KEY, RESEND_FROM],
    },
    async (request) => {
    const uid = requireAuth(request);
    const action = String((request.data && request.data.action) || '').trim();
    const challengeId = (request.data && request.data.challengeId) || '';
    const otp = (request.data && request.data.otp) || '';
    const purpose = (request.data && request.data.purpose) || 'login';
    const enabled = !!(request.data && request.data.enabled);
    const allowRecoveryCode = request.data?.allowRecoveryCode;

    return withLogging('mfaActions', uid, { action }, async () => {
        switch (action) {
            case 'create_challenge':
                return handleCreateChallenge(uid, purpose);
            case 'verify_challenge':
                return handleVerifyChallenge(uid, challengeId, otp, allowRecoveryCode);
            case 'setup_totp':
                return handleSetupTotp(uid);
            case 'confirm_totp_setup':
                return handleConfirmTotpSetup(uid, otp);
            case 'set_enabled':
                return handleSetEnabled(uid, enabled);
            case 'create_recovery_codes':
                return handleCreateRecoveryCodes(uid);
            case 'regenerate_recovery_codes':
                return handleRegenerateRecoveryCodes(uid);
            default:
                throw fail('INVALID_ACTION', 400);
        }
    });
    }
);

module.exports = { mfaActions, MFA_USE_TOTP };
