/**
 * Split expense callables — the money path.
 *
 * ── WHAT IS FROZEN AND WHAT IS ALLOWED TO CHANGE ────────────────────────────────
 *
 * FROZEN (observable, and therefore identical under both providers):
 *   C-SP-1  the arithmetic — see splitMath.js, a verbatim transcription
 *   C-SP-2  participant cap: 100 server-side / 99 client-side
 *   C-SP-3  idempotency: `request_id` at the API boundary + the `split_operations` mutex
 *   C-SP-4  the mutex uses create(), never set()
 *   C-SP-6  balance decrements have a floor, enforced by a transactional read-check
 *   every domain error code, verbatim
 *
 * ALLOWED TO CHANGE (unobservable):
 *   The Appwrite implementation carries a saga apparatus — a mutex ledger, a rollback
 *   stack and `needs_recovery` states — spread across ~2,800 lines. That machinery
 *   exists because Appwrite has no multi-document transaction: it has to simulate one
 *   and clean up after partial failure.
 *
 *   Firestore HAS multi-document transactions. A failed transaction commits nothing,
 *   so there is no partial state to recover from and the entire apparatus becomes
 *   dead weight. Dropping it is permitted precisely because it is invisible: the
 *   numbers, the idempotency guarantees and the error codes are what callers see, and
 *   those are unchanged.
 *
 * ── THE TRANSACTION RULE THAT BITES ─────────────────────────────────────────────
 * Firestore forbids READS AFTER WRITES inside a transaction. Every handler below is
 * therefore strictly: read everything -> compute -> write everything. Interleaving
 * them fails at commit, not at the offending line, so the ordering is deliberate and
 * must be preserved when editing.
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
    withOperationMutex,
    withLogging,
    stamps,
    touch,
    toCents,
    fromCents,
    applyBalanceDelta,
    assertRateLimit,
} = require('./common');
const { calculateShares, assertValidShares } = require('./splitMath');
const { addNotificationToBatch, writeNotification } = require('./notify');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/** C-SP-2 — server-side cap. The client caps at 99; this is the authoritative check. */
const MAX_PARTICIPANTS = 100;

const REQUEST_ID_MAX_LENGTH = 128;

const SPLIT_MODES = ['equal', 'exact', 'percent'];
const PAYMENT_MODES = ['own_share', 'full'];

/** Re-raises a splitMath error as an HttpsError while keeping the domain code. */
const rethrowDomain = (error) => {
    if (error && error.domainCode) throw fail(error.domainCode, error.status || 400);
    throw error;
};

const walletRef = (uid, walletId) =>
    db.collection('users').doc(uid).collection('wallets').doc(walletId);

/**
 * Mirrors `friends.js`'s `profileSummary`/`loadProfile` — the frontend's
 * `AppUserSummary` shape ({userId, name, email, avatarId}), same as
 * `create_split_expense`/`respond_split_request`'s `toPublicUser` on the
 * Appwrite side (backend/functions/respond_split_request/src/main.js:1303-1307).
 * `getSplitDetail` and `listSplitRequests` below MUST attach this to every
 * member and to `creator`/`counterparty` — the detail screen reads
 * `data.creator.name` and `member.user.name` with no optional chaining, so a
 * response missing either is a hard crash, not a degraded render.
 */
const loadProfile = async (uid) => {
    const snapshot = await db.collection('public_profiles').doc(uid).get();
    return snapshot.exists ? snapshot.data() : null;
};

const profileSummary = (uid, profile) => ({
    userId: uid,
    name: (profile && profile.name) || '',
    email: (profile && profile.email) || '',
    avatarId: (profile && profile.avatarId) || null,
});

/** Loads every profile in `uids` once each, returned as a Map keyed by uid. */
const loadProfiles = async (uids) => {
    const unique = Array.from(new Set(uids.filter(Boolean)));
    const profiles = await Promise.all(unique.map((uid) => loadProfile(uid)));
    return new Map(unique.map((uid, i) => [uid, profiles[i]]));
};

// ---------------------------------------------------------------------------
// createSplitExpense
// ---------------------------------------------------------------------------

