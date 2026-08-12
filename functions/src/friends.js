/**
 * Friendship callables.
 *
 * ── THE STATE MACHINE IS FROZEN (docs/phase-1/01 §4.6) ──────────────────────────
 *
 *     none ──send──> pending ──accept──> accepted ──remove──> none
 *                       │
 *                       └───reject────> rejected      (terminal for that request)
 *
 * `accepted` also creates the TWO `friends` rows — one per direction — atomically
 * with the request transition.
 *
 * C-FR-2: there is deliberately NO cancel path. `cancelFriendRequest` is named in the
 * brief but has no Appwrite function and no client method; it is a GAP in the current
 * system, not a behaviour to reproduce. Adding a state the Appwrite provider cannot
 * reach would make the two backends observably different, which is exactly what a
 * fork must not do.
 *
 * Every domain code below is verbatim from the Appwrite functions. The UI maps these
 * strings to copy, so a rename silently changes what a user reads.
 */

const { onCall } = require('firebase-functions/v2/https');

const {
    db,
    FieldValue,
    fail,
    requireAuth,
    requirePro,
    pairKeyFor,
    deterministicId,
    stamps,
    touch,
    assertRateLimit,
} = require('./common');
const { addNotificationToBatch } = require('./notify');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

const profileSummary = (uid, profile) => ({
    userId: uid,
    name: (profile && profile.name) || '',
    email: (profile && profile.email) || '',
    avatarId: (profile && profile.avatarId) || null,
});

const loadProfile = async (uid) => {
    const snapshot = await db.collection('public_profiles').doc(uid).get();
    return snapshot.exists ? snapshot.data() : null;
};

// ---------------------------------------------------------------------------
// sendFriendRequest
// ---------------------------------------------------------------------------

const sendFriendRequest = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    // §16 — a script hammering this creates a request row + notification per call.
    await assertRateLimit(uid, 'sendFriendRequest', { max: 20, windowMs: 60 * 60 * 1000 });
    await requirePro(uid);

    const recipientUserId = String((request.data && request.data.recipientUserId) || '').trim();
    const message = String((request.data && request.data.message) || '').slice(0, 500);

    if (!recipientUserId) throw fail('RECIPIENT_NOT_FOUND', 404);
    if (recipientUserId === uid) throw fail('SELF_FRIEND_REQUEST', 400);

    const recipientProfile = await loadProfile(recipientUserId);
    if (!recipientProfile) throw fail('RECIPIENT_NOT_FOUND', 404);

    const requesterProfile = await loadProfile(uid);
    const pairKey = pairKeyFor(uid, recipientUserId);

    // §18 IDEMPOTENCY. The document id is derived from the pair key, so a repeated
    // send is a repeated write to the SAME document rather than a second request.
    //
    // The id alone is not sufficient though: a pair that has previously REJECTED must
    // be able to request again, and a deterministic id would collide with the old
    // rejected document. So the transaction below distinguishes the states —
    // `pending` returns the existing request unchanged, anything terminal is
    // overwritten with a fresh one.
    const requestId = deterministicId('friend_request', pairKey);
    const requestRef = db.collection('friend_requests').doc(requestId);
    const friendshipId = deterministicId('friend', uid, recipientUserId);

    return db.runTransaction(async (tx) => {
        // READ EVERYTHING FIRST. Firestore forbids reads after writes inside a
        // transaction, and violating it fails the whole operation at commit time.
        const [existingRequest, existingFriendship] = await Promise.all([
            tx.get(requestRef),
            tx.get(db.collection('friends').doc(friendshipId)),
        ]);

        if (existingFriendship.exists && existingFriendship.data().status === 'accepted') {
            throw fail('ALREADY_FRIENDS', 409);
        }

        if (existingRequest.exists && existingRequest.data().status === 'pending') {
            // Idempotent: the same logical request, not a duplicate.
            if (existingRequest.data().requester_user_id === uid) {
                return { success: true, requestId };
            }
            // The other party already asked us. Surfacing "already pending" keeps the
            // state machine single-edged — the UI resolves it by accepting theirs.
            throw fail('FRIEND_REQUEST_ALREADY_PENDING', 409);
        }

        const now = new Date().toISOString();

        tx.set(requestRef, {
            requester_user_id: uid,
            recipient_user_id: recipientUserId,
            pair_key: pairKey,
            status: 'pending',
            message,
            created_at: now,
            updated_at: now,
            responded_at: null,
            // Firestore has no per-document ACLs; this is what the read rule checks.
            participantIds: [uid, recipientUserId],
            user_id: uid,
            ...stamps(),
        });

        addNotificationToBatch(tx, {
            userId: recipientUserId,
            type: 'friend_request',
            title: 'New friend request',
            body: `${profileSummary(uid, requesterProfile).name || 'Someone'} sent you a friend request.`,
            relatedCollection: 'friend_requests',
            relatedDocumentId: requestId,
            participantIds: [uid, recipientUserId],
            dedupeKey: `friend_request:${requestId}:${now}`,
        });

        return { success: true, requestId };
    });
});

