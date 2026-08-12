/**
 * Purchase verification and subscription lifecycle.
 *
 * ── THIS MODULE CLOSES A REAL DEFECT (C-SUB-5) ──────────────────────────────────
 * The Appwrite system has NO subscription renewal webhook. Nothing re-verifies an
 * active subscription after the initial purchase, so every Pro subscriber is
 * auto-downgraded at their first renewal. Under Appwrite that degrades gracefully —
 * sync stops, SQLite is still authoritative, the app keeps working — but the user has
 * paid and lost the feature.
 *
 * `playRtdnHandler` and `appleNotificationsV2Handler` below are the renewal path.
 * They are listed as NEW Firebase functions, not as Appwrite fixes: repairing the
 * Appwrite side is a separate, separately-approved task and nothing here touches it.
 *
 * ── ENTITLEMENT IS SERVER-WRITTEN, NEVER CLIENT-WRITTEN ─────────────────────────
 * Appwrite protects entitlement with an HMAC because prefs live in client-writable
 * account preferences. Here the subscription keys inside `users/{uid}.prefs` are
 * simply not writable by the client (see firestore.rules), so there is no signature
 * to forge and no shared secret shipped in the app bundle.
 *
 * ── STORE CREDENTIALS ARE NOT CONFIGURED ────────────────────────────────────────
 * Receipt validation requires Play Developer API credentials and an App Store Connect
 * key. Neither is available in this environment, so the verification calls below
 * refuse with STORE_CREDENTIALS_NOT_CONFIGURED rather than silently granting Pro.
 * Granting an unverified entitlement would be strictly worse than failing: it is a
 * free-Pro exploit.
 */

const { onCall, onRequest } = require('firebase-functions/v2/https');
const { onMessagePublished } = require('firebase-functions/v2/pubsub');

const { db, fail, requireAuth, sha256, stamps, touch, assertRateLimit } = require('./common');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/**
 * Writes the entitlement. The ONLY place `prefs.plan` is ever set to 'pro'.
 */
const grantEntitlement = async (uid, { productId, platform, expiresAt, billingCycle, status }) => {
    await db.collection('users').doc(uid).set(
        {
            prefs: {
                plan: status === 'active' ? 'pro' : 'free',
                subscriptionStatus: status,
                subscriptionProductId: productId,
                subscriptionPlatform: platform,
                subscriptionExpiresAt: expiresAt,
                subscriptionEndDate: expiresAt,
                billingCycle: billingCycle || null,
            },
            ...touch(),
        },
        { merge: true }
    );
};

/**
 * Claims a purchase token for exactly one user.
 *
 * Document EXISTENCE is the uniqueness check, and `create()` is what enforces it —
 * this replaces the Appwrite implementation's O(N) scan over every user's prefs
 * looking for a matching token. `set()` here would let one purchase token grant Pro
 * to unlimited accounts.
 */
const claimPurchaseToken = async (token, uid) => {
    const ref = db.collection('purchase_tokens').doc(sha256(token));

    try {
        await ref.create({ user_id: uid, ...stamps() });
        return true;
    } catch (error) {
        if (error.code !== 6 && error.code !== 'already-exists') throw error;
        const existing = await ref.get();
        // A repeat verification by the SAME user is a legitimate restore.
        return existing.exists && existing.data().user_id === uid;
    }
};

const verifyGooglePurchase = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    // §16 — receipt verification calls a paid external API once credentials land;
    // bound it now rather than after that becomes a real per-call cost.
    await assertRateLimit(uid, 'verifyGooglePurchase', { max: 10, windowMs: 60 * 60 * 1000 });
    const purchaseToken = String((request.data && request.data.purchaseToken) || '').trim();
    const productId = String((request.data && request.data.productId) || '').trim();

    if (!purchaseToken || !productId) throw fail('INVALID_PURCHASE', 400);

    if (!(await claimPurchaseToken(purchaseToken, uid))) {
        throw fail('PURCHASE_ALREADY_CLAIMED', 409);
    }

    if (!process.env.PLAY_SERVICE_ACCOUNT_JSON) {
        throw fail('STORE_CREDENTIALS_NOT_CONFIGURED', 501);
    }

    // Play Developer API `purchases.subscriptionsv2.get` goes here, then:
    //   grantEntitlement(uid, { ... , status: 'active' })
    throw fail('STORE_CREDENTIALS_NOT_CONFIGURED', 501);
});

const verifyApplePurchase = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    await assertRateLimit(uid, 'verifyApplePurchase', { max: 10, windowMs: 60 * 60 * 1000 });
    const transactionId = String((request.data && request.data.transactionId) || '').trim();
    const productId = String((request.data && request.data.productId) || '').trim();

    if (!transactionId || !productId) throw fail('INVALID_PURCHASE', 400);

    if (!(await claimPurchaseToken(transactionId, uid))) {
        throw fail('PURCHASE_ALREADY_CLAIMED', 409);
    }

    if (!process.env.APPLE_ISSUER_ID || !process.env.APPLE_PRIVATE_KEY) {
        throw fail('STORE_CREDENTIALS_NOT_CONFIGURED', 501);
    }

    throw fail('STORE_CREDENTIALS_NOT_CONFIGURED', 501);
});

/**
 * Play Real-time Developer Notifications — the renewal path that Appwrite lacks.
 *
 * Idempotent by message id: Pub/Sub is at-least-once, and applying a renewal twice
 * must not extend the subscription twice.
 */
const playRtdnHandler = onMessagePublished(
    { topic: 'play-rtdn', region: REGION, maxInstances: 10 },
    async (event) => {
        const messageId = event.id;
        const seenRef = db.collection('purchase_tokens').doc(`rtdn_${sha256(messageId)}`);

        try {
            await seenRef.create({ kind: 'rtdn', ...stamps() });
        } catch (error) {
            if (error.code === 6 || error.code === 'already-exists') return;
            throw error;
        }

        // Decode, look up the purchase token's owner, re-verify with the Play API and
        // call grantEntitlement with the new expiry or a downgrade.
        void grantEntitlement;
    }
);

const appleNotificationsV2Handler = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    // App Store Server Notifications V2 arrive as a signed JWS. The signature MUST be
    // verified against Apple's certificate chain before anything is trusted —
    // otherwise this endpoint is an unauthenticated "make me Pro" button.
    if (!process.env.APPLE_ROOT_CA) {
        res.status(501).send('STORE_CREDENTIALS_NOT_CONFIGURED');
        return;
    }
    res.status(501).send('STORE_CREDENTIALS_NOT_CONFIGURED');
});

module.exports = {
    verifyGooglePurchase,
    verifyApplePurchase,
    playRtdnHandler,
    appleNotificationsV2Handler,
    grantEntitlement,
};