const createSplitExpenseHandler = async (request) => {
    const uid = requireAuth(request);
    // §16 — the money path. Cheapest guard first, before any read.
    await assertRateLimit(uid, 'createSplitExpense', { max: 30, windowMs: 60 * 60 * 1000 });
    await requirePro(uid);

    const input = request.data || {};

    const requestId = String(input.requestId || '').trim();
    if (!requestId) throw fail('REQUEST_ID_REQUIRED', 400);
    if (requestId.length > REQUEST_ID_MAX_LENGTH) throw fail('REQUEST_ID_TOO_LONG', 400);

    const friends = Array.isArray(input.friends) ? input.friends : [];
    if (friends.length === 0) throw fail('SELECT_AT_LEAST_ONE_FRIEND', 400);
    if (friends.length + 1 > MAX_PARTICIPANTS) throw fail('SPLIT_PARTICIPANT_LIMIT_EXCEEDED', 400);

    const splitMode = String(input.splitMode || 'equal');
    const paymentMode = String(input.paymentMode || 'own_share');
    if (!SPLIT_MODES.includes(splitMode)) throw fail('INVALID_SPLIT_MODE', 400);
    if (!PAYMENT_MODES.includes(paymentMode)) throw fail('INVALID_PAYMENT_MODE', 400);

    // The client (splitsAdapter.ts) sends `amount` / `walletId` — the SAME field
    // names the frozen Appwrite contract uses (create_split_expense/src/main.js:2137,
    // 2140: `body.amount`, `body.walletId`). `totalAmount` / `payerWalletId` were
    // never sent by any client, so this always threw INVALID_AMOUNT regardless of
    // what the user entered. Falling back to the old names too, just in case
    // anything else already depends on them.
    const totalCents = toCents(input.amount ?? input.totalAmount);
    if (!Number.isFinite(totalCents) || totalCents <= 0) throw fail('INVALID_AMOUNT', 400);

    const payerWalletId = String(input.walletId || input.payerWalletId || '').trim();
    if (!payerWalletId) throw fail('MISSING_WALLET', 400);

    // ── Idempotency layer 1: request_id ────────────────────────────────────────
    // Checked BEFORE the mutex, because a completed create must replay cheaply
    // without contending for a lock.
    const existing = await db
        .collection('split_expenses')
        .where('request_id', '==', requestId)
        .where('created_by_user_id', '==', uid)
        .limit(1)
        .get();

    if (!existing.empty) {
        return { success: true, splitExpense: { $id: existing.docs[0].id, ...existing.docs[0].data() } };
    }

    // ── Idempotency layer 2: the server-side mutex (create(), never set()) ─────
    const operationId = deterministicId('split_create', uid, requestId);

    return withOperationMutex(operationId, 'SPLIT_CREATE_IN_PROGRESS', async () => {
        // Mutual-friendship check happens outside the transaction: it is a read-only
        // authorization gate over documents the transaction does not mutate.
        const friendUids = friends.map((friend) => String(friend.userId || '').trim());
        if (friendUids.some((id) => !id) || new Set(friendUids).size !== friendUids.length) {
            throw fail('INVALID_FRIEND_SELECTION', 400);
        }
        if (friendUids.includes(uid)) throw fail('INVALID_FRIEND', 400);

        await assertMutualFriends(uid, friendUids);

        let shares;
        try {
            shares = calculateShares({ totalCents, splitMode, friends });
            assertValidShares({ ...shares, totalCents, paymentMode });
        } catch (error) {
            rethrowDomain(error);
        }

        const { creatorShareCents, friendShares } = shares;

        // What the creator actually pays out of their wallet now.
        const paidCents = paymentMode === 'full' ? totalCents : creatorShareCents;

        const splitExpenseRef = db.collection('split_expenses').doc();
        const transactionRef = db
            .collection('users')
            .doc(uid)
            .collection('transactions')
            .doc(deterministicId('split_txn', splitExpenseRef.id, uid).slice(0, 20));

        const participantIds = [uid, ...friendUids];
        const now = new Date().toISOString();

        await db.runTransaction(async (tx) => {
            // ---- READ PHASE (nothing may be written before this completes) ----
            const wallet = await tx.get(walletRef(uid, payerWalletId));
            if (!wallet.exists) throw fail('MISSING_WALLET', 404);

            const currentBalance = Number(wallet.data().current_balance || 0);
            const paidAmount = fromCents(paidCents);

            // C-SP-6 — the floor. A bare FieldValue.increment(-x) CANNOT express this:
            // it has no read, so it cannot refuse. That is exactly why unbounded
            // increment is banned for balances.
            if (currentBalance < paidAmount) throw fail('INSUFFICIENT_BALANCE', 400);

            // ---- WRITE PHASE ----
            tx.set(splitExpenseRef, {
                request_id: requestId,
                created_by_user_id: uid,
                paid_by_user_id: uid,
                payer_wallet_id: payerWalletId,
                source_transaction_id: transactionRef.id,
                title: String(input.title || '').slice(0, 200),
                total_amount: fromCents(totalCents),
                currency: String(input.currency || 'USD'),
                split_mode: splitMode,
                payment_mode: paymentMode,
                status: 'active',
                create_status: 'complete',
                category_id: input.categoryId || null,
                date: input.date || now,
                note: String(input.note || '').slice(0, 1000),
                created_at: now,
                updated_at: now,
                settled_at: null,
                participantIds,
                user_id: uid,
                ...stamps(),
            });

            // The creator's own member row. Always settled — they have already paid.
            tx.set(splitMemberRef(splitExpenseRef.id, uid), {
                split_expense_id: splitExpenseRef.id,
                member_user_id: uid,
                friend_id: null,
                share_amount: fromCents(creatorShareCents),
                share_percent: Number(((creatorShareCents / totalCents) * 100).toFixed(4)),
                paid_amount: paidAmount,
                owed_amount: 0,
                settlement_status: 'settled',
                settlement_wallet_id: payerWalletId,
                settlement_transaction_id: transactionRef.id,
                member_settlement_transaction_id: null,
                created_at: now,
                updated_at: now,
                settled_at: now,
                participantIds,
                user_id: uid,
                ...stamps(),
            });

            for (const friend of friendShares) {
                tx.set(splitMemberRef(splitExpenseRef.id, friend.userId), {
                    split_expense_id: splitExpenseRef.id,
                    member_user_id: friend.userId,
                    friend_id: friend.friendshipId || null,
                    share_amount: fromCents(friend.shareCents),
                    share_percent: friend.sharePercent,
                    paid_amount: 0,
                    // Owed only if the creator actually fronted the money.
                    owed_amount: paymentMode === 'full' ? fromCents(friend.shareCents) : 0,
                    settlement_status: 'pending',
                    settlement_wallet_id: null,
                    settlement_transaction_id: null,
                    member_settlement_transaction_id: null,
                    created_at: now,
                    updated_at: now,
                    settled_at: null,
                    participantIds,
                    user_id: friend.userId,
                    ...stamps(),
                });

                addNotificationToBatch(tx, {
                    userId: friend.userId,
                    type: 'split_request',
                    title: 'New split request',
                    body: `You have a share of ${fromCents(friend.shareCents)} to review.`,
                    relatedCollection: 'split_expenses',
                    relatedDocumentId: splitExpenseRef.id,
                    splitExpenseId: splitExpenseRef.id,
                    splitMemberId: splitMemberRef(splitExpenseRef.id, friend.userId).id,
                    participantIds,
                    // §48 — a retried trigger must not produce a second inbox row.
                    dedupeKey: `split_request:${splitExpenseRef.id}:${friend.userId}`,
                });
            }

            tx.set(transactionRef, {
                amount: paidAmount,
                type: 'expense',
                wallet_id: payerWalletId,
                category_id: input.categoryId || null,
                date: input.date || now,
                note: String(input.title || 'Split expense').slice(0, 200),
                source: 'split',
                splitExpenseId: splitExpenseRef.id,
                user_id: uid,
                ...stamps(),
            });

            tx.update(walletRef(uid, payerWalletId), {
                current_balance: applyBalanceDelta(currentBalance, -paidAmount),
                ...touch(),
            });
        });

        const created = await splitExpenseRef.get();
        return { success: true, splitExpense: { $id: created.id, ...created.data() } };
    });
};