// ---------------------------------------------------------------------------
// respondFriendRequest
// ---------------------------------------------------------------------------

const respondFriendRequest = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    await requirePro(uid);

    const requestId = String((request.data && request.data.requestId) || '').trim();
    const response = request.data && request.data.response;

    if (!requestId) throw fail('FRIEND_REQUEST_NOT_FOUND', 404);
    if (response !== 'accept' && response !== 'reject') throw fail('INVALID_RESPONSE', 400);

    const requestRef = db.collection('friend_requests').doc(requestId);

    // ONE transaction for the transition AND both friendship rows. If it were two
    // writes, a failure between them would leave a request marked accepted with only
    // one side of the friendship — the user would see a friend who does not see them.
    const result = await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(requestRef);
        if (!snapshot.exists) throw fail('FRIEND_REQUEST_NOT_FOUND', 404);

        const data = snapshot.data();
        if (data.recipient_user_id !== uid) throw fail('ONLY_RECEIVER_CAN_RESPOND', 403);
        if (data.status !== 'pending') throw fail('FRIEND_REQUEST_NOT_PENDING', 409);

        const requesterId = data.requester_user_id;
        const now = new Date().toISOString();

        tx.update(requestRef, {
            status: response === 'accept' ? 'accepted' : 'rejected',
            responded_at: now,
            updated_at: now,
            ...touch(),
        });

        if (response === 'reject') {
            return { success: true, status: 'rejected', requesterId };
        }

        // Two rows, one per direction — matching the Appwrite `friends` schema, where
        // each row is read from its owner's point of view (`friend_user_id` is "the
        // other person"). Deterministic ids make acceptance replay-safe.
        const pairKey = data.pair_key || pairKeyFor(requesterId, uid);

        for (const [owner, other] of [[requesterId, uid], [uid, requesterId]]) {
            tx.set(
                db.collection('friends').doc(deterministicId('friend', owner, other)),
                {
                    user_id: owner,
                    friend_user_id: other,
                    pair_key: pairKey,
                    status: 'accepted',
                    friend_name: '',
                    friend_email: '',
                    friend_avatar_id: null,
                    created_at: now,
                    updated_at: now,
                    last_activity_at: now,
                    participantIds: [requesterId, uid],
                    ...stamps(),
                }
            );
        }

        return { success: true, status: 'accepted', requesterId, pairKey };
    });

    // Denormalised profile fan-out happens OUTSIDE the transaction: it is display
    // data, and failing it must not roll back the friendship itself.
    if (result.status === 'accepted') {
        await denormaliseFriendProfiles(result.requesterId, uid).catch(() => undefined);

        await addNotificationOutsideTransaction({
            userId: result.requesterId,
            type: 'friend_request_accepted',
            title: 'Friend request accepted',
            body: 'Your friend request was accepted.',
            relatedCollection: 'friends',
            relatedDocumentId: deterministicId('friend', result.requesterId, uid),
            participantIds: [result.requesterId, uid],
            dedupeKey: `friend_accepted:${requestId}`,
        });
    }

    return { success: true };
});

const addNotificationOutsideTransaction = async (params) => {
    const { writeNotification } = require('./notify');
    await writeNotification(params);
};

/** Copies name/email/avatar onto both `friends` rows so the list renders in one read. */
const denormaliseFriendProfiles = async (a, b) => {
    const [profileA, profileB] = await Promise.all([loadProfile(a), loadProfile(b)]);
    const batch = db.batch();

    batch.set(
        db.collection('friends').doc(deterministicId('friend', a, b)),
        {
            friend_name: (profileB && profileB.name) || '',
            friend_email: (profileB && profileB.email) || '',
            friend_avatar_id: (profileB && profileB.avatarId) || null,
            ...touch(),
        },
        { merge: true }
    );

    batch.set(
        db.collection('friends').doc(deterministicId('friend', b, a)),
        {
            friend_name: (profileA && profileA.name) || '',
            friend_email: (profileA && profileA.email) || '',
            friend_avatar_id: (profileA && profileA.avatarId) || null,
            ...touch(),
        },
        { merge: true }
    );

    await batch.commit();
};

