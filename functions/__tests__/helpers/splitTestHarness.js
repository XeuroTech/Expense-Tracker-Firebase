/**
 * Shared seeding helpers for split money-path functional tests (Firestore emulator).
 */

const { db, deterministicId, stamps, FieldValue } = require('../../src/common');

const seedProUser = async (uid) => {
    await db.collection('users').doc(uid).set(
        {
            prefs: {
                plan: 'pro',
                subscriptionStatus: 'active',
                subscriptionVerificationHash: `test-${uid}`,
            },
        },
        { merge: true }
    );
};

const seedFriendRow = async (userId, friendUserId) => {
    const id = deterministicId('friend', userId, friendUserId);
    await db.collection('friends').doc(id).set({
        user_id: userId,
        friend_user_id: friendUserId,
        status: 'accepted',
        participantIds: [userId, friendUserId],
        _deletedAt: null,
        ...stamps(),
    });
    return id;
};

const seedMutualFriends = async (uidA, uidB) => {
    await seedFriendRow(uidA, uidB);
    await seedFriendRow(uidB, uidA);
};

const seedWallet = async (uid, walletId, balance) => {
    await db.collection('users').doc(uid).collection('wallets').doc(walletId).set({
        user_id: uid,
        name: walletId,
        type: 'cash',
        currency: 'USD',
        current_balance: balance,
        _deletedAt: null,
        ...stamps(),
    });
};

const mockRequest = (uid, data) => ({ auth: { uid }, data });

const splitMemberIdFor = (splitExpenseId, memberUid) =>
    deterministicId('split_member', splitExpenseId, memberUid);

const countUserTransactions = async (uid) => {
    const snap = await db.collection('users').doc(uid).collection('transactions').get();
    return snap.size;
};

const getWalletBalance = async (uid, walletId) => {
    const snap = await db.collection('users').doc(uid).collection('wallets').doc(walletId).get();
    return Number(snap.data().current_balance);
};

const uniqueIds = (prefix) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        creator: `${prefix}-creator-${stamp}`,
        friend: `${prefix}-friend-${stamp}`,
        requestId: `${prefix}-req-${stamp}`,
    };
};

module.exports = {
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
};
