/**
 * `aiSmartAdd` — the Firebase equivalent of `backend/functions/ai_smart_add`.
 *
 * Three layers, matching the shape of rateLimiting.test.js / automations.test.js:
 *   1. Static — the callable requires auth, requires Pro, rate-limits the parse
 *      path, binds the GROQ_API_KEY secret, and declares maxInstances. No
 *      emulator required.
 *   2. Pure — normalizeAiAction / resolveAction / recomputeMissingFields against
 *      the same cases validation.js handles: every intent, wallet/category/payee
 *      matching by id and by name, and the missing-fields computation per intent.
 *      No emulator required, no network, no Groq call.
 *   3. Functional — confirmPending / cancelPending (the real Firestore-transaction
 *      money effects) against a live Firestore emulator, with a hand-seeded
 *      pending action standing in for what `parsePrompt` would have produced —
 *      this exercises the actual writes without needing a real Groq API key.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const read = (file) => fs.readFileSync(path.join(SRC_DIR, file), 'utf8');

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------

test('aiSmartAdd requires auth, requires Pro, rate-limits, and binds the Groq secret', () => {
    const source = read('aiSmartAdd.js');
    assert.match(source, /requireAuth\(request\)/);
    assert.match(source, /requirePro\(uid\)/);
    assert.match(source, /assertRateLimit\(\s*uid,\s*'aiSmartAdd'/, 'the parse path places a real, billed Groq call and must be rate-limited (§16)');
    assert.match(source, /secrets:\s*\[GROQ_API_KEY\]/, 'the Groq key must be a bound Secret Manager secret, not a plain env var');
    assert.match(source, /maxInstances:\s*\d+/, 'brief §7/§17 — every function needs a maxInstances ceiling');
});

test('ai_pending_actions is not in the client-writable finance collection allowlist', () => {
    const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');
    const allowlistBlock = rules.match(/function isFinanceCollection\(c\)[\s\S]*?\];[\s\S]*?\}/);
    assert.ok(allowlistBlock, 'could not find isFinanceCollection() in firestore.rules');
    assert.ok(
        !allowlistBlock[0].includes('ai_pending_actions'),
        'ai_pending_actions must stay Admin-SDK-only — the whole pending-action lifecycle assumes ' +
            'the client cannot read or forge one directly'
    );
});

// ---------------------------------------------------------------------------
// Pure — normalization and resolution
// ---------------------------------------------------------------------------

const { normalizeAiAction, resolveAction, recomputeMissingFields, applyDefaults } = require('../src/aiSmartAdd');

const WALLETS = [
    { $id: 'w-cash', name: 'Cash', type: 'cash' },
    { $id: 'w-bank', name: 'Bank', type: 'bank' },
];
const CATEGORIES = [
    { $id: 'c-food', name: 'Food', type: 'expense' },
    { $id: 'c-salary', name: 'Salary', type: 'income' },
];
const PAYEES = [{ $id: 'p-kfc', name: 'KFC', is_business: true }];

test('normalizeAiAction maps a bare transaction-type intent (expense/income/transfer) to intent=transaction', () => {
    const action = normalizeAiAction({ intent: 'expense', amount: 10 });
    assert.strictEqual(action.intent, 'transaction');
    assert.strictEqual(action.transactionType, 'expense');
});

test('normalizeAiAction clamps confidence into [0, 1]', () => {
    assert.strictEqual(normalizeAiAction({ confidence: 5 }).confidence, 1);
    assert.strictEqual(normalizeAiAction({ confidence: -5 }).confidence, 0);
    assert.strictEqual(normalizeAiAction({ confidence: 'nonsense' }).confidence, 0);
});

test('normalizeAiAction rejects an unrecognised intent as unknown', () => {
    assert.strictEqual(normalizeAiAction({ intent: 'do_something_bad' }).intent, 'unknown');
});

test('normalizeAiAction maps wallet type synonyms ("credit", "credit card") to credit_card', () => {
    assert.strictEqual(normalizeAiAction({ wallet: { type: 'credit' } }).wallet.type, 'credit_card');
    assert.strictEqual(normalizeAiAction({ wallet: { type: 'Credit Card' } }).wallet.type, 'credit_card');
});

test('resolveAction matches an expense transaction by wallet/category id and reports no missing fields', () => {
    const raw = normalizeAiAction({
        intent: 'expense',
        amount: 25,
        fromWalletId: 'w-cash',
        categoryId: 'c-food',
        date: '2026-01-01T00:00:00.000Z',
    });
    const resolved = resolveAction(raw, WALLETS, CATEGORIES, PAYEES);
    assert.strictEqual(resolved.matches.fromWalletId, 'w-cash');
    assert.strictEqual(resolved.matches.categoryId, 'c-food');
    assert.deepStrictEqual(resolved.missingFields, []);
});

test('resolveAction matches wallets and categories by NAME, case-insensitively', () => {
    const raw = normalizeAiAction({
        intent: 'income',
        amount: 500,
        fromWallet: 'cash',
        category: 'salary',
        date: '2026-01-01T00:00:00.000Z',
    });
    const resolved = resolveAction(raw, WALLETS, CATEGORIES, PAYEES);
    assert.strictEqual(resolved.matches.toWalletId, 'w-cash', 'income defaults toWallet from fromWallet when unset');
    assert.strictEqual(resolved.matches.categoryId, 'c-salary');
});

test('resolveAction reports missing fields for an incomplete expense', () => {
    const raw = normalizeAiAction({ intent: 'expense', amount: 25 });
    const resolved = resolveAction(raw, WALLETS, CATEGORIES, PAYEES);
    assert.ok(resolved.missingFields.includes('fromWalletId'));
    assert.ok(resolved.missingFields.includes('categoryId'));
});

test('resolveAction sets pendingCategoryToCreate when the category name has no match', () => {
    const raw = normalizeAiAction({ intent: 'expense', amount: 10, fromWalletId: 'w-cash', categoryName: 'Groceries' });
    const resolved = resolveAction(raw, WALLETS, CATEGORIES, PAYEES);
    assert.strictEqual(resolved.matches.categoryId, null);
    assert.deepStrictEqual(resolved.pendingCategoryToCreate, { name: 'Groceries', type: 'expense' });
});

test('resolveAction requires distinct wallets for a transfer', () => {
    const raw = normalizeAiAction({
        intent: 'transaction', transactionType: 'transfer', amount: 10, fromWalletId: 'w-cash', toWalletId: 'w-cash',
    });
    const resolved = resolveAction(raw, WALLETS, CATEGORIES, PAYEES);
    assert.ok(resolved.missingFields.includes('toWalletId'), 'a transfer to the same wallet must be flagged, not silently accepted');
});

test('recomputeMissingFields requires loan.type, amount, walletId and date for loan_create', () => {
    const action = applyDefaults(normalizeAiAction({ intent: 'loan_create' }));
    const recomputed = recomputeMissingFields(action);
    assert.ok(recomputed.missingFields.includes('loan.type'));
    assert.ok(recomputed.missingFields.includes('loan.amount'));
    assert.ok(recomputed.missingFields.includes('loan.walletId'));
});

test('recomputeMissingFields requires budget.amount and budget.period for budget, and defaults budget.categoryId from matches', () => {
    const raw = normalizeAiAction({ intent: 'budget', categoryId: 'c-food' });
    const resolved = resolveAction(raw, WALLETS, CATEGORIES, PAYEES);
    assert.strictEqual(resolved.budget.categoryId, 'c-food');
    assert.ok(resolved.missingFields.includes('budget.amount'));
    assert.ok(resolved.missingFields.includes('budget.period'));
});

test('recomputeMissingFields requires wallet.name and wallet.type for wallet_create', () => {
    const action = applyDefaults(normalizeAiAction({ intent: 'wallet_create' }));
    const recomputed = recomputeMissingFields(action);
    assert.ok(recomputed.missingFields.includes('wallet.name'));
    assert.ok(recomputed.missingFields.includes('wallet.type'));
});

/**
 * Verbatim quirk of validation.js's `cleanBalance`, preserved rather than "fixed"
 * per the parity brief (do not invent different behaviour than the source):
 * `cleanBalance(null)` returns `0`, not `null` (`Number(null) === 0`, which passes
 * the `>= 0` check). An absent `wallet.initialBalance` is cleaned to `null` on
 * first pass, then that `null` is re-cleaned to `0` when `recomputeMissingFields`
 * rebuilds `next.wallet` — so a wallet_create with NO balance specified is never
 * flagged as missing one; it silently resolves to a zero-balance wallet instead.
 * `createWallet` (aiSmartAddActions.js) still requires `Number.isFinite(balance)`,
 * so this only means the missing-fields prompt for balance is unreachable, not
 * that a bad wallet ever gets created.
 */
