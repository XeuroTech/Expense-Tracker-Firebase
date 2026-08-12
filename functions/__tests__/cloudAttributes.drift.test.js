/**
 * DRIFT GUARD for the cloud field allowlist.
 *
 * The same allowlist now exists in FOUR places:
 *
 *   1. frontend/src/services/syncService.ts        CLOUD_ATTRIBUTES  (client strip)
 *   2. backend/functions/finance_sync/src/main.js  CLOUD_ATTRIBUTES  (Appwrite server strip)
 *   3. frontend/src/backend/firebase/cloudAttributes.ts               (Firebase client strip)
 *   4. firebase/firestore.rules                    allowedFields()    (Firebase enforcement)
 *
 * 1 and 2 predate this work and are PROTECTED — they are not touched. 3 and 4 are the
 * Firebase fork's copies, and they exist because Firestore has no server in the
 * finance path: rules become the enforcement point, and rules REJECT where
 * `finance_sync` STRIPS.
 *
 * Four copies of anything will drift. This test makes drift a build failure instead
 * of a production one, and the failure mode it prevents is specific and nasty: if
 * `syncService` sends a field that firestore.rules does not list, the ENTIRE write is
 * denied — not the field. A user's transactions would silently stop syncing.
 *
 * Runs with no install and no emulator: it reads the four files as TEXT and compares
 * the parsed lists.
 *
 *     node --test firebase/functions/__tests__/cloudAttributes.drift.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

/** Extracts `const <NAME> ... = { ... };` — the first balanced block. */
const sliceBlock = (source, declaration) => {
    const start = source.indexOf(declaration);
    assert.ok(start !== -1, `could not find "${declaration}"`);

    const open = source.indexOf('{', start);
    let depth = 0;

    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }

    throw new Error(`unbalanced block for "${declaration}"`);
};

const quoted = (text) =>
    Array.from(text.matchAll(/['"]([^'"]+)['"]/g)).map((match) => match[1]);

/** `[appwriteConfig.collectionId.wallets]: [ "name", ... ]` */
const parseComputedKeyMap = (block) => {
    const result = {};
    const pattern = /\[appwriteConfig\.collectionId\.(\w+)\]\s*:\s*\[([^\]]*)\]/g;

    for (const match of block.matchAll(pattern)) {
        result[match[1]] = quoted(match[2]);
    }

    return result;
};

/** `wallets: [ 'name', ... ]` */
const parsePlainKeyMap = (block) => {
    const result = {};
    const pattern = /(?:^|[\s{,])(\w+)\s*:\s*\[([^\]]*)\]/g;

    for (const match of block.matchAll(pattern)) {
        result[match[1]] = quoted(match[2]);
    }

    return result;
};

/** `c == 'wallets' ? ['name', ...]` inside the rules helper */
const parseRulesAllowedFields = (source) => {
    const start = source.indexOf('function allowedFields(c)');
    assert.ok(start !== -1, 'could not find allowedFields() in firestore.rules');

    const end = source.indexOf('function createOnlyFields', start);
    const block = source.slice(start, end === -1 ? undefined : end);

    const result = {};
    const pattern = /c\s*==\s*'(\w+)'\s*\?\s*\[([^\]]*)\]/g;

    for (const match of block.matchAll(pattern)) {
        result[match[1]] = quoted(match[2]);
    }

    return result;
};

/**
 * Fields the Firebase side adds on purpose. Every entry needs a reason — this list is
 * the seam where an accidental divergence would otherwise hide.
 */
const FIREBASE_ONLY_FIELDS = {
    // Expo push tokens and raw FCM tokens have different formats and both exist during
    // a rollout, so the dispatcher must be able to tell them apart. Appwrite has no
    // FCM path at all and therefore never needed the discriminator.
    device_tokens: ['token_kind'],
};

const sorted = (list) => [...list].sort();

// ---------------------------------------------------------------------------

const syncServiceAttributes = parseComputedKeyMap(
    sliceBlock(read('frontend/src/services/syncService.ts'), 'const CLOUD_ATTRIBUTES')
);

const financeSyncAttributes = parsePlainKeyMap(
    sliceBlock(read('backend/functions/finance_sync/src/main.js'), 'const CLOUD_ATTRIBUTES')
);

