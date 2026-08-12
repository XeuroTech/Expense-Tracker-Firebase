/**
 * Notification dispatch, inbox actions and the device-token registry.
 *
 * C-NT-1 is the shape to preserve: the inbox and push are separate, and push is
 * DOWNSTREAM. `onNotificationCreated` reacts to the document create; nothing writes a
 * push without an inbox row existing first.
 */

const { onCall } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

const {
    db,
    messaging,
    FieldValue,
    fail,
    requireAuth,
    sha256,
    stamps,
    touch,
    assertRateLimit,
} = require('./common');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/** C-NT-5 — verbatim from the Appwrite contract. */
const MAX_BULK_DELETE = 100;

// ---------------------------------------------------------------------------
// Push dispatch
// ---------------------------------------------------------------------------

/**
 * FCM fan-out for a newly created notification.
 *
 * ── §48 PUSH IDEMPOTENCY ────────────────────────────────────────────────────────
 * Firestore triggers are AT-LEAST-ONCE: a retry after a transient failure re-runs
 * this function for the SAME document. Without a guard the user gets the same push
 * twice.
 *
 * The guard is a `push_dispatched_at` marker written back to the notification inside a
 * transaction. A retry sees the marker and stops. The marker is checked and set
 * atomically, so two concurrent retries cannot both pass it.
 */
const onNotificationCreated = onDocumentCreated(
    { document: 'notifications/{notificationId}', region: REGION, maxInstances: 10 },
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) return;

        const notification = snapshot.data();
        const userId = notification.user_id;
        if (!userId) return;

        const claimed = await db.runTransaction(async (tx) => {
            const current = await tx.get(snapshot.ref);
            if (!current.exists) return false;
            if (current.data().push_dispatched_at) return false;

            tx.update(snapshot.ref, { push_dispatched_at: FieldValue.serverTimestamp() });
            return true;
        });

        if (!claimed) return;

        const tokens = await db
            .collection('users')
            .doc(userId)
            .collection('device_tokens')
            .where('is_active', '==', true)
            .where('_deletedAt', '==', null)
            .get();

        if (tokens.empty) return;

        const fcmTokens = tokens.docs
            .filter((doc) => doc.data().token_kind === 'fcm')
            .map((doc) => doc.data().token)
            .filter(Boolean);

        if (fcmTokens.length === 0) return;

        const response = await messaging.sendEachForMulticast({
            tokens: fcmTokens,
            notification: {
                title: notification.title || 'Unity Finance',
                body: notification.body || '',
            },
            data: {
                type: String(notification.type || ''),
                relatedCollection: String(notification.related_collection || ''),
                relatedDocumentId: String(notification.related_document_id || ''),
                splitExpenseId: String(notification.splitExpenseId || ''),
                splitMemberId: String(notification.splitMemberId || ''),
                notificationId: snapshot.id,
            },
        });

        // Prune tokens FCM reports as permanently invalid. Left in place they are
        // retried on every future notification forever, and each failure is billed.
        const batch = db.batch();
        let pruned = 0;

        response.responses.forEach((result, index) => {
            if (result.success) return;
            const code = result.error && result.error.code;
            if (
                code === 'messaging/registration-token-not-registered'
                || code === 'messaging/invalid-registration-token'
            ) {
                const token = fcmTokens[index];
                batch.set(
                    db.collection('users').doc(userId).collection('device_tokens').doc(sha256(token)),
                    { is_active: false, ...touch() },
                    { merge: true }
                );
                pruned += 1;
            }
        });

        if (pruned > 0) await batch.commit();
    }
);

// ---------------------------------------------------------------------------
// Inbox actions
// ---------------------------------------------------------------------------

/**
 * The delete/clear half of Appwrite's `send_notification`.
 *
 * Split from the trigger above because a Firestore trigger and a callable are
 * different function types — one function cannot be both. That is the "split into
 * two" case from docs/phase-1/05 §4.
 */
