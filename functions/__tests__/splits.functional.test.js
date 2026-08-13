/**
 * Split money-path functional tests — Firestore emulator required.
 *
 * Exercises the exported handlers directly (not onCall wrappers), matching the
 * pattern used by automations.test.js and aiSmartAdd.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';

if (!EMULATOR_HOST) {
    test('split money-path functional tests (SKIPPED — no Firestore emulator)', { skip: true }, () => {});
} else {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'unity-finance-splits-test';
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;

    const {
        db,
        deterministicId,
        FieldValue,
        seedProUser,
        seedMutualFriends,
        seedWallet,
        mockRequest,
        splitMemberIdFor,
        countUserTransactions,
        getWalletBalance,
        uniqueIds,
    } = require('./helpers/splitTestHarness');

    const {
        createSplitExpenseHandler,
        respondSplitRequestHandler,
        settleSplitPaymentHandler,
    } = require('../src/splits');

    const baseCreatePayload = (ids, overrides = {}) => ({
        requestId: ids.requestId,
        amount: 100,
        walletId: 'w-creator',
        title: 'Test split',
        currency: 'USD',
        splitMode: 'equal',
        friends: [{ userId: ids.friend }],
        ...overrides,
    });

    const setupCreatorFriendPair = async (prefix) => {
        const ids = uniqueIds(prefix);
        await seedProUser(ids.creator);
        await seedProUser(ids.friend);
        await seedMutualFriends(ids.creator, ids.friend);
        await seedWallet(ids.creator, 'w-creator', 500);
        await seedWallet(ids.friend, 'w-friend', 500);
        return ids;
    };

    test('I Paid Full — creator debited full amount, friend owes share', async () => {
        const ids = await setupCreatorFriendPair('paid-full');
        const result = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'creator_paid_full' }))
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.splitExpense.payment_mode, 'creator_paid_full');
        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), 400);

        const friendMemberId = splitMemberIdFor(result.splitExpense.$id, ids.friend);
        const friendMember = await db.collection('split_members').doc(friendMemberId).get();
        assert.ok(Number(friendMember.data().owed_amount) > 0);
        assert.strictEqual(friendMember.data().settlement_status, 'pending');

        const txnId = result.splitExpense.source_transaction_id;
        assert.ok(txnId);
        assert.strictEqual(
            txnId,
            deterministicId('split_txn', result.splitExpense.$id, ids.creator).slice(0, 20)
        );
        assert.strictEqual(await countUserTransactions(ids.creator), 1);
    });

    test('own_share accept — friend debited share_amount and marked settled', async () => {
        const ids = await setupCreatorFriendPair('own-share');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'own_share' }))
        );

        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), 450);

        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);
        const responded = await respondSplitRequestHandler(
            mockRequest(ids.friend, {
                action: 'respond',
                response: 'accept',
                splitMemberId: friendMemberId,
                walletId: 'w-friend',
            })
        );

        assert.strictEqual(responded.success, true);
        const member = responded.splitMembers.find((m) => m.member_user_id === ids.friend);
        assert.strictEqual(member.settlement_status, 'settled');
        assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 450);

        const payTxnId = deterministicId('split_pay_txn', friendMemberId).slice(0, 20);
        const payTxn = await db.collection('users').doc(ids.friend).collection('transactions').doc(payTxnId).get();
        assert.ok(payTxn.exists);
        assert.strictEqual(await countUserTransactions(ids.friend), 1);
    });

    test('reject — no wallet mutation', async () => {
        const ids = await setupCreatorFriendPair('reject');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'creator_paid_full' }))
        );

        const creatorBefore = await getWalletBalance(ids.creator, 'w-creator');
        const friendBefore = await getWalletBalance(ids.friend, 'w-friend');
        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);

        const responded = await respondSplitRequestHandler(
            mockRequest(ids.friend, {
                action: 'respond',
                response: 'reject',
                splitMemberId: friendMemberId,
            })
        );

        assert.strictEqual(responded.success, true);
        const member = responded.splitMembers.find((m) => m.member_user_id === ids.friend);
        assert.strictEqual(member.settlement_status, 'cancelled');
        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), creatorBefore);
        assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), friendBefore);
        assert.strictEqual(await countUserTransactions(ids.friend), 0);
    });

    test('settlement — creator credited and friend debited with deterministic txns', async () => {
        const ids = await setupCreatorFriendPair('settle');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'creator_paid_full' }))
        );

        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);
        await respondSplitRequestHandler(
            mockRequest(ids.friend, {
                action: 'respond',
                response: 'accept',
                splitMemberId: friendMemberId,
                walletId: 'w-friend',
            })
        );

        const friendMember = await db.collection('split_members').doc(friendMemberId).get();
        const owedAmount = Number(friendMember.data().owed_amount);

        const settled = await settleSplitPaymentHandler(
            mockRequest(ids.creator, {
                splitMemberId: friendMemberId,
                receivingWalletId: 'w-creator',
                amount: owedAmount,
            })
        );

        assert.strictEqual(settled.success, true);
        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), 450);
        assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 500 - owedAmount);

        const creatorTxnId = deterministicId('settle_txn', friendMemberId, 'creator').slice(0, 20);
        const memberTxnId = deterministicId('settle_txn', friendMemberId, 'member').slice(0, 20);
        assert.ok((await db.collection('users').doc(ids.creator).collection('transactions').doc(creatorTxnId).get()).exists);
        assert.ok((await db.collection('users').doc(ids.friend).collection('transactions').doc(memberTxnId).get()).exists);
    });

    test('insufficient balance on create — no split, wallet unchanged', async () => {
        const ids = uniqueIds('insuf-create');
        await seedProUser(ids.creator);
        await seedProUser(ids.friend);
        await seedMutualFriends(ids.creator, ids.friend);
        await seedWallet(ids.creator, 'w-creator', 10);
        await seedWallet(ids.friend, 'w-friend', 500);

        await assert.rejects(
            () =>
                createSplitExpenseHandler(
                    mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'creator_paid_full' }))
                ),
            (err) => {
                assert.strictEqual(err.message, 'INSUFFICIENT_BALANCE');
                return true;
            }
        );

        const splits = await db
            .collection('split_expenses')
            .where('request_id', '==', ids.requestId)
            .get();
        assert.strictEqual(splits.size, 0);
        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), 10);
    });

    test('insufficient balance on own_share accept — wallet unchanged', async () => {
        const ids = await setupCreatorFriendPair('insuf-accept');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'own_share' }))
        );

        await seedWallet(ids.friend, 'w-friend', 10);
        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);

        await assert.rejects(
            () =>
                respondSplitRequestHandler(
                    mockRequest(ids.friend, {
                        action: 'respond',
                        response: 'accept',
                        splitMemberId: friendMemberId,
                        walletId: 'w-friend',
                    })
                ),
            (err) => {
                assert.strictEqual(err.message, 'INSUFFICIENT_BALANCE');
                return true;
            }
        );

        assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 10);
        assert.strictEqual(await countUserTransactions(ids.friend), 0);
    });

    test('insufficient balance on settle — friend wallet too low, no settlement txns', async () => {
        const ids = await setupCreatorFriendPair('insuf-settle');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'creator_paid_full' }))
        );

        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);
        await respondSplitRequestHandler(
            mockRequest(ids.friend, {
                action: 'respond',
                response: 'accept',
                splitMemberId: friendMemberId,
                walletId: 'w-friend',
            })
        );

        await seedWallet(ids.friend, 'w-friend', 5);
        const friendMember = await db.collection('split_members').doc(friendMemberId).get();
        const owedAmount = Number(friendMember.data().owed_amount);

        await assert.rejects(
            () =>
                settleSplitPaymentHandler(
                    mockRequest(ids.creator, {
                        splitMemberId: friendMemberId,
                        receivingWalletId: 'w-creator',
                        amount: owedAmount,
                    })
                ),
            (err) => {
                assert.strictEqual(err.message, 'INSUFFICIENT_BALANCE');
                return true;
            }
        );

        assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 5);
        const creatorTxnId = deterministicId('settle_txn', friendMemberId, 'creator').slice(0, 20);
        assert.strictEqual(
            (await db.collection('users').doc(ids.creator).collection('transactions').doc(creatorTxnId).get()).exists,
            false
        );
    });

    test('duplicate request_id — single split and single debit', async () => {
        const ids = await setupCreatorFriendPair('dup-req');
        const payload = baseCreatePayload(ids, { paymentMode: 'creator_paid_full' });
        const req = mockRequest(ids.creator, payload);

        const [first, second] = await Promise.all([
            createSplitExpenseHandler(req),
            createSplitExpenseHandler(req),
        ]);

        assert.strictEqual(first.splitExpense.$id, second.splitExpense.$id);
        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), 400);
        assert.strictEqual(await countUserTransactions(ids.creator), 1);

        const splits = await db
            .collection('split_expenses')
            .where('request_id', '==', ids.requestId)
            .get();
        assert.strictEqual(splits.size, 1);
    });

    test('mutex recovery — stuck in_progress mutex reconstructs without second debit', async () => {
        const ids = await setupCreatorFriendPair('mutex-recovery');
        const payload = baseCreatePayload(ids, { paymentMode: 'creator_paid_full' });
        const first = await createSplitExpenseHandler(mockRequest(ids.creator, payload));

        const operationId = deterministicId('split_create', ids.creator, ids.requestId);
        await db.collection('split_operations').doc(operationId).set({
            status: 'in_progress',
            startedAt: FieldValue.serverTimestamp(),
        });

        const second = await createSplitExpenseHandler(mockRequest(ids.creator, payload));
        assert.strictEqual(second.splitExpense.$id, first.splitExpense.$id);
        assert.strictEqual(await getWalletBalance(ids.creator, 'w-creator'), 400);
        assert.strictEqual(await countUserTransactions(ids.creator), 1);
    });

    test('concurrent same accept — one debit, member settled', async () => {
        const ids = await setupCreatorFriendPair('conc-accept');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'own_share' }))
        );
        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);
        const respondReq = mockRequest(ids.friend, {
            action: 'respond',
            response: 'accept',
            splitMemberId: friendMemberId,
            walletId: 'w-friend',
        });

        const results = await Promise.allSettled([
            respondSplitRequestHandler(respondReq),
            respondSplitRequestHandler(respondReq),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        assert.ok(fulfilled.length >= 1, 'at least one accept must succeed');
        assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 450);
        assert.strictEqual(await countUserTransactions(ids.friend), 1);
    });

    test('accept vs reject race — loser returns payload, no double mutation', async () => {
        const ids = await setupCreatorFriendPair('race');
        const created = await createSplitExpenseHandler(
            mockRequest(ids.creator, baseCreatePayload(ids, { paymentMode: 'own_share' }))
        );
        const friendMemberId = splitMemberIdFor(created.splitExpense.$id, ids.friend);

        const [acceptResult, rejectResult] = await Promise.allSettled([
            respondSplitRequestHandler(
                mockRequest(ids.friend, {
                    action: 'respond',
                    response: 'accept',
                    splitMemberId: friendMemberId,
                    walletId: 'w-friend',
                })
            ),
            respondSplitRequestHandler(
                mockRequest(ids.friend, {
                    action: 'respond',
                    response: 'reject',
                    splitMemberId: friendMemberId,
                })
            ),
        ]);

        const payloads = [acceptResult, rejectResult]
            .filter((r) => r.status === 'fulfilled')
            .map((r) => r.value);
        assert.ok(payloads.length >= 1, 'at least one response must succeed with payload');

        const member = await db.collection('split_members').doc(friendMemberId).get();
        const finalStatus = member.data().settlement_status;
        assert.ok(['settled', 'cancelled'].includes(finalStatus));

        if (finalStatus === 'settled') {
            assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 450);
            assert.strictEqual(await countUserTransactions(ids.friend), 1);
        } else {
            assert.strictEqual(await getWalletBalance(ids.friend, 'w-friend'), 500);
            assert.strictEqual(await countUserTransactions(ids.friend), 0);
        }
    });
}
