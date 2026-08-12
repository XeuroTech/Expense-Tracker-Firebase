/**
 * Frozen-arithmetic tests (C-SP-1).
 *
 * Runs under Node's built-in test runner with ZERO setup:
 *
 *     node --test firebase/functions/__tests__/
 *
 * These are the tests that matter most, because the constraint they defend is
 * absolute: a one-cent divergence from the Appwrite implementation is a defect. They
 * assert the two properties that a "cleaner" rewrite would silently break —
 *
 *   1. shares always sum EXACTLY to the total (no cent created or destroyed)
 *   2. the remainder always lands on the CREATOR, never on a friend
 *
 * Property 2 is the one that looks like a rounding preference and is not. Swapping
 * `Math.floor` for `Math.round` in the equal-split base share still satisfies
 * property 1, but moves a cent from the creator to a participant.
 */

const test = require('node:test');
const assert = require('node:assert');

const { calculateShares, assertValidShares } = require('../src/splitMath');

const sum = (shares) => shares.reduce((total, share) => total + share.shareCents, 0);

const friendsNamed = (count, extra = {}) =>
    Array.from({ length: count }, (_, index) => ({ userId: `friend-${index}`, ...extra }));

// ---------------------------------------------------------------------------
// equal
// ---------------------------------------------------------------------------

test('equal split: shares sum exactly to the total', () => {
    for (const totalCents of [1, 2, 3, 100, 999, 1000, 10001, 333_33]) {
        for (const friendCount of [1, 2, 3, 7, 99]) {
            const { creatorShareCents, friendShares } = calculateShares({
                totalCents,
                splitMode: 'equal',
                friends: friendsNamed(friendCount),
            });

            assert.strictEqual(
                creatorShareCents + sum(friendShares),
                totalCents,
                `total=${totalCents} friends=${friendCount}`
            );
        }
    }
});

test('equal split: the remainder lands on the creator, never on a friend', () => {
    // 100 cents across 3 participants: 33 each, 1 cent left over.
    const { creatorShareCents, friendShares } = calculateShares({
        totalCents: 100,
        splitMode: 'equal',
        friends: friendsNamed(2),
    });

    assert.deepStrictEqual(
        friendShares.map((share) => share.shareCents),
        [33, 33],
        'friends receive the floored base share'
    );
    assert.strictEqual(creatorShareCents, 34, 'creator absorbs the remainder');
});

test('equal split: creator never receives less than a friend', () => {
    for (let totalCents = 1; totalCents <= 500; totalCents += 1) {
        for (const friendCount of [1, 2, 3, 4, 5]) {
            const { creatorShareCents, friendShares } = calculateShares({
                totalCents,
                splitMode: 'equal',
                friends: friendsNamed(friendCount),
            });

            for (const share of friendShares) {
                assert.ok(
                    creatorShareCents >= share.shareCents,
                    `creator ${creatorShareCents} < friend ${share.shareCents} ` +
                        `(total=${totalCents}, friends=${friendCount})`
                );
            }
        }
    }
});

// ---------------------------------------------------------------------------
// exact
// ---------------------------------------------------------------------------

test('exact split: creator takes whatever the friends did not', () => {
    const { creatorShareCents, friendShares } = calculateShares({
        totalCents: 10_000,
        splitMode: 'exact',
        friends: [
            { userId: 'a', shareAmount: 25.5 },
            { userId: 'b', shareAmount: 30.25 },
        ],
    });

    assert.deepStrictEqual(friendShares.map((share) => share.shareCents), [2550, 3025]);
    assert.strictEqual(creatorShareCents, 10_000 - 2550 - 3025);
    assert.strictEqual(creatorShareCents + sum(friendShares), 10_000);
});

test('exact split: a non-positive share is rejected with INVALID_SPLIT_TOTALS', () => {
    assert.throws(
        () =>
            calculateShares({
                totalCents: 1000,
                splitMode: 'exact',
                friends: [{ userId: 'a', shareAmount: 0 }],
            }),
        /INVALID_SPLIT_TOTALS/
    );
});

// ---------------------------------------------------------------------------
// percent
// ---------------------------------------------------------------------------

test('percent split: shares sum exactly to the total despite rounding', () => {
    // Three-way 33.333% is the classic case where naive rounding loses a cent.
    const { creatorShareCents, friendShares } = calculateShares({
        totalCents: 10_000,
        splitMode: 'percent',
        friends: [
            { userId: 'a', sharePercent: 33.333 },
            { userId: 'b', sharePercent: 33.333 },
        ],
    });

    assert.strictEqual(creatorShareCents + sum(friendShares), 10_000);
});

test('percent split: a non-positive percent is rejected', () => {
    assert.throws(
        () =>
            calculateShares({
                totalCents: 1000,
                splitMode: 'percent',
                friends: [{ userId: 'a', sharePercent: -5 }],
            }),
        /INVALID_SPLIT_TOTALS/
    );
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('assertValidShares: friends may not exceed the total', () => {
    assert.throws(
        () =>
            assertValidShares({
                creatorShareCents: -100,
                friendShares: [{ shareCents: 1100 }],
                totalCents: 1000,
                paymentMode: 'full',
            }),
        /INVALID_SPLIT_TOTALS/
    );
});

test('assertValidShares: own_share requires a positive creator share', () => {
    assert.throws(
        () =>
            assertValidShares({
                creatorShareCents: 0,
                friendShares: [{ shareCents: 1000 }],
                totalCents: 1000,
                paymentMode: 'own_share',
            }),
        /CREATOR_SHARE_REQUIRED/
    );

    // ...but paying the full amount with a zero own-share is legitimate.
    assert.doesNotThrow(() =>
        assertValidShares({
            creatorShareCents: 0,
            friendShares: [{ shareCents: 1000 }],
            totalCents: 1000,
            paymentMode: 'full',
        })
    );
});

test('participant cap: 99 friends + creator still balances', () => {
    const { creatorShareCents, friendShares } = calculateShares({
        totalCents: 123_457,
        splitMode: 'equal',
        friends: friendsNamed(99),
    });

    assert.strictEqual(friendShares.length, 99);
    assert.strictEqual(creatorShareCents + sum(friendShares), 123_457);
});
