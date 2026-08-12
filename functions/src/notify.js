/**
 * Notification writer.
 *
 * C-NT-1: the inbox and push are SEPARATE responsibilities, and push is DOWNSTREAM of
 * the inbox, never a peer of it. A producer (a friend or split callable) writes a
 * notification document and stops there; the `onNotificationCreated` Firestore
 * trigger reacts to the create and dispatches FCM.
 *
 * That split is worth preserving deliberately rather than by accident: it means the
 * in-app inbox is never missing an entry because push failed, and a push retry can
 * never invent an inbox row that does not exist. The Appwrite design has the same
 * shape (`send_notification` bound to `notifications.documents.*.create`).
 *
 * This module is separate from notifications.js purely to keep the friend and split
 * modules free of a circular import.
 */

const { db, stamps, deterministicId } = require('./common');

/**
 * @param {object}       params
 * @param {string}       params.userId          recipient
 * @param {string}       params.type            domain notification type
 * @param {string}       params.title
 * @param {string}       params.body
 * @param {string[]}     [params.participantIds] co-owners, for the rules predicate
 * @param {string}       [params.dedupeKey]     makes the write idempotent — see below
 */
const buildNotification = ({
    userId,
    type,
    title,
    body,
    relatedCollection = null,
    relatedDocumentId = null,
    splitExpenseId = null,
    splitMemberId = null,
    participantIds = null,
    dedupeKey = null,
}) => {
    const data = {
        user_id: userId,
        type,
        title,
        body,
        related_collection: relatedCollection,
        related_document_id: relatedDocumentId,
        is_read: false,
        created_at: new Date().toISOString(),
        read_at: null,
        participantIds: participantIds || [userId],
        ...stamps(),
    };

    if (splitExpenseId) data.splitExpenseId = splitExpenseId;
    if (splitMemberId) data.splitMemberId = splitMemberId;

    // A deterministic id makes the notification write idempotent. Without it, a
    // callable that is retried after a transient failure produces a DUPLICATE inbox
    // entry and a duplicate push — the exact failure brief §48 forbids.
    const id = dedupeKey ? deterministicId('notification', userId, dedupeKey) : null;

    return { id, data };
};

/** Queues a notification inside an existing Firestore transaction or batch. */
const addNotificationToBatch = (batch, params) => {
    const { id, data } = buildNotification(params);
    const ref = id
        ? db.collection('notifications').doc(id)
        : db.collection('notifications').doc();

    // `set` rather than `create`: a replayed notification should be a no-op, not an
    // error that fails the whole enclosing transaction. Idempotency here is about
    // suppressing duplicates, not about mutual exclusion — unlike `split_operations`,
    // where `create()` is load-bearing.
    batch.set(ref, data, { merge: true });
    return ref;
};

/** Fire-and-forget write, for paths with no surrounding transaction. */
const writeNotification = async (params) => {
    const { id, data } = buildNotification(params);
    const ref = id
        ? db.collection('notifications').doc(id)
        : db.collection('notifications').doc();
    await ref.set(data, { merge: true });
    return ref;
};

module.exports = { buildNotification, addNotificationToBatch, writeNotification };
