/**
 * FIRESTORE INDEX COVERAGE — brief §47.
 *
 * "Do not leave production queries dependent on manually discovering missing indexes
 * at runtime."
 *
 * A Firestore composite query with no matching index does not degrade — it throws
 * FAILED_PRECONDITION. For this app that means: friends list blank, notifications
 * blank, or — worst — the split create/respond RECONCILIATION path failing, which is
 * the path that decides whether a timed-out money operation already happened. A
 * missing index there turns "recover safely" into "user retries and may duplicate".
 *
 * This suite derives the required indexes from how the adapters actually BUILD their
 * queries, then asserts firestore.indexes.json covers each one. It caught two real
 * gaps when the split reconcile path was routed through DataPort.
 *
 * No emulator, no network, no install.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FIREBASE_DIR = path.resolve(__dirname, '..', '..');
const SRC = path.resolve(FIREBASE_DIR, '..', 'frontend', 'src');

const indexes = JSON.parse(
    fs.readFileSync(path.join(FIREBASE_DIR, 'firestore.indexes.json'), 'utf8')
).indexes || [];

const pathsSource = fs.readFileSync(path.join(SRC, 'backend', 'firebase', 'paths.ts'), 'utf8');

/**
 * Parses SHARED_SCOPE_FIELD out of paths.ts rather than hard-coding it, so a change
 * to the scoping strategy is reflected here automatically instead of silently
 * invalidating these assertions.
 */
const parseSharedScopeFields = () => {
    const block = pathsSource.match(
        /export const SHARED_SCOPE_FIELD: Record<string, string> = \{([\s\S]*?)\};/
    );
    assert.ok(block, 'Could not parse SHARED_SCOPE_FIELD from paths.ts');

    // Keys are computed from the collection-id map: `[C.notifications]: 'user_id'`.
    const map = {};
    for (const line of block[1].split('\n')) {
        const m = line.match(/\[\s*C\.([a-z_]+)\s*\]\s*:\s*'([a-zA-Z_]+)'/);
        if (m) map[m[1]] = m[2];
    }
    assert.ok(
        Object.keys(map).length >= 5,
        `Parsed only ${Object.keys(map).length} scope fields from paths.ts — the parser is ` +
            `out of date, which would make every assertion below silently check the wrong field.`
    );

    // The default arm: any shared table not named explicitly uses participantIds.
    return map;
};

const SHARED_SCOPE = parseSharedScopeFields();

/** A declared index covers a query if it contains every required field path. */
const covers = (collectionGroup, fields) =>
    indexes.some(
        (idx) =>
            idx.collectionGroup === collectionGroup &&
            fields.every((f) => (idx.fields || []).some((x) => x.fieldPath === f))
    );

const assertCovered = (collectionGroup, fields, why) => {
    assert.ok(
        covers(collectionGroup, fields),
        `MISSING INDEX for ${collectionGroup} [${fields.join(', ')}]\n  ${why}\n` +
            `  Add it to firestore.indexes.json — at runtime this throws FAILED_PRECONDITION.`
    );
};

// ---------------------------------------------------------------------------
// SHARED_SCOPE_FIELD is the contract these assertions rest on
// ---------------------------------------------------------------------------

test('SHARED_SCOPE_FIELD parses and covers the shared collections', () => {
    assert.strictEqual(SHARED_SCOPE.notifications, 'user_id');
    assert.strictEqual(SHARED_SCOPE.split_members, 'member_user_id');
});

// ---------------------------------------------------------------------------
// DataPort.list — dataAdapter.ts:390,408
//   scopeConstraints(table, uid) + equalityConstraints(...) + orderBy(documentId())
// ---------------------------------------------------------------------------

const SHARED_TABLES = [
    'friends',
    'friend_requests',
    'split_expenses',
    'split_members',
    'notifications',
];

for (const table of SHARED_TABLES) {
    test(`DataPort.list is indexed for ${table}`, () => {
        const scopeField = SHARED_SCOPE[table] || 'participantIds';
        assertCovered(
            table,
            [scopeField, '_deletedAt', '__name__'],
            `dataAdapter.list builds where(${scopeField}) + where(_deletedAt == null) + orderBy(__name__).`
        );
    });
}

// ---------------------------------------------------------------------------
// RealtimePort.watch — realtimeAdapter.ts:61-90
//   where(scopeField) + where(_updatedAt > sessionFloor)
// ---------------------------------------------------------------------------

for (const table of SHARED_TABLES) {
    test(`RealtimePort.watch is indexed for ${table}`, () => {
        const scopeField = SHARED_SCOPE[table] || 'participantIds';
        assertCovered(
            table,
            [scopeField, '_updatedAt'],
            `realtimeAdapter.watch builds where(${scopeField}) + where(_updatedAt > sessionFloor). ` +
                `Without this the listener never attaches and the UI stops updating live.`
        );
    });
}

// ---------------------------------------------------------------------------
// NotificationPort.list — notificationAdapter.ts:85-87
// ---------------------------------------------------------------------------

test('NotificationPort.list is indexed', () => {
    assertCovered(
        'notifications',
        ['user_id', '_deletedAt', 'created_at'],
        'notificationAdapter.list builds where(user_id) + where(_deletedAt == null) + orderBy(created_at, desc).'
    );
});

// ---------------------------------------------------------------------------
// THE MONEY PATH — split reconciliation via DataPort.list
//
// These are the two gaps this suite actually caught. `reconcileCreateSplitByRequestId`
// and the members lookup now go through DataPort, which ADDS the scope filter and the
// _deletedAt filter and the orderBy(__name__) on top of the service's own equality
// filters. The pre-existing 2-field indexes served the ADMIN-side query only.
// ---------------------------------------------------------------------------

test('split create reconciliation by request_id is indexed', () => {
    assertCovered(
        'split_expenses',
        ['created_by_user_id', 'request_id', 'participantIds', '_deletedAt', '__name__'],
        'splitExpenseService.reconcileCreateSplitByRequestId lists split_expenses by ' +
            'created_by_user_id + request_id; DataPort adds participantIds, _deletedAt and orderBy(__name__). ' +
            'This is the idempotency-recovery path for a timed-out split create (C-SP-3) — ' +
            'if it throws, the client cannot tell whether the money already moved.'
    );
});

test('split members lookup during reconciliation is indexed', () => {
    assertCovered(
        'split_members',
        ['split_expense_id', 'member_user_id', '_deletedAt', '__name__'],
        'The members lookup filters by split_expense_id; DataPort adds the member_user_id ' +
            'scope, _deletedAt and orderBy(__name__).'
    );
});

// ---------------------------------------------------------------------------
// Sanity: the file itself must stay deployable
// ---------------------------------------------------------------------------

test('every declared index is well formed', () => {
    for (const idx of indexes) {
        assert.ok(idx.collectionGroup, 'index missing collectionGroup');
        assert.ok(idx.queryScope, `${idx.collectionGroup}: missing queryScope`);
        assert.ok(
            Array.isArray(idx.fields) && idx.fields.length >= 2,
            `${idx.collectionGroup}: a composite index needs at least 2 fields`
        );
        for (const f of idx.fields) {
            assert.ok(f.fieldPath, `${idx.collectionGroup}: field missing fieldPath`);
            assert.ok(
                f.order || f.arrayConfig,
                `${idx.collectionGroup}.${f.fieldPath}: needs either order or arrayConfig`
            );
        }
    }
});