// §43: one structured record per invocation — operation, uid, outcome,
// duration and error category. Sensitive keys are scrubbed in withLogging.
const createSplitExpense = onCall({ region: REGION, timeoutSeconds: 120, maxInstances: 10 }, (request) =>
    withLogging(
        'createSplitExpense',
        request.auth && request.auth.uid,
        { requestId: String((request.data || {}).requestId || '') },
        () => createSplitExpenseHandler(request)
    ));

const splitMemberRef = (splitExpenseId, memberUid) =>
    db.collection('split_members').doc(deterministicId('split_member', splitExpenseId, memberUid));

/**
 * Every participant must be a MUTUAL friend of the creator.
 *
 * Preserves ONLY_MUTUAL_FRIENDS_ALLOWED. It is an authorization check, not a
 * courtesy: without it any user could attach any other user to a financial
 * obligation.
 */
const assertMutualFriends = async (uid, friendUids) => {
    const chunks = [];
    for (let i = 0; i < friendUids.length; i += 30) chunks.push(friendUids.slice(i, i + 30));

    const found = new Set();

    for (const chunk of chunks) {
        const snapshot = await db
            .collection('friends')
            .where('user_id', '==', uid)
            .where('friend_user_id', 'in', chunk)
            .where('status', '==', 'accepted')
            .where('_deletedAt', '==', null)
            .get();

        for (const doc of snapshot.docs) found.add(doc.data().friend_user_id);
    }

    for (const friendUid of friendUids) {
        if (!found.has(friendUid)) throw fail('ONLY_MUTUAL_FRIENDS_ALLOWED', 403);
    }

    // Reverse direction — a one-sided `friends` row must not count as mutual.
    for (const chunk of chunks) {
        const snapshot = await db
            .collection('friends')
            .where('friend_user_id', '==', uid)
            .where('user_id', 'in', chunk)
            .where('status', '==', 'accepted')
            .where('_deletedAt', '==', null)
            .get();

        const reverse = new Set(snapshot.docs.map((doc) => doc.data().user_id));
        for (const friendUid of chunk) {
            if (!reverse.has(friendUid)) throw fail('ONLY_MUTUAL_FRIENDS_ALLOWED', 403);
        }
    }

    void pairKeyFor;
};

