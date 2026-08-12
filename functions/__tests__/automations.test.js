/**
 * AUTOMATION EVALUATION — the Firebase equivalent of `evaluate_automations`.
 *
 * Three layers, matching the shape of rateLimiting.test.js / logging.test.js:
 *   1. Static — the trigger declares maxInstances and both the recursion guard and
 *      the depth ceiling are present in source. No emulator required.
 *   2. Pure — the ported helpers (extractRelationId, parseAmountTemplate,
 *      parseMaybeJson) against the exact cases evaluate_automations/src/main.js
 *      handles. No emulator required.
 *   3. Functional — evaluateAutomationsForTransaction (the trigger's core logic,
 *      factored out so it is directly callable) against a live Firestore emulator:
 *      create_transfer moves money between two wallets and stamps the recursion
 *      guard, allocate_budget increments a budget, and both guards actually stop
 *      a re-triggered evaluation from running.
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

test('evaluateAutomationsOnTransactionCreate is scoped to users/{uid}/transactions and declares maxInstances', () => {
    const source = read('automations.js');
    assert.match(
        source,
        /document:\s*'users\/\{uid\}\/transactions\/\{transactionId\}'/,
        'the trigger must be owner-scoped by construction, never a collection-group query'
    );
    assert.match(source, /maxInstances:\s*\d+/, 'brief §7/§17 — every function needs a maxInstances ceiling');
});

test('the recursion guard and depth ceiling are both present', () => {
    const source = read('automations.js');
    assert.match(source, /tx\.origin === 'automation'/, 'missing the recursion-guard marker check');
    assert.match(source, /automationDepth/, 'missing the depth-ceiling field');
    assert.match(
        source,
        /origin:\s*'automation'/,
        'a transaction created by an automation must be stamped so the guard above can see it'
    );
});

// ---------------------------------------------------------------------------
// Pure helpers — verbatim ports of evaluate_automations/src/main.js
// ---------------------------------------------------------------------------

const { extractRelationId, parseAmountTemplate, parseMaybeJson, MAX_AUTOMATION_DEPTH } = require('../src/automations');

test('extractRelationId handles the three Appwrite relation shapes plus null', () => {
    assert.strictEqual(extractRelationId('cat1'), 'cat1');
    assert.strictEqual(extractRelationId({ $id: 'cat2' }), 'cat2');
    assert.strictEqual(extractRelationId(['cat3']), 'cat3');
    assert.strictEqual(extractRelationId([{ $id: 'cat4' }]), 'cat4');
    assert.strictEqual(extractRelationId(null), null);
    assert.strictEqual(extractRelationId(undefined), null);
    assert.strictEqual(extractRelationId({}), null);
});

test('parseAmountTemplate supports fixed numbers, {{amount}}, and {{amount * N}}', () => {
    assert.strictEqual(parseAmountTemplate(25, 999), 25, 'a numeric template is used verbatim');
    assert.strictEqual(parseAmountTemplate('50', 999), 50, 'a fixed numeric string is parsed');
    assert.strictEqual(parseAmountTemplate('{{amount}}', 77), 77);
    assert.strictEqual(parseAmountTemplate('{{amount * 0.10}}', 200), 20);
    assert.strictEqual(parseAmountTemplate('', 42), 42, 'an empty template falls back to the base amount');
    assert.strictEqual(parseAmountTemplate('garbage', 42), 42, 'an unparseable template falls back to the base amount');
});

test('parseMaybeJson accepts a native object, a JSON string, and rejects garbage', () => {
    assert.deepStrictEqual(parseMaybeJson({ a: 1 }), { a: 1 });
    assert.deepStrictEqual(parseMaybeJson('{"a":1}'), { a: 1 });
    assert.strictEqual(parseMaybeJson('not json'), null);
    assert.strictEqual(parseMaybeJson(null), null);
});

test('MAX_AUTOMATION_DEPTH is exactly one level', () => {
    assert.strictEqual(MAX_AUTOMATION_DEPTH, 1);
});

// ---------------------------------------------------------------------------
// Functional — against the Firestore emulator
// ---------------------------------------------------------------------------

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';

if (!EMULATOR_HOST) {
    test('evaluateAutomationsForTransaction functional behaviour (SKIPPED — no Firestore emulator)', { skip: true }, () => {});
} else {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'unity-finance-rate-limit-test';
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('../src/common');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { evaluateAutomationsForTransaction } = require('../src/automations');

    const seedWallet = async (uid, id, balance) => {
        await db.collection('users').doc(uid).collection('wallets').doc(id).set({
            user_id: uid,
            name: id,
            type: 'cash',
            current_balance: balance,
            _deletedAt: null,
        });
    };

    const seedAutomation = async (uid, id, { actionType, payload, conditions }) => {
        await db.collection('users').doc(uid).collection('automations').doc(id).set({
            user_id: uid,
            name: id,
            is_active: true,
            trigger_type: 'transaction_created',
            conditions: JSON.stringify(conditions),
            action_type: actionType,
            action_payload: JSON.stringify(payload),
            _deletedAt: null,
        });
    };

    test('create_transfer moves money between wallets and stamps the recursion guard', async () => {
        const uid = `auto-user-${Date.now()}`;
        await seedWallet(uid, 'source', 500);
        await seedWallet(uid, 'dest', 100);
        await seedAutomation(uid, 'auto1', {
            actionType: 'create_transfer',
            payload: { source_wallet_id: 'source', dest_wallet_id: 'dest', amount: '{{amount * 0.10}}' },
            conditions: { ignore_if_null: true, value: null },
        });

        await evaluateAutomationsForTransaction(uid, 'tx1', { amount: 200, category_id: null });

        const [sourceSnap, destSnap] = await Promise.all([
            db.collection('users').doc(uid).collection('wallets').doc('source').get(),
            db.collection('users').doc(uid).collection('wallets').doc('dest').get(),
        ]);
        assert.strictEqual(sourceSnap.data().current_balance, 480, '500 - (200*0.10)');
        assert.strictEqual(destSnap.data().current_balance, 120, '100 + (200*0.10)');

        const created = await db.collection('users').doc(uid).collection('transactions')
            .where('origin', '==', 'automation')
            .get();
        assert.strictEqual(created.size, 1, 'exactly one automation-authored transaction should exist');
        assert.strictEqual(created.docs[0].data().automationDepth, MAX_AUTOMATION_DEPTH);
        assert.strictEqual(created.docs[0].data().type, 'transfer');
    });

    test('allocate_budget increments the budget allocated_amount', async () => {
        const uid = `auto-user-${Date.now()}-budget`;
        await db.collection('users').doc(uid).collection('budgets').doc('b1').set({
            user_id: uid,
            name: 'Food Budget',
            allocated_amount: 100,
            spent_amount: 0,
            _deletedAt: null,
        });
        await seedAutomation(uid, 'auto2', {
            actionType: 'allocate_budget',
            payload: { budget_id: 'b1', amount: '{{amount}}' },
            conditions: { field: 'category_id', operator: '==', value: 'food-cat' },
        });

        await evaluateAutomationsForTransaction(uid, 'tx2', { amount: 30, category_id: 'food-cat' });

        const budget = await db.collection('users').doc(uid).collection('budgets').doc('b1').get();
        assert.strictEqual(budget.data().allocated_amount, 130);
    });

    test('a non-matching category condition does not fire the automation', async () => {
        const uid = `auto-user-${Date.now()}-nomatch`;
        await seedWallet(uid, 'source', 500);
        await seedWallet(uid, 'dest', 100);
        await seedAutomation(uid, 'auto3', {
            actionType: 'create_transfer',
            payload: { source_wallet_id: 'source', dest_wallet_id: 'dest', amount: '10' },
            conditions: { field: 'category_id', operator: '==', value: 'specific-cat' },
        });

        await evaluateAutomationsForTransaction(uid, 'tx3', { amount: 200, category_id: 'other-cat' });

        const sourceSnap = await db.collection('users').doc(uid).collection('wallets').doc('source').get();
        assert.strictEqual(sourceSnap.data().current_balance, 500, 'balance must be untouched — condition did not match');
    });

    test('the recursion guard stops an automation-authored transaction from re-triggering', async () => {
        const uid = `auto-user-${Date.now()}-recursion`;
        await seedWallet(uid, 'source', 500);
        await seedWallet(uid, 'dest', 100);
        await seedAutomation(uid, 'auto4', {
            actionType: 'create_transfer',
            payload: { source_wallet_id: 'source', dest_wallet_id: 'dest', amount: '10' },
            conditions: { ignore_if_null: true, value: null },
        });

        // Simulates the trigger firing on the transaction automations themselves create.
        await evaluateAutomationsForTransaction(uid, 'tx-auto', {
            amount: 10,
            category_id: null,
            origin: 'automation',
            automationDepth: 1,
        });

        const sourceSnap = await db.collection('users').doc(uid).collection('wallets').doc('source').get();
        assert.strictEqual(sourceSnap.data().current_balance, 500, 'an automation-authored transaction must never re-trigger evaluation');
    });

    test('the depth ceiling stops evaluation even without the origin marker', async () => {
        const uid = `auto-user-${Date.now()}-depth`;
        await seedWallet(uid, 'source', 500);
        await seedWallet(uid, 'dest', 100);
        await seedAutomation(uid, 'auto5', {
            actionType: 'create_transfer',
            payload: { source_wallet_id: 'source', dest_wallet_id: 'dest', amount: '10' },
            conditions: { ignore_if_null: true, value: null },
        });

        await evaluateAutomationsForTransaction(uid, 'tx-deep', {
            amount: 10,
            category_id: null,
            automationDepth: MAX_AUTOMATION_DEPTH,
        });

        const sourceSnap = await db.collection('users').doc(uid).collection('wallets').doc('source').get();
        assert.strictEqual(sourceSnap.data().current_balance, 500, 'depth >= ceiling must stop evaluation independent of the origin marker');
    });

    test('invalid wallet payload is logged and does not throw', async () => {
        const uid = `auto-user-${Date.now()}-badwallet`;
        await seedAutomation(uid, 'auto6', {
            actionType: 'create_transfer',
            payload: { source_wallet_id: 'missing-source', dest_wallet_id: 'missing-dest', amount: '10' },
            conditions: { ignore_if_null: true, value: null },
        });

        // Must resolve, not reject — a bad automation must not break transaction creation.
        await assert.doesNotReject(() => evaluateAutomationsForTransaction(uid, 'tx-bad', { amount: 10, category_id: null }));
    });
}
