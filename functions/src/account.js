/**
 * Account lifecycle: deletion and the email-change OTP flow.
 */

const crypto = require('crypto');

const { onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const {
    auth,
    db,
    FieldValue,
    Timestamp,
    fail,
    requireAuth,
    deterministicId,
    stamps,
    touch,
    DELETED_AT,
    assertRateLimit,
} = require('./common');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/**
 * Deletes the account and every trace of it.
 *
 * Materially simpler than the Appwrite equivalent: under the subcollection layout a
 * single `recursiveDelete(users/{uid})` replaces 25 per-collection field deletions.
 * The shared collections still need explicit handling, because those documents are
 * co-owned and cannot simply vanish from the other participant's view.
 */
const deleteAccount = onCall({ region: REGION, timeoutSeconds: 300, maxInstances: 5 }, async (request) => {
    const uid = requireAuth(request);

    // 1. Everything owned outright — wallets, transactions, budgets, device tokens…
    await db.recursiveDelete(db.collection('users').doc(uid));

    // 2. Shared rows. Tombstoned rather than deleted, so the other participant's
    //    split history stays internally consistent instead of developing a hole
    //    where a member row used to be.
    for (const collection of ['friends', 'friend_requests', 'split_members', 'notifications']) {
        const snapshot = await db
            .collection(collection)
            .where('user_id', '==', uid)
            .limit(500)
            .get();

        if (snapshot.empty) continue;

        const batch = db.batch();
        for (const doc of snapshot.docs) {
            batch.set(doc.ref, { [DELETED_AT]: FieldValue.serverTimestamp(), ...touch() }, { merge: true });
        }
        await batch.commit();
    }

    // 3. The searchable mirror must go immediately — it is the only public surface.
    await db.collection('public_profiles').doc(uid).delete().catch(() => undefined);

    // 4. The auth record last. Doing it first would revoke our own ability to
    //    identify the caller mid-way through, leaving orphaned data behind.
    await auth.deleteUser(uid);

    return { success: true };
});

/**
 * Issues an email-change OTP.
 *
 * ── TWO THINGS TO NOTE ──────────────────────────────────────────────────────────
 *
 * 1. The uid comes from `request.auth`, NEVER from the body. The Appwrite
 *    `email-change-handler` trusts `userId` from the request body, which lets any
 *    caller change any user's email. That defect is not reproducible in a callable —
 *    there is no body field to trust.
 *
 * 2. Firebase has NO email-OTP primitive, so this needs a transactional email vendor.
 *    That vendor is DEC-EMAIL-PROVIDER and is unanswered, so the function stores the
 *    challenge correctly and then refuses with EMAIL_PROVIDER_NOT_CONFIGURED rather
 *    than pretending to have sent something. `FIREBASE_CAPABILITIES.supportsEmailOtp`
 *    is false to match, so the UI can gate the screen instead of hitting this.
 */
const requestEmailChange = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    // §16 — each call would email a real OTP once DEC-EMAIL-PROVIDER lands; bound it
    // now so that flow does not ship without a limit already in place.
    await assertRateLimit(uid, 'requestEmailChange', { max: 5, windowMs: 60 * 60 * 1000 });
    const email = String((request.data && request.data.email) || '').trim().toLowerCase();

    if (!email || !email.includes('@')) throw fail('INVALID_EMAIL', 400);

    const existing = await auth.getUserByEmail(email).catch(() => null);
    if (existing) throw fail('EMAIL_ALREADY_IN_USE', 409);

    // CSPRNG, not Math.random(). V8's PRNG state is recoverable from a handful of
    // observed outputs, and this code gates an email change. The 5-attempt cap in
    // confirmEmailChange bounds online guessing, but it does not help if the sequence
    // itself is predictable.
    const code = String(crypto.randomInt(100000, 1000000));
    const challengeId = deterministicId('otp', uid, email);

    await db.collection('otp_challenges').doc(challengeId).set({
        user_id: uid,
        email,
        // Stored hashed: `otp_challenges` is server-only, but a plaintext one-time
        // code in a database is an unnecessary secret to hold.
        code_hash: require('./common').sha256(`${challengeId}:${code}`),
        attempts: 0,
        expires_at: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
        ...stamps(),
    });

    if (!process.env.TRANSACTIONAL_EMAIL_API_KEY) {
        throw fail('EMAIL_PROVIDER_NOT_CONFIGURED', 501);
    }

    // Vendor send goes here once DEC-EMAIL-PROVIDER is answered.
    return { success: true, challengeId };
});

const confirmEmailChange = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    const challengeId = String((request.data && request.data.challengeId) || '').trim();
    const code = String((request.data && request.data.code) || '').trim();

    if (!challengeId || !code) throw fail('INVALID_OTP', 400);

    const ref = db.collection('otp_challenges').doc(challengeId);

    const email = await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw fail('OTP_NOT_FOUND', 404);

        const data = snapshot.data();
        if (data.user_id !== uid) throw fail('OTP_NOT_FOUND', 404);
        if (data.expires_at.toMillis() < Date.now()) throw fail('OTP_EXPIRED', 400);

        // Bounded attempts — otherwise a 6-digit code is brute-forceable in seconds.
        if ((data.attempts || 0) >= 5) throw fail('OTP_TOO_MANY_ATTEMPTS', 429);

        const expected = require('./common').sha256(`${challengeId}:${code}`);
        if (expected !== data.code_hash) {
            tx.update(ref, { attempts: (data.attempts || 0) + 1, ...touch() });
            throw fail('INVALID_OTP', 400);
        }

        tx.delete(ref);
        return data.email;
    });

    await auth.updateUser(uid, { email, emailVerified: false });
    await db.collection('users').doc(uid).set({ email, ...touch() }, { merge: true });

    return { success: true };
});

/**
 * Bounded tombstone lifetime.
 *
 * Without this, `_deletedAt` rows accumulate forever and every exhaustive pull pays
 * for them. Ninety days is comfortably longer than any plausible offline period, so
 * a device that has been dark still learns about deletions rather than silently
 * keeping rows the cloud has forgotten.
 */
const purgeTombstones = onSchedule(
    { schedule: 'every 24 hours', region: REGION, maxInstances: 1 },
    async () => {
        const cutoff = Timestamp.fromMillis(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const collections = ['friends', 'friend_requests', 'split_expenses', 'split_members', 'notifications'];

        for (const collection of collections) {
            const snapshot = await db
                .collection(collection)
                .where(DELETED_AT, '<', cutoff)
                .limit(500)
                .get();

            if (snapshot.empty) continue;

            const batch = db.batch();
            for (const doc of snapshot.docs) batch.delete(doc.ref);
            await batch.commit();
        }
    }
);

module.exports = { deleteAccount, requestEmailChange, confirmEmailChange, purgeTombstones };