// ---------------------------------------------------------------------------
// listFriends / listFriendRequests
// ---------------------------------------------------------------------------

const listFriends = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);

    const snapshot = await db
        .collection('friends')
        .where('user_id', '==', uid)
        .where('status', '==', 'accepted')
        .where('_deletedAt', '==', null)
        .get();

    const friends = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            friendshipId: doc.id,
            pairKey: data.pair_key,
            status: data.status,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            lastActivityAt: data.last_activity_at || null,
            friend: {
                userId: data.friend_user_id,
                name: data.friend_name || '',
                email: data.friend_email || '',
                avatarId: data.friend_avatar_id || null,
            },
        };
    });

    return { success: true, friends };
});

const listFriendRequests = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);

    const snapshot = await db
        .collection('friend_requests')
        .where('participantIds', 'array-contains', uid)
        .where('status', '==', 'pending')
        .where('_deletedAt', '==', null)
        .get();

    const counterpartyIds = new Set();
    for (const doc of snapshot.docs) {
        const data = doc.data();
        counterpartyIds.add(data.requester_user_id);
        counterpartyIds.add(data.recipient_user_id);
    }

    const profiles = new Map();
    await Promise.all(
        Array.from(counterpartyIds).map(async (id) => profiles.set(id, await loadProfile(id)))
    );

    const incoming = [];
    const outgoing = [];

    for (const doc of snapshot.docs) {
        const data = doc.data();
        const item = {
            requestId: doc.id,
            pairKey: data.pair_key,
            status: data.status,
            message: data.message || '',
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            respondedAt: data.responded_at || null,
            requester: profileSummary(data.requester_user_id, profiles.get(data.requester_user_id)),
            recipient: profileSummary(data.recipient_user_id, profiles.get(data.recipient_user_id)),
        };

        if (data.recipient_user_id === uid) incoming.push(item);
        else outgoing.push(item);
    }

    return { success: true, incoming, outgoing };
});

// ---------------------------------------------------------------------------
// removeFriend
// ---------------------------------------------------------------------------

const removeFriend = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    const friendshipId = String((request.data && request.data.friendshipId) || '').trim();
    if (!friendshipId) throw fail('FRIENDSHIP_NOT_FOUND', 404);

    const ref = db.collection('friends').doc(friendshipId);

    await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw fail('FRIENDSHIP_NOT_FOUND', 404);

        const data = snapshot.data();
        if (!Array.isArray(data.participantIds) || !data.participantIds.includes(uid)) {
            throw fail('NOT_FRIENDSHIP_MEMBER', 403);
        }
        if (data.status !== 'accepted') throw fail('FRIENDSHIP_NOT_ACTIVE', 409);

        const other = data.user_id === uid ? data.friend_user_id : data.user_id;
        const reverseRef = db.collection('friends').doc(deterministicId('friend', other, uid));

        // Tombstone BOTH directions. Removing only the caller's row would leave the
        // other user still seeing a friend who no longer sees them.
        for (const target of [ref, reverseRef]) {
            tx.set(
                target,
                { _deletedAt: FieldValue.serverTimestamp(), ...touch() },
                { merge: true }
            );
        }

        // The friend_request document is tombstoned too, so the pair can request
        // again from a clean state rather than hitting FRIEND_REQUEST_NOT_PENDING.
        const requestRef = db
            .collection('friend_requests')
            .doc(deterministicId('friend_request', data.pair_key));
        tx.set(
            requestRef,
            { status: 'removed', _deletedAt: FieldValue.serverTimestamp(), ...touch() },
            { merge: true }
        );
    });

    return { success: true };
});

// ---------------------------------------------------------------------------
// refreshFriendAvatar
// ---------------------------------------------------------------------------

const refreshFriendAvatar = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    const avatarId = (request.data && request.data.avatarId) || null;

    await db.collection('public_profiles').doc(uid).set({ avatarId, ...touch() }, { merge: true });
    await db.collection('users').doc(uid).set({ avatarId, ...touch() }, { merge: true });

    // Fan out to every friend's denormalised copy.
    const snapshot = await db
        .collection('friends')
        .where('friend_user_id', '==', uid)
        .where('_deletedAt', '==', null)
        .get();

    const batch = db.batch();
    for (const doc of snapshot.docs) {
        batch.set(doc.ref, { friend_avatar_id: avatarId, ...touch() }, { merge: true });
    }
    await batch.commit();

    return { success: true, updated: snapshot.size };
});

module.exports = {
    sendFriendRequest,
    respondFriendRequest,
    listFriends,
    listFriendRequests,
    removeFriend,
    refreshFriendAvatar,
};