// ---------------------------------------------------------------------------
// respondSplitRequest — respond | get_detail | list_requests
// ---------------------------------------------------------------------------

const respondSplitRequestHandler = async (request) => {
    const uid = requireAuth(request);
    const action = (request.data && request.data.action) || 'respond';

    if (action === 'get_detail') return getSplitDetail(uid, request.data);
    if (action === 'list_requests') return listSplitRequests(uid, request.data);
    if (action !== 'respond') throw fail('SPLIT_ACTION_FAILED', 400);

    // §16 — only the mutating action. Reads above are not throttled the same way.
    await assertRateLimit(uid, 'respondSplitRequest', { max: 60, windowMs: 60 * 60 * 1000 });

    await requirePro(uid);

    const splitMemberId = String((request.data && request.data.splitMemberId) || '').trim();
    const response = request.data && request.data.response;

    if (!splitMemberId) throw fail('MISSING_SPLIT_MEMBER', 400);
    if (response !== 'accept' && response !== 'reject') throw fail('INVALID_RESPONSE', 400);

    const operationId = deterministicId('split_respond', uid, splitMemberId, response);

    return withOperationMutex(operationId, 'SPLIT_CREATE_ALREADY_IN_PROGRESS', async () => {
        const memberRef = db.collection('split_members').doc(splitMemberId);

        const outcome = await db.runTransaction(async (tx) => {
            // ---- READ PHASE ----
            const member = await tx.get(memberRef);
            if (!member.exists) throw fail('INVALID_SETTLEMENT_MEMBER', 404);

            const memberData = member.data();
            if (memberData.member_user_id !== uid) throw fail('MEMBER_OWNERSHIP_MISMATCH', 403);

            // The state machine has no re-entry: a member who has already answered
            // cannot answer again. Without this an "accept" could follow a "reject"
            // and re-create an obligation the user already declined.
            if (memberData.settlement_status !== 'pending') {
                throw fail('SPLIT_ALREADY_SETTLED', 409);
            }

            const splitRef = db.collection('split_expenses').doc(memberData.split_expense_id);
            const split = await tx.get(splitRef);
            if (!split.exists) throw fail('MISSING_SPLIT', 404);

            const now = new Date().toISOString();

            // ---- WRITE PHASE ----
            tx.update(memberRef, {
                settlement_status: response === 'accept' ? 'accepted' : 'rejected',
                updated_at: now,
                ...touch(),
            });

            addNotificationToBatch(tx, {
                userId: split.data().created_by_user_id,
                type: response === 'accept' ? 'split_accepted' : 'split_rejected',
                title: response === 'accept' ? 'Split accepted' : 'Split declined',
                body:
                    response === 'accept'
                        ? 'A participant accepted their share.'
                        : 'A participant declined their share.',
                relatedCollection: 'split_expenses',
                relatedDocumentId: splitRef.id,
                splitExpenseId: splitRef.id,
                splitMemberId,
                participantIds: split.data().participantIds || [uid],
                dedupeKey: `split_response:${splitMemberId}:${response}`,
            });

            return { splitExpenseId: splitRef.id };
        });

        const [split, members] = await Promise.all([
            db.collection('split_expenses').doc(outcome.splitExpenseId).get(),
            db.collection('split_members').where('split_expense_id', '==', outcome.splitExpenseId).get(),
        ]);

        return {
            success: true,
            splitExpense: { $id: split.id, ...split.data() },
            splitMembers: members.docs.map((doc) => ({ $id: doc.id, ...doc.data() })),
        };
    });
};