const firebaseAttributes = parsePlainKeyMap(
    sliceBlock(
        read('frontend/src/backend/firebase/cloudAttributes.ts'),
        'export const CLOUD_ATTRIBUTES'
    )
);

const rulesAttributes = parseRulesAllowedFields(read('firebase/firestore.rules'));

test('the parsers actually found the tables (guards against a silent no-op test)', () => {
    assert.strictEqual(Object.keys(syncServiceAttributes).length, 15);
    assert.strictEqual(Object.keys(financeSyncAttributes).length, 15);
    assert.strictEqual(Object.keys(firebaseAttributes).length, 15);
    // Rules only cover the 10 owner-scoped tables; the 5 server-managed ones are
    // `allow write: if false` and need no field allowlist.
    assert.strictEqual(Object.keys(rulesAttributes).length, 10);
});

test('syncService.ts and finance_sync agree (pre-existing invariant, not ours)', () => {
    for (const [table, fields] of Object.entries(syncServiceAttributes)) {
        assert.deepStrictEqual(
            sorted(fields),
            sorted(financeSyncAttributes[table] || []),
            `CLOUD_ATTRIBUTES.${table} differs between the client and finance_sync`
        );
    }
});

test('the Firebase mirror matches syncService.ts EXACTLY', () => {
    assert.deepStrictEqual(
        sorted(Object.keys(firebaseAttributes)),
        sorted(Object.keys(syncServiceAttributes)),
        'table set differs'
    );

    for (const [table, fields] of Object.entries(syncServiceAttributes)) {
        assert.deepStrictEqual(
            sorted(firebaseAttributes[table]),
            sorted(fields),
            `cloudAttributes.ts is out of step with syncService.ts for "${table}". ` +
                'Update the mirror — do NOT change syncService.ts, it is protected.'
        );
    }
});

test('firestore.rules accepts every field the client can send', () => {
    for (const [table, ruleFields] of Object.entries(rulesAttributes)) {
        const clientFields = firebaseAttributes[table];
        assert.ok(clientFields, `rules declare unknown table "${table}"`);

        const missing = clientFields.filter((field) => !ruleFields.includes(field));

        // This is the assertion that matters. A field the client sends but the rules
        // omit does not get stripped — it DENIES THE WHOLE WRITE, and the user's data
        // silently stops syncing.
        assert.deepStrictEqual(
            missing,
            [],
            `firestore.rules allowedFields("${table}") is missing ${JSON.stringify(missing)}. ` +
                'A write containing these fields would be denied in full.'
        );
    }
});

test('firestore.rules adds nothing beyond the declared Firebase-only fields', () => {
    for (const [table, ruleFields] of Object.entries(rulesAttributes)) {
        const allowed = new Set([
            ...(firebaseAttributes[table] || []),
            ...(FIREBASE_ONLY_FIELDS[table] || []),
        ]);

        const unexpected = ruleFields.filter((field) => !allowed.has(field));

        assert.deepStrictEqual(
            unexpected,
            [],
            `firestore.rules allows ${JSON.stringify(unexpected)} on "${table}" with no ` +
                'entry in FIREBASE_ONLY_FIELDS. Widening the write surface must be deliberate.'
        );
    }
});

test('every owner-scoped table in the rules is one the layout actually declares', () => {
    const ownerScoped = [
        'wallets', 'payees', 'categories', 'transactions', 'recurring_plans',
        'budgets', 'budget_periods', 'recurring_installments', 'automations',
        'device_tokens',
    ];

    assert.deepStrictEqual(sorted(Object.keys(rulesAttributes)), sorted(ownerScoped));
});

test('current_balance is create-only in both the adapter and the rules', () => {
    const adapter = read('frontend/src/backend/firebase/cloudAttributes.ts');
    const rules = read('firebase/firestore.rules');

    assert.match(
        adapter,
        /CLOUD_CREATE_ONLY_ATTRIBUTES[\s\S]{0,200}wallets:\s*\['current_balance'\]/,
        'the adapter must keep wallets.current_balance create-only'
    );
    assert.match(
        rules,
        /function createOnlyFields\(c\)[\s\S]{0,200}'current_balance'/,
        'the rules must keep wallets.current_balance create-only'
    );
});
