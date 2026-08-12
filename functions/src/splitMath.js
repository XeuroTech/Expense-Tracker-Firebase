/**
 * ⚠️  FROZEN SPLIT ARITHMETIC — C-SP-1. ⚠️
 *
 * A VERBATIM port of `calculateShares` and `assertValidShares` from
 * `backend/functions/create_split_expense/src/main.js:598-670`.
 *
 * The brief's constraint is absolute: share derivation, rounding, remainder
 * assignment and validation must produce IDENTICAL numeric results under both
 * providers. A one-cent divergence is a defect, not a rounding preference.
 *
 * So this file is a transcription, not a reimplementation. Nothing here is
 * "improved". In particular:
 *
 *   - `Math.floor` for the equal-split base share, NOT `Math.round`. The remainder is
 *     then assigned entirely to the CREATOR (`totalCents - baseShare * friends.length`).
 *     Rounding instead of flooring would move a cent to a friend and change who pays
 *     it.
 *
 *   - `toFixed(4)` on `sharePercent`. It is a DISPLAY value derived from the cents,
 *     never an input to the money math — the cents are authoritative. Changing its
 *     precision would change stored data for no benefit.
 *
 *   - the percent mode uses `Math.round((totalCents * sharePercent) / 100)`, and the
 *     creator absorbs the rounding drift, exactly as above.
 *
 * The functions are pure and are covered by `__tests__/splitMath.test.js`, which
 * asserts the remainder always lands on the creator and that shares always sum to the
 * total.
 */

/**
 * DEPENDENCY-FREE ON PURPOSE.
 *
 * `toCents` is duplicated from common.js rather than imported so that this module can
 * be unit-tested with no Firebase Admin SDK, no emulator and no network. The frozen
 * arithmetic is the thing most worth testing and the thing least worth making hard to
 * test. `__tests__/splitMath.test.js` runs it under `node --test` with zero setup.
 */
const toCents = (value) => Math.round(Number(value) * 100);

const invalidTotals = () => {
    const error = new Error('INVALID_SPLIT_TOTALS');
    error.status = 400;
    error.domainCode = 'INVALID_SPLIT_TOTALS';
    return error;
};

/**
 * @param {object}   params
 * @param {number}   params.totalCents  the whole expense, in integer cents
 * @param {'equal'|'exact'|'percent'} params.splitMode
 * @param {Array}    params.friends     participants, each with shareAmount/sharePercent
 * @returns {{creatorShareCents: number, friendShares: Array}}
 */
const calculateShares = ({ totalCents, splitMode, friends }) => {
    if (splitMode === 'equal') {
        const participantCount = friends.length + 1;
        const baseShare = Math.floor(totalCents / participantCount);

        const friendShares = friends.map((friend) => ({
            ...friend,
            shareCents: baseShare,
            sharePercent: Number(((baseShare / totalCents) * 100).toFixed(4)),
        }));

        // The creator absorbs the remainder. This is the rule that makes the shares
        // sum to the total exactly, with no cent created or destroyed.
        const creatorShareCents = totalCents - baseShare * friends.length;
        return { creatorShareCents, friendShares };
    }

    if (splitMode === 'exact') {
        const friendShares = friends.map((friend) => {
            const shareCents = toCents(friend.shareAmount);
            if (!Number.isFinite(shareCents) || shareCents <= 0) throw invalidTotals();

            return {
                ...friend,
                shareCents,
                sharePercent: Number(((shareCents / totalCents) * 100).toFixed(4)),
            };
        });

        const creatorShareCents =
            totalCents - friendShares.reduce((sum, friend) => sum + friend.shareCents, 0);
        return { creatorShareCents, friendShares };
    }

    // percent
    const friendShares = friends.map((friend) => {
        const sharePercent = Number(friend.sharePercent);
        if (!Number.isFinite(sharePercent) || sharePercent <= 0) throw invalidTotals();

        return {
            ...friend,
            shareCents: Math.round((totalCents * sharePercent) / 100),
            sharePercent,
        };
    });

    const creatorShareCents =
        totalCents - friendShares.reduce((sum, friend) => sum + friend.shareCents, 0);
    return { creatorShareCents, friendShares };
};

/** Verbatim from create_split_expense/src/main.js:646-658. */
const assertValidShares = ({ creatorShareCents, friendShares, totalCents, paymentMode }) => {
    const friendTotalCents = friendShares.reduce((sum, friend) => sum + friend.shareCents, 0);

    if (friendShares.some((friend) => friend.shareCents <= 0) || friendTotalCents > totalCents) {
        throw invalidTotals();
    }

    if (paymentMode === 'own_share' && creatorShareCents <= 0) {
        const error = new Error('CREATOR_SHARE_REQUIRED');
        error.status = 400;
        error.domainCode = 'CREATOR_SHARE_REQUIRED';
        throw error;
    }
};

module.exports = { calculateShares, assertValidShares };
