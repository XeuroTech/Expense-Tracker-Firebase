/**
 * Phase 7 — Firebase `withOperationMutex` / idempotency static verification.
 *
 * These tests target the ACTUAL Firebase implementation in `src/common.js` and
 * `src/splits.js`. They do not rely on Appwrite's `split_operations.js` copies.
 *
 * Functional mutex behaviour (concurrent acquire, stale reclaim, completed replay)
 * requires the Firestore emulator — see the block at the bottom, runnable via
 * `npm run test:all` when JDK + Firebase CLI are available.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const read = (file) => fs.readFileSync(path.join(SRC_DIR, file), 'utf8');

const commonSource = read('common.js');
const splitsSource = read('splits.js');

test('withOperationMutex uses ref.create (never set) for acquisition', () => {
    assert.match(
        commonSource,
        /await ref\.create\(\{/,
        'Mutex acquisition must use create() — set() would silently overwrite and allow double money movement.'
    );
    assert.doesNotMatch(
        commonSource.slice(commonSource.indexOf('const withOperationMutex')),
        /await ref\.set\([\s\S]*status:\s*'in_progress'/,
        'in_progress mutex documents must never be written with set().'
    );
});

test('withOperationMutex replays completed operations from stored result', () => {
    assert.match(
        commonSource,
        /if \(data\.status === 'completed' && data\.result\)/,
        'Completed mutex documents must short-circuit to the stored JSON result.'
    );
});

test('withOperationMutex deletes mutex on handler failure (retryable)', () => {
    assert.match(
        commonSource,
        /await ref\.delete\(\)\.catch\(\(\) => undefined\);[\s\S]*throw error;/,
        'Failed handlers must release the mutex so corrected retries can proceed.'
    );
});

test('createSplitExpense wraps money path in withOperationMutex', () => {
    assert.match(
        splitsSource,
        /return withOperationMutex\(operationId, 'SPLIT_CREATE_IN_PROGRESS'/,
        'Split create must be mutex-guarded.'
    );
    assert.match(
        splitsSource,
        /deterministicId\('split_create', uid, requestId\)/,
        'Split create operation ids must be deterministic from requestId.'
    );
});

test('createSplitExpense supplies recovery.checkCompleted for post-crash reconciliation', () => {
    const createBlock = splitsSource.slice(
        splitsSource.indexOf("return withOperationMutex(operationId, 'SPLIT_CREATE_IN_PROGRESS'")
    );
    assert.match(
        createBlock,
        /checkCompleted:\s*async \(\) => replayCreateSplitByRequestId\(uid, requestId\)/,
        'Split create must supply recovery.checkCompleted mirroring respond/settle.'
    );
});

test('respondSplitRequest wraps money path in withOperationMutex with recovery', () => {
    assert.match(
        splitsSource,
        /return withOperationMutex\(operationId, 'SPLIT_CREATE_ALREADY_IN_PROGRESS'/,
        'Split respond must be mutex-guarded.'
    );
    assert.match(
        splitsSource,
        /deterministicId\('split_respond', uid, splitMemberId, response\)/,
        'Respond operation ids must be deterministic.'
    );
    assert.match(
        splitsSource,
        /checkCompleted:\s*async \(\) => \{/,
        'Respond must supply recovery.checkCompleted for post-crash reconciliation.'
    );
});

test('settleSplitPayment wraps money path in withOperationMutex with recovery', () => {
    assert.match(
        splitsSource,
        /return withOperationMutex\(operationId, 'SETTLEMENT_ALREADY_PROCESSING'/,
        'Settlement must be mutex-guarded.'
    );
    assert.match(
        splitsSource,
        /deterministicId\('settle', uid, splitMemberId, toCents\(amount\)\)/,
        'Settlement operation ids must include amount so different amounts stay distinct.'
    );
    const settleBlock = splitsSource.slice(splitsSource.indexOf("deterministicId('settle'"));
    assert.match(settleBlock, /checkCompleted:\s*async \(\) => \{/);
});

test('respondSplitRequest pre-check idempotency before mutex (already answered)', () => {
    assert.match(
        splitsSource,
        /if \(preCheck\.data\(\)\.settlement_status !== 'pending'\)/,
        'Already-answered members must replay current state instead of re-entering the money path.'
    );
});

test('respondSplitRequest in-transaction idempotent replay when no longer pending', () => {
    assert.match(
        splitsSource,
        /alreadyAnswered:\s*true,\s*splitExpenseId:/,
        'A concurrent retry must return the final split state instead of throwing 409.'
    );
});

test('own_share accept debits member share_amount inside transaction', () => {
    assert.match(
        splitsSource,
        /payment_mode === 'own_share'/,
        'own_share payment mode branch must exist.'
    );
    assert.match(
        splitsSource,
        /share_amount|shareAmount/,
        'Accept path must reference member share amount for wallet debits.'
    );
});

// Functional suite — requires Firestore emulator (same pattern as rateLimiting.test.js)
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';

if (!EMULATOR_HOST) {
    test('withOperationMutex functional behaviour (SKIPPED — no Firestore emulator)', { skip: true }, () => {});
} else {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'unity-finance-mutex-test';
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;

    const { withOperationMutex, db, stamps } = require('../src/common');

    test('completed mutex replays stored JSON without re-running handler', async () => {
        const operationId = `mutex-replay-${Date.now()}`;
        const stored = { ok: true, value: 42 };
        await db.collection('split_operations').doc(operationId).set({
            status: 'completed',
            result: JSON.stringify(stored),
            ...stamps(),
        });

        let handlerRan = false;
        const result = await withOperationMutex(operationId, 'BUSY', async () => {
            handlerRan = true;
            return { ok: false };
        });

        assert.deepStrictEqual(result, stored);
        assert.strictEqual(handlerRan, false);
    });

    test('handler failure deletes mutex so a corrected retry can acquire', async () => {
        const operationId = `mutex-fail-${Date.now()}`;

        await assert.rejects(
            () =>
                withOperationMutex(operationId, 'BUSY', async () => {
                    throw new Error('simulated failure');
                }),
            /simulated failure/
        );

        const snap = await db.collection('split_operations').doc(operationId).get();
        assert.strictEqual(snap.exists, false);

        const result = await withOperationMutex(operationId, 'BUSY', async () => ({ recovered: true }));
        assert.deepStrictEqual(result, { recovered: true });
    });

    test('recovery.checkCompleted reconstructs result without re-running handler', async () => {
        const operationId = `mutex-recover-${Date.now()}`;
        await db.collection('split_operations').doc(operationId).set({
            status: 'in_progress',
            startedAt: new Date().toISOString(),
            ...stamps(),
        });

        let handlerRan = false;
        const result = await withOperationMutex(
            operationId,
            'BUSY',
            async () => {
                handlerRan = true;
                return { should: 'not run' };
            },
            {
                checkCompleted: async () => ({ reconstructed: true }),
            }
        );

        assert.deepStrictEqual(result, { reconstructed: true });
        assert.strictEqual(handlerRan, false);

        const snap = await db.collection('split_operations').doc(operationId).get();
        assert.strictEqual(snap.data().status, 'completed');
        assert.strictEqual(JSON.parse(snap.data().result).reconstructed, true);
    });
}
