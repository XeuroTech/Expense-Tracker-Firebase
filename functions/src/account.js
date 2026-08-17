/**
 * Account lifecycle: deletion and the email-change link flow.
 */

const { onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const {
    auth,
    db,
    FieldValue,
    fail,
    requireAuth,
    touch,
    DELETED_AT,
    assertRateLimit,
    withLogging,
} = require('./common');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

// Mirrors the Appwrite `delete_account` function tuning constants.
const DUPLICATE_GUARD_MS = 2 * 60 * 1000;

const DELETION_STATE_COLLECTION = 'account_deletion_state';

const maskEmail = (email) => {
    const [local, domain] = String(email || '').split('@');
    if (!local || !domain) return 'your registered email';
    return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
};

const deletionStateRef = (uid) => db.collection(DELETION_STATE_COLLECTION).doc(uid);

const requireDeleteAuth = (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw fail('UNAUTHORIZED', 401);
    return uid;
};

/**
 * Deletes the account and every trace of it.
 *
 * Materially simpler than the Appwrite equivalent: under the subcollection layout a
 * single `recursiveDelete(users/{uid})` replaces 25 per-collection field deletions.
 * The shared collections still need explicit handling, because those documents are
 * co-owned and cannot simply vanish from the other participant's view.
 */
const performAccountDeletion = async (uid) => {
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

    // 4. OTP / deletion state must not survive the account.
    await deletionStateRef(uid).delete().catch(() => undefined);

    // 5. The auth record last. Doing it first would revoke our own ability to
    //    identify the caller mid-way through, leaving orphaned data behind.
    await auth.deleteUser(uid);
};

const handleDeleteConfirm = async (uid, confirmEmail) => {
    const authUser = await auth.getUser(uid);
    const registeredEmail = String(authUser.email || '').trim().toLowerCase();
    const typed = String(confirmEmail || '').trim().toLowerCase();

    if (!typed || !typed.includes('@')) {
        return { success: false, error: 'INVALID_EMAIL', status: 400 };
    }
    if (typed !== registeredEmail) {
        return { success: false, error: 'EMAIL_MISMATCH', status: 400 };
    }

    const ref = deletionStateRef(uid);
    const snapshot = await ref.get();
    const state = snapshot.exists ? snapshot.data() : {};
    const now = Date.now();

    if (state.inProgress && state.inProgressAt && now - state.inProgressAt < DUPLICATE_GUARD_MS) {
        return { success: false, error: 'DELETION_IN_PROGRESS', status: 409 };
    }

    await ref.set({ inProgress: true, inProgressAt: now, ...touch() }, { merge: true });

    try {
        await performAccountDeletion(uid);
    } catch (error) {
        await ref.set({ inProgress: false, inProgressAt: null, ...touch() }, { merge: true });
        throw fail('DELETE_FAILED', 500);
    }

    return { success: true, message: 'Account permanently deleted' };
};

/**
 * Account deletion callable.
 *
 * Dispatches on `action`:
 *   - confirm_delete — permanently delete after the caller types their registered email
 *
 * Returns `{ success, error?, ... }` envelopes so the frontend can share one screen
 * between Appwrite Functions and Firebase callables.
 */
const deleteAccount = onCall(
    {
        region: REGION,
        timeoutSeconds: 300,
        maxInstances: 5,
    },
    async (request) => {
    const uid = requireDeleteAuth(request);
    const action = String((request.data && request.data.action) || 'confirm_delete').trim();
    const confirmEmail = (request.data && request.data.confirmEmail) || '';

    return withLogging('deleteAccount', uid, { action }, async () => {
        if (action !== 'confirm_delete') {
            throw fail('INVALID_ACTION', 400);
        }
        await assertRateLimit(uid, 'deleteAccount', { max: 3, windowMs: 60 * 60 * 1000 });
        return handleDeleteConfirm(uid, confirmEmail);
    });
    }
);

/**
 * Validates and rate-limits an email-change request. Sends nothing itself.
 *
 * ── THINGS TO NOTE ──────────────────────────────────────────────────────────────
 *
 * 1. The uid comes from `request.auth`, NEVER from the body. The Appwrite
 *    `email-change-handler` trusts `userId` from the request body, which lets any
 *    caller change any user's email. That defect is not reproducible in a callable —
 *    there is no body field to trust.
 *
 * 2. The Admin SDK (`generateVerifyAndChangeEmailLink`) can only generate the
 *    action-link string — it never sends mail. Firebase's OWN official email for
 *    this flow only exists on the client SDK, via `verifyBeforeUpdateEmail()`,
 *    which generates the link AND sends Firebase's templated email in one call.
 *    So once this callable returns `{ success: true }`, the client must call:
 *
 *        await verifyBeforeUpdateEmail(auth.currentUser, newEmail)
 *
 *    itself — this callable only front-loads the checks (rate limit, duplicate
 *    email) so the client gets a clean error before Firebase ever sends mail.
 *
 * 3. Clicking the resulting link hits `hosting/index.html` (mode=verifyAndChangeEmail),
 *    which calls `applyActionCode` and the platform swaps the account's email
 *    itself. The client should then call `syncMyProfile` so `users/{uid}.email`
 *    picks up the change — Firebase Auth does not fire a Cloud Function trigger on
 *    user update. Customize the email's look and the link's destination under
 *    Firebase Console → Authentication → Templates → "Email address change".
 */
const requestEmailChange = onCall(
    {
        region: REGION,
        maxInstances: 10,
    },
    async (request) => {
    const uid = requireAuth(request);
    await assertRateLimit(uid, 'requestEmailChange', { max: 5, windowMs: 60 * 60 * 1000 });
    const email = String((request.data && request.data.email) || '').trim().toLowerCase();

    if (!email || !email.includes('@')) throw fail('INVALID_EMAIL', 400);

    const authUser = await auth.getUser(uid);
    const currentEmail = String(authUser.email || '').trim().toLowerCase();
    if (email === currentEmail) throw fail('SAME_EMAIL', 400);

    const existing = await auth.getUserByEmail(email).catch(() => null);
    if (existing && existing.uid !== uid) throw fail('EMAIL_ALREADY_IN_USE', 409);

    return { success: true, maskedEmail: maskEmail(email) };
    }
);

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

module.exports = { deleteAccount, requestEmailChange, purgeTombstones };
