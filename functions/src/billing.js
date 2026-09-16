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
const { logger } = require('firebase-functions');
const { google } = require('googleapis');

const { db, fail, requireAuth, sha256, stamps, touch, assertRateLimit } = require('./common');

// Must match the app's Android package name exactly (Play Console → App integrity)
// and the base plan IDs created under the `unity_pro` subscription in Play Console.
const ANDROID_PACKAGE_NAME = 'com.xeurotech.aiexpense';
// This function runs AS this service account (see `serviceAccount:` on
// verifyGooglePurchase/playRtdnHandler below) instead of loading a downloaded
// JSON key — the org's `iam.disableServiceAccountKeyCreation` policy blocks key
// creation anyway, and running-as is the more secure option Google recommends.
// It must be authorized in Play Console (Users and permissions) exactly like a
// human user would be, with the same Play Developer API account permissions.
const ANDROID_PUBLISHER_SERVICE_ACCOUNT = 'unity-finance-play-api@expense-tracker-b8db9.iam.gserviceaccount.com';
const ANDROID_BASE_PLAN_TO_CYCLE = { 'unity-pro-monthly': 'monthly', 'unity-pro-yearly': 'yearly' };
// A subscription still counts as usable Pro in these states as long as its
// expiry time is still in the future — e.g. SUBSCRIPTION_STATE_CANCELED means
// auto-renew is off, but the user already paid through `expiryTime`.
const ACTIVE_SUBSCRIPTION_STATES = new Set([
    'SUBSCRIPTION_STATE_ACTIVE',
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    'SUBSCRIPTION_STATE_CANCELED',
]);

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/**
 * Writes the entitlement. The ONLY place `prefs.plan` is ever set to 'pro'.
 *
 * `subscriptionVerificationHash` MUST be a non-empty string here. The shared
 * frontend gate (`services/subscription.ts` -> `normalizeSubscriptionPrefs` ->
 * `hasServerVerification`) treats `plan: 'pro'` alone as NOT verified and falls
 * back to Free unless this field is also present - it is the Firebase port of
 * Appwrite's HMAC-signed prefs blob (there is no signature to verify here,
 * since these keys are server-write-only per firestore.rules, but the client
 * check still requires the field to exist). Omitting it - the bug this fixes -
 * meant NO grant, real purchase or otherwise, ever showed as Pro on the client.
 */