// §43: one structured record per invocation — operation, uid, outcome,
// duration and error category. Sensitive keys are scrubbed in withLogging.
const respondSplitRequest = onCall({ region: REGION, timeoutSeconds: 120, maxInstances: 10 }, (request) =>
    withLogging(
        'respondSplitRequest',
        request.auth && request.auth.uid,
        { action: (request.data && request.data.action) || 'respond', splitMemberId: String((request.data || {}).splitMemberId || '') },
        () => respondSplitRequestHandler(request)
    ));

// ---------------------------------------------------------------------------
// settleSplitPayment
// ---------------------------------------------------------------------------

const settleSplitPaymentHandler = async (request) => {
    const uid = requireAuth(request);
    // §16 — settlement moves money between wallets; cap alongside creation.
    await assertRateLimit(uid, 'settleSplitPayment', { max: 30, windowMs: 60 * 60 * 1000 });
    await requirePro(uid);

    const splitMemberId = String((request.data && request.data.splitMemberId) || '').trim();
    const receivingWalletId = String((request.data && request.data.receivingWalletId) || '').trim();
    const amount = Number(request.data && request.data.amount);

    if (!splitMemberId) throw fail('MISSING_SPLIT_MEMBER', 400);
    if (!receivingWalletId) throw fail('MISSING_RECEIVING_WALLET', 400);
    if (!Number.isFinite(amount) || amount <= 0) throw fail('INVALID_SETTLEMENT_AMOUNT', 400);

    // The mutex key includes the amount, so a retry of the SAME settlement replays,
    // while a genuinely different amount is a different operation.
    const operationId = deterministicId('settle', uid, splitMemberId, toCents(amount));

    return withOperationMutex(operationId, 'SETTLEMENT_ALREADY_PROCESSING', async () => {
        const memberRef = db.collection('split_members').doc(splitMemberId);

        const outcome = await db.runTransaction(async (tx) => {
            // ---- READ PHASE ----
            const member = await tx.get(memberRef);
            if (!member.exists) throw fail('INVALID_SETTLEMENT_MEMBER', 404);

            const memberData = member.data();
            const splitRef = db.collection('split_expenses').doc(memberData.split_expense_id);
            const split = await tx.get(splitRef);
            if (!split.exists) throw fail('MISSING_SPLIT', 404);

            const splitData = split.data();

            // Only the creator collects — they are the one who fronted the money.
            if (splitData.created_by_user_id !== uid) {
                throw fail('ONLY_CREATOR_CAN_MARK_RECEIVED', 403);
            }
            if (memberData.settlement_status === 'settled') {
                throw fail('SPLIT_ALREADY_SETTLED', 409);
            }

            // The amount must match what is actually owed. Without this the creator
            // could credit themselves an arbitrary sum against a real member row.
            const owedCents = toCents(memberData.owed_amount || memberData.share_amount || 0);
            if (toCents(amount) !== owedCents) throw fail('SETTLEMENT_AMOUNT_MISMATCH', 400);

            const wallet = await tx.get(walletRef(uid, receivingWalletId));
            if (!wallet.exists) throw fail('RECEIVING_WALLET_NOT_FOUND', 404);

            const currentBalance = Number(wallet.data().current_balance || 0);
            const now = new Date().toISOString();

            const settlementTxnRef = db
                .collection('users')
                .doc(uid)
                .collection('transactions')
                .doc(deterministicId('settle_txn', splitMemberId, toCents(amount)).slice(0, 20));

            // ---- WRITE PHASE ----
            tx.set(settlementTxnRef, {
                amount,
                type: 'income',
                wallet_id: receivingWalletId,
                date: now,
                note: 'Split settlement received',
                source: 'split_settlement',
                splitExpenseId: splitRef.id,
                splitMemberId,
                user_id: uid,
                ...stamps(),
            });

            tx.update(walletRef(uid, receivingWalletId), {
                current_balance: applyBalanceDelta(currentBalance, amount),
                ...touch(),
            });

            tx.update(memberRef, {
                settlement_status: 'settled',
                settlement_wallet_id: receivingWalletId,
                settlement_transaction_id: settlementTxnRef.id,
                paid_amount: amount,
                owed_amount: 0,
                settled_at: now,
                updated_at: now,
                ...touch(),
            });

            addNotificationToBatch(tx, {
                userId: memberData.member_user_id,
                type: 'split_settled',
                title: 'Payment received',
                body: `Your share of ${amount} was marked as received.`,
                relatedCollection: 'split_expenses',
                relatedDocumentId: splitRef.id,
                splitExpenseId: splitRef.id,
                splitMemberId,
                participantIds: splitData.participantIds || [uid],
                dedupeKey: `split_settled:${splitMemberId}`,
            });

            return { splitExpenseId: splitRef.id };
        });

        await maybeCloseSplit(outcome.splitExpenseId);

        const [split, members] = await Promise.all([
            db.collection('split_expenses').doc(outcome.splitExpenseId).get(),
            db.collection('split_members').where('split_expense_id', '==', outcome.splitExpenseId).get(),
        ]);

        return {
            success: true,
            splitExpense: { $id: split.id, ...split.data() },
            splitMembers: members.docs.map((doc) => ({ $id: doc.id, ...doc.data() })),
        };
    });
};