const notificationActions = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    const action = request.data && request.data.action;

    if (action === 'delete_notification') {
        const notificationId = String((request.data && request.data.notificationId) || '').trim();
        if (!notificationId) throw fail('MISSING_NOTIFICATION_ID', 400);

        const ref = db.collection('notifications').doc(notificationId);
        const snapshot = await ref.get();

        // C-NT-4 — idempotent delete is CONTRACTUAL. A missing notification is
        // success, and the client relies on it (notificationService.ts:105-110).
        if (!snapshot.exists) throw fail('NOTIFICATION_NOT_FOUND', 404);
        if (snapshot.data().user_id !== uid) throw fail('NOTIFICATION_DELETE_FORBIDDEN', 403);

        await ref.set({ _deletedAt: FieldValue.serverTimestamp(), ...touch() }, { merge: true });
        return { success: true, deleted: 1 };
    }

    if (action === 'delete_notifications') {
        const ids = Array.isArray(request.data && request.data.notificationIds)
            ? request.data.notificationIds
            : [];

        if (ids.length > MAX_BULK_DELETE) throw fail('TOO_MANY_NOTIFICATIONS', 400);
        if (ids.length === 0) return { success: true, deleted: 0 };

        const refs = ids.map((id) => db.collection('notifications').doc(String(id)));
        const snapshots = await db.getAll(...refs);

        const batch = db.batch();
        let deleted = 0;

        for (const snapshot of snapshots) {
            if (!snapshot.exists) continue;
            if (snapshot.data().user_id !== uid) continue;
            batch.set(
                snapshot.ref,
                { _deletedAt: FieldValue.serverTimestamp(), ...touch() },
                { merge: true }
            );
            deleted += 1;
        }

        if (deleted > 0) await batch.commit();
        return { success: true, deleted };
    }

    if (action === 'clear_notifications') {
        const snapshot = await db
            .collection('notifications')
            .where('user_id', '==', uid)
            .where('_deletedAt', '==', null)
            .limit(500)
            .get();

        if (snapshot.empty) return { success: true, deleted: 0 };

        const batch = db.batch();
        for (const doc of snapshot.docs) {
            batch.set(
                doc.ref,
                { _deletedAt: FieldValue.serverTimestamp(), ...touch() },
                { merge: true }
            );
        }
        await batch.commit();

        return { success: true, deleted: snapshot.size };
    }

    throw fail('UNSUPPORTED_NOTIFICATION_ACTION', 400);
});

// ---------------------------------------------------------------------------
// Device tokens
// ---------------------------------------------------------------------------

/**
 * Registers or refreshes a device token.
 *
 * The document id is `sha256(token)`, which makes uniqueness STRUCTURAL. The Appwrite
 * implementation dedupes with a read-then-write against a non-unique index — a race
 * that can leave two active rows for one device and double-deliver every push. Fixing
 * it here is invisible to the caller: the returned shape is unchanged.
 *
 * `token_kind` distinguishes Expo tokens from raw FCM tokens, because the two
 * providers issue different formats and both exist during any rollout. The push
 * dispatcher above sends only to `fcm` tokens.
 */
const registerDeviceToken = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    // §16 — a misbehaving client re-registering in a loop should not spam this table.
    await assertRateLimit(uid, 'registerDeviceToken', { max: 20, windowMs: 60 * 60 * 1000 });

    const token = String((request.data && request.data.token) || '').trim();
    const platform = String((request.data && request.data.platform) || '').trim();
    const deviceId = String((request.data && request.data.deviceId) || '').trim() || null;

    if (!token) throw fail('MISSING_DEVICE_TOKEN', 400);

    const tokenKind = token.startsWith('ExponentPushToken') || token.startsWith('ExpoPushToken')
        ? 'expo'
        : 'fcm';

    const now = new Date().toISOString();
    const ref = db.collection('users').doc(uid).collection('device_tokens').doc(sha256(token));
    const existing = await ref.get();

    const payload = {
        user_id: uid,
        token,
        token_kind: tokenKind,
        platform,
        device_id: deviceId,
        is_active: true,
        updated_at: now,
        last_seen_at: now,
        ...(existing.exists ? touch() : { created_at: now, ...stamps() }),
    };

    await ref.set(payload, { merge: true });

    return {
        success: true,
        deviceToken: { $id: ref.id, ...payload, created_at: payload.created_at || now },
    };
});

module.exports = { onNotificationCreated, notificationActions, registerDeviceToken };