const grantEntitlement = async (uid, { productId, platform, expiresAt, billingCycle, status }) => {
    const prefs = {
        plan: status === 'active' ? 'pro' : 'free',
        subscriptionStatus: status,
        subscriptionProductId: productId,
        subscriptionPlatform: platform,
        subscriptionExpiresAt: expiresAt,
        subscriptionEndDate: expiresAt,
        billingCycle: billingCycle || null,
        subscriptionVerificationHash: sha256(`${uid}:${productId}:${status}:${expiresAt}`),
    };

    await db.collection('users').doc(uid).set({ prefs, ...touch() }, { merge: true });

    return prefs;
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

let cachedAndroidPublisher = null;

/**
 * Builds an Android Publisher API client authenticated as this function's OWN
 * runtime identity (Application Default Credentials) — no downloaded key file.
 * The function must be deployed with `serviceAccount: ANDROID_PUBLISHER_SERVICE_ACCOUNT`
 * (see below) so ADC resolves to that identity instead of the project default.
 */
const getAndroidPublisher = () => {
    if (cachedAndroidPublisher) return cachedAndroidPublisher;

    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    cachedAndroidPublisher = google.androidpublisher({ version: 'v3', auth });
    return cachedAndroidPublisher;
};

/**
 * Calls Play Developer API `purchases.subscriptionsv2.get` (the source of truth —
 * never trust productId/billingCycle/expiry from the client), acknowledges the
 * purchase if Play hasn't seen an acknowledgement yet (an unacknowledged
 * subscription auto-refunds after 3 days), and returns the fields
 * `grantEntitlement` needs. Shared by `verifyGooglePurchase` and `playRtdnHandler`.
 */
const fetchAndAcknowledgeSubscription = async (purchaseToken) => {
    const androidpublisher = getAndroidPublisher();

    let data;
    try {
        ({ data } = await androidpublisher.purchases.subscriptionsv2.get({
            packageName: ANDROID_PACKAGE_NAME,
            token: purchaseToken,
        }));
    } catch (error) {
        // Most commonly: the service account isn't authorized in Play Console yet,
        // or doesn't have the Pub/Sub-adjacent Play Developer API access granted.
        logger.error('Play Developer API subscriptionsv2.get failed', error);
        throw fail('STORE_VERIFICATION_FAILED', 502);
    }

    const lineItem = (data.lineItems || [])[0];
    if (!lineItem) throw fail('INVALID_PURCHASE', 400);

    const basePlanId = lineItem.offerDetails && lineItem.offerDetails.basePlanId;
    const billingCycle = ANDROID_BASE_PLAN_TO_CYCLE[basePlanId] || null;
    const expiresAt = lineItem.expiryTime || null;
    const expiryMs = expiresAt ? new Date(expiresAt).getTime() : 0;
    const status = ACTIVE_SUBSCRIPTION_STATES.has(data.subscriptionState) && expiryMs > Date.now()
        ? 'active'
        : 'expired';

    if (data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
        try {
            await androidpublisher.purchases.subscriptions.acknowledge({
                packageName: ANDROID_PACKAGE_NAME,
                subscriptionId: lineItem.productId,
                token: purchaseToken,
                requestBody: {},
            });
        } catch (error) {
            // Must not block granting entitlement — safe to retry acknowledgement
            // on the next verify/RTDN call if this one failed transiently.
            logger.warn('Play subscription acknowledge failed', error);
        }
    }

    return {
        productId: lineItem.productId,
        billingCycle,
        expiresAt,
        status,
        obfuscatedAccountId:
            (data.externalAccountIdentifiers && data.externalAccountIdentifiers.obfuscatedExternalAccountId) || null,
    };
};

const verifyGooglePurchase = onCall({ region: REGION, maxInstances: 10, serviceAccount: ANDROID_PUBLISHER_SERVICE_ACCOUNT }, async (request) => {
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

    const verified = await fetchAndAcknowledgeSubscription(purchaseToken);

    // Defence in depth: `obfuscatedAccountId` is set by the client at purchase
    // time (frontend `buySubscription`) and echoed back by Play here. A token
    // that was never claimed yet but belongs to a different account (e.g. a
    // restore attempted on the wrong account) is rejected rather than granted.
    if (verified.obfuscatedAccountId && verified.obfuscatedAccountId !== uid) {
        throw fail('PURCHASE_ALREADY_CLAIMED', 409);
    }

    const subscription = await grantEntitlement(uid, {
        productId: verified.productId,
        platform: 'android',
        expiresAt: verified.expiresAt,
        billingCycle: verified.billingCycle,
        status: verified.status,
    });

    return { success: true, subscription };
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
    { topic: 'play-rtdn', region: REGION, maxInstances: 10, serviceAccount: ANDROID_PUBLISHER_SERVICE_ACCOUNT },
    async (event) => {
        const messageId = event.id;
        const seenRef = db.collection('purchase_tokens').doc(`rtdn_${sha256(messageId)}`);

        try {
            await seenRef.create({ kind: 'rtdn', ...stamps() });
        } catch (error) {
            if (error.code === 6 || error.code === 'already-exists') return;
            throw error;
        }

        let notification;
        try {
            notification = event.data.message.json;
        } catch (error) {
            logger.error('Could not decode RTDN Pub/Sub message', error);
            return;
        }

        const subscriptionNotification = notification && notification.subscriptionNotification;
        const purchaseToken = subscriptionNotification && subscriptionNotification.purchaseToken;
        if (!purchaseToken) {
            // Play Console's "Send test notification" button, and one-time-product
            // notifications, land here too — nothing to reconcile for those.
            return;
        }

        const tokenRef = db.collection('purchase_tokens').doc(sha256(purchaseToken));
        const tokenDoc = await tokenRef.get();
        if (!tokenDoc.exists || !tokenDoc.data().user_id) {
            // Not yet claimed by verifyGooglePurchase (Play's RTDN can arrive before
            // the client's own verify call finishes). The next RTDN, or the client
            // retrying verify/restore, will pick this purchase token up.
            logger.warn('RTDN for an unclaimed purchase token — skipping', { messageId });
            return;
        }

        const uid = tokenDoc.data().user_id;

        const verified = await fetchAndAcknowledgeSubscription(purchaseToken);

        await grantEntitlement(uid, {
            productId: verified.productId,
            platform: 'android',
            expiresAt: verified.expiresAt,
            billingCycle: verified.billingCycle,
            status: verified.status,
        });
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