// §43: one structured record per invocation — operation, uid, outcome,
// duration and error category. Sensitive keys are scrubbed in withLogging.
const settleSplitPayment = onCall({ region: REGION, timeoutSeconds: 120, maxInstances: 10 }, (request) =>
    withLogging(
        'settleSplitPayment',
        request.auth && request.auth.uid,
        { splitMemberId: String((request.data || {}).splitMemberId || ''), amount: Number((request.data || {}).amount) },
        () => settleSplitPaymentHandler(request)
    ));

/** Marks a split settled once no member is still outstanding. */
const maybeCloseSplit = async (splitExpenseId) => {
    const members = await db
        .collection('split_members')
        .where('split_expense_id', '==', splitExpenseId)
        .get();

    const outstanding = members.docs.some((doc) => {
        const status = doc.data().settlement_status;
        return status !== 'settled' && status !== 'rejected';
    });

    if (outstanding) return;

    const now = new Date().toISOString();
    await db.collection('split_expenses').doc(splitExpenseId).set(
        { status: 'settled', settled_at: now, updated_at: now, ...touch() },
        { merge: true }
    );
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const getSplitDetail = async (uid, data) => {
    const splitExpenseId = String((data && data.splitExpenseId) || '').trim();
    const splitMemberId = String((data && data.splitMemberId) || '').trim();

    if (!splitExpenseId && !splitMemberId) throw fail('MISSING_SPLIT', 400);

    let resolvedSplitId = splitExpenseId;

    if (!resolvedSplitId) {
        const member = await db.collection('split_members').doc(splitMemberId).get();
        if (!member.exists) throw fail('MISSING_SPLIT_MEMBER', 404);
        resolvedSplitId = member.data().split_expense_id;
    }

    const split = await db.collection('split_expenses').doc(resolvedSplitId).get();
    if (!split.exists) throw fail('MISSING_SPLIT', 404);

    const splitData = split.data();
    if (!Array.isArray(splitData.participantIds) || !splitData.participantIds.includes(uid)) {
        // 404 rather than 403 — a split you may not see must not be distinguishable
        // from one that does not exist.
        throw fail('MISSING_SPLIT', 404);
    }

    const membersSnapshot = await db
        .collection('split_members')
        .where('split_expense_id', '==', resolvedSplitId)
        .get();
    const memberDocs = membersSnapshot.docs.map((doc) => ({ $id: doc.id, ...doc.data() }));

    const profiles = await loadProfiles([
        splitData.created_by_user_id,
        ...memberDocs.map((member) => member.member_user_id),
    ]);

    const members = memberDocs.map((member) => ({
        ...member,
        user: profileSummary(member.member_user_id, profiles.get(member.member_user_id)),
    }));

    const creator = profileSummary(splitData.created_by_user_id, profiles.get(splitData.created_by_user_id));
    const currentUserMember = members.find((member) => member.member_user_id === uid) || null;

    return {
        success: true,
        splitExpense: { $id: split.id, ...splitData },
        members,
        currentUserMember,
        creator,
    };
};

const listSplitRequests = async (uid, data) => {
    const limit = Math.min(Number((data && data.limit) || 25), 100);

    const [asMember, asCreator] = await Promise.all([
        db.collection('split_members')
            .where('member_user_id', '==', uid)
            .where('_deletedAt', '==', null)
            .orderBy('_updatedAt', 'desc')
            .limit(limit)
            .get(),
        db.collection('split_expenses')
            .where('created_by_user_id', '==', uid)
            .where('_deletedAt', '==', null)
            .orderBy('_updatedAt', 'desc')
            .limit(limit)
            .get(),
    ]);

    const splitIds = new Set(asCreator.docs.map((doc) => doc.id));
    for (const doc of asMember.docs) splitIds.add(doc.data().split_expense_id);

    const splits = new Map(asCreator.docs.map((doc) => [doc.id, doc.data()]));
    const missing = Array.from(splitIds).filter((id) => !splits.has(id));

    if (missing.length > 0) {
        const refs = missing.map((id) => db.collection('split_expenses').doc(id));
        const snapshots = await db.getAll(...refs);
        for (const snapshot of snapshots) {
            if (snapshot.exists) splits.set(snapshot.id, snapshot.data());
        }
    }

    const memberDocsForProfiles = asMember.docs.map((doc) => doc.data());
    const profiles = await loadProfiles([
        ...Array.from(splits.values()).map((s) => s.created_by_user_id),
        ...memberDocsForProfiles.map((m) => m.member_user_id),
    ]);

    const sent = [];
    const received = [];

    for (const doc of asMember.docs) {
        const memberData = doc.data();
        const splitData = splits.get(memberData.split_expense_id);
        if (!splitData) continue;

        const direction = splitData.created_by_user_id === uid ? 'sent' : 'received';
        // Mirrors `mapSplitRequestItem` (respond_split_request/src/main.js:945-963):
        // counterparty is the FRIEND side of the row — the member when I'm the
        // creator looking outward ('sent'), the creator when I'm the member
        // looking back at whoever sent it ('received').
        const creator = profileSummary(splitData.created_by_user_id, profiles.get(splitData.created_by_user_id));
        const counterparty = direction === 'sent'
            ? profileSummary(memberData.member_user_id, profiles.get(memberData.member_user_id))
            : creator;

        const summary = {
            memberId: doc.id,
            splitExpenseId: memberData.split_expense_id,
            direction,
            splitExpense: { $id: memberData.split_expense_id, ...splitData },
            member: { $id: doc.id, ...memberData },
            creator,
            counterparty,
        };

        if (summary.direction === 'sent') sent.push(summary);
        else received.push(summary);
    }

    return {
        success: true,
        sent,
        received,
        incoming: received,
        active: [],
        collecting: sent,
        pagination: { limit, sentHasMore: false, receivedHasMore: false },
    };
};

module.exports = { createSplitExpense, respondSplitRequest, settleSplitPayment };