test('wallet_create with no balance at all resolves to 0, not a missing field (verbatim cleanBalance quirk)', () => {
    const action = applyDefaults(normalizeAiAction({ intent: 'wallet_create', wallet: { name: 'Cash', type: 'cash' } }));
    const recomputed = recomputeMissingFields(action);
    assert.strictEqual(recomputed.wallet.initialBalance, 0);
    assert.ok(!recomputed.missingFields.includes('wallet.initialBalance'));
});

test('applyDefaults stamps "now" as the transaction date when absent', () => {
    const action = applyDefaults(normalizeAiAction({ intent: 'expense', amount: 5 }));
    assert.ok(action.date, 'a transaction must always end up with a date');
});

// ---------------------------------------------------------------------------
// Functional — confirmPending / cancelPending against the Firestore emulator
// ---------------------------------------------------------------------------

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';

if (!EMULATOR_HOST) {
    test('aiSmartAdd confirm/cancel functional behaviour (SKIPPED — no Firestore emulator)', { skip: true }, () => {});
} else {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'unity-finance-rate-limit-test';
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('../src/common');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { confirmPending, cancelPending } = require('../src/aiSmartAdd');

    const seedWallet = async (uid, id, balance) => {
        await db.collection('users').doc(uid).collection('wallets').doc(id).set({
            user_id: uid, name: id, type: 'cash', current_balance: balance, _deletedAt: null,
        });
    };

    const seedCategory = async (uid, id, type) => {
        await db.collection('users').doc(uid).collection('categories').doc(id).set({
            user_id: uid, name: id, type, color: '#000', icon: 'x', _deletedAt: null,
        });
    };

    const seedPending = async (uid, id, action, { expiresInMs = 30 * 60 * 1000, status = 'pending' } = {}) => {
        const now = new Date();
        await db.collection('users').doc(uid).collection('ai_pending_actions').doc(id).set({
            user_id: uid,
            prompt: 'test prompt',
            prompt_hash: `hash-${id}`,
            intent: action.intent,
            status,
            action_json: JSON.stringify(action),
            confidence: action.confidence || 0.9,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            expires_at: new Date(now.getTime() + expiresInMs).toISOString(),
        });
    };

    test('confirmPending(wallet_create) creates a wallet with the requested balance', async () => {
        const uid = `ai-user-${Date.now()}-wallet`;
        await seedPending(uid, 'p1', {
            intent: 'wallet_create',
            wallet: { name: 'New Bank', type: 'bank', initialBalance: 1000, currentBalance: 1000 },
            matches: {},
        });

        const result = await confirmPending(uid, { pendingActionId: 'p1' });
        assert.strictEqual(result.result_type, 'wallet');
        assert.strictEqual(result.document.current_balance, 1000);

        const pendingDoc = await db.collection('users').doc(uid).collection('ai_pending_actions').doc('p1').get();
        assert.strictEqual(pendingDoc.data().status, 'confirmed');
    });

    test('confirmPending(transaction expense) debits the wallet and records the transaction', async () => {
        const uid = `ai-user-${Date.now()}-expense`;
        await seedWallet(uid, 'w1', 200);
        await seedCategory(uid, 'c1', 'expense');
        await seedPending(uid, 'p2', {
            intent: 'transaction',
            transactionType: 'expense',
            amount: 50,
            date: new Date().toISOString(),
            matches: { fromWalletId: 'w1', categoryId: 'c1' },
            payee: {},
        });

        const result = await confirmPending(uid, { pendingActionId: 'p2' });
        assert.strictEqual(result.result_type, 'transaction');

        const wallet = await db.collection('users').doc(uid).collection('wallets').doc('w1').get();
        assert.strictEqual(wallet.data().current_balance, 150);
    });

    test('confirmPending(transaction expense) rejects an insufficient balance and leaves the wallet untouched', async () => {
        const uid = `ai-user-${Date.now()}-insufficient`;
        await seedWallet(uid, 'w1', 10);
        await seedCategory(uid, 'c1', 'expense');
        await seedPending(uid, 'p3', {
            intent: 'transaction',
            transactionType: 'expense',
            amount: 50,
            date: new Date().toISOString(),
            matches: { fromWalletId: 'w1', categoryId: 'c1' },
            payee: {},
        });

        await assert.rejects(
            () => confirmPending(uid, { pendingActionId: 'p3' }),
            (err) => {
                assert.strictEqual(err.message, 'AI_INSUFFICIENT_BALANCE');
                return true;
            }
        );

        const wallet = await db.collection('users').doc(uid).collection('wallets').doc('w1').get();
        assert.strictEqual(wallet.data().current_balance, 10, 'a rejected confirm must not mutate the wallet');
    });

    test('confirmPending(budget) creates a budget against an existing category', async () => {
        const uid = `ai-user-${Date.now()}-budget`;
        await seedCategory(uid, 'c1', 'expense');
        await seedPending(uid, 'p4', {
            intent: 'budget',
            amount: 300,
            budget: { categoryId: 'c1', amount: 300, period: 'monthly' },
            matches: { categoryId: 'c1' },
        });

        const result = await confirmPending(uid, { pendingActionId: 'p4' });
        assert.strictEqual(result.result_type, 'budget');
        assert.strictEqual(result.document.allocated_amount, 300);
        assert.strictEqual(result.document.category_id, 'c1');
    });

    test('confirmPending rejects an already-confirmed pending action', async () => {
        const uid = `ai-user-${Date.now()}-double`;
        await seedPending(uid, 'p5', { intent: 'wallet_create', wallet: { name: 'W', type: 'cash', initialBalance: 0 }, matches: {} });
        await confirmPending(uid, { pendingActionId: 'p5' });

        await assert.rejects(
            () => confirmPending(uid, { pendingActionId: 'p5' }),
            (err) => {
                assert.strictEqual(err.message, 'AI_PENDING_ACTION_INACTIVE');
                return true;
            }
        );
    });

    test('confirmPending rejects and expires a pending action past its TTL', async () => {
        const uid = `ai-user-${Date.now()}-expired`;
        await seedPending(
            uid,
            'p6',
            { intent: 'wallet_create', wallet: { name: 'W', type: 'cash', initialBalance: 0 }, matches: {} },
            { expiresInMs: -1000 }
        );

        await assert.rejects(
            () => confirmPending(uid, { pendingActionId: 'p6' }),
            (err) => {
                assert.strictEqual(err.message, 'AI_PENDING_ACTION_EXPIRED');
                return true;
            }
        );

        const pendingDoc = await db.collection('users').doc(uid).collection('ai_pending_actions').doc('p6').get();
        assert.strictEqual(pendingDoc.data().status, 'expired');
    });

    test('cancelPending marks a pending action cancelled and removes its provisional category', async () => {
        const uid = `ai-user-${Date.now()}-cancel`;
        await seedCategory(uid, 'auto-cat', 'expense');
        await seedPending(uid, 'p7', {
            intent: 'transaction',
            transactionType: 'expense',
            amount: 10,
            matches: { fromWalletId: 'w1', categoryId: 'auto-cat', autoCategoryId: 'auto-cat' },
        });

        await cancelPending(uid, 'p7');

        const pendingDoc = await db.collection('users').doc(uid).collection('ai_pending_actions').doc('p7').get();
        assert.strictEqual(pendingDoc.data().status, 'cancelled');

        const categoryDoc = await db.collection('users').doc(uid).collection('categories').doc('auto-cat').get();
        assert.strictEqual(categoryDoc.exists, false, 'a provisional category must be removed on cancel');
    });
}
