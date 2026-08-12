/**
 * Firestore Security Rules tests.
 *
 * ⚠️  STATUS: WRITTEN, NOT YET RUN. ⚠️
 *
 * These need two things this environment does not have:
 *   - `@firebase/rules-unit-testing` (not installed; `npm i -D` in firebase/functions)
 *   - the Firestore emulator running
 *
 * To run:
 *     cd firebase/functions && npm install
 *     cd .. && firebase emulators:exec --only firestore \
 *         "node --test functions/__tests__/firestore.rules.test.js"
 *
 * Every assertion below maps to a specific contract point, and each has a NEGATIVE
 * case. Negative cases are the point: a rules suite that only proves the happy path
 * passes just as well against `allow read, write: if true`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let testing;
try {
    testing = require('@firebase/rules-unit-testing');
} catch {
    testing = null;
}

/**
 * `emulators:exec` sets FIRESTORE_EMULATOR_HOST for the child process. Having the
 * package installed is NOT sufficient — without a live emulator every connection
 * hangs and then fails, which reads as 17 broken rules rather than 17 unrun ones.
 * Both conditions are required, and the skip says which one is missing.
 */
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';

const PROJECT_ID = 'unity-finance-rules-test';
const RULES = path.resolve(__dirname, '..', '..', 'firestore.rules');

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let env;

test.before(async (t) => {
    if (!testing) {
        t.skip('@firebase/rules-unit-testing is not installed — see the header');
        return;
    }
    if (!EMULATOR_HOST) {
        t.skip('Firestore emulator is not running — use `npm run test:rules`');
        return;
    }

    env = await testing.initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: { rules: fs.readFileSync(RULES, 'utf8') },
    });
});

test.after(async () => {
    if (env) await env.cleanup();
});

const skipIfNoEmulator = (t) => {
    if (!env) {
        t.skip(
            testing
                ? 'Firestore emulator is not running — use `npm run test:rules`'
                : '@firebase/rules-unit-testing is not installed'
        );
        return true;
    }
    return false;
};

const alice = () => env.authenticatedContext(ALICE).firestore();
const bob = () => env.authenticatedContext(BOB).firestore();
const anon = () => env.unauthenticatedContext().firestore();

/** A valid wallet create payload — the shape the Firebase data adapter produces. */
const walletPayload = (uid, serverTimestamp) => ({
    name: 'Cash',
    type: 'cash',
    current_balance: 100,
    currency: 'USD',
    user_id: uid,
    _createdAt: serverTimestamp,
    _updatedAt: serverTimestamp,
    _deletedAt: null,
});

// ---------------------------------------------------------------------------
// §14 — user-owned data
// ---------------------------------------------------------------------------

test('a user can write their own wallet', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { serverTimestamp } = require('firebase/firestore');
    const { doc, setDoc } = require('firebase/firestore');

    await testing.assertSucceeds(
        setDoc(
            doc(alice(), `users/${ALICE}/wallets/w1`),
            walletPayload(ALICE, serverTimestamp())
        )
    );
});

test('User A CANNOT write into User B\'s path', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');

    await testing.assertFails(
        setDoc(doc(alice(), `users/${BOB}/wallets/w1`), walletPayload(BOB, serverTimestamp()))
    );
});

test('User A CANNOT read User B\'s wallets', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, getDoc } = require('firebase/firestore');
    await testing.assertFails(getDoc(doc(alice(), `users/${BOB}/wallets/w1`)));
});

test('an unauthenticated client can do nothing', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, getDoc } = require('firebase/firestore');
    await testing.assertFails(getDoc(doc(anon(), `users/${ALICE}/wallets/w1`)));
});

test('user_id cannot be spoofed on create', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');

    // Alice writes into her own path but claims Bob owns the row. This is the
    // Firestore equivalent of `sanitized.user_id = userId` (finance_sync:327).
    await testing.assertFails(
        setDoc(doc(alice(), `users/${ALICE}/wallets/w2`), walletPayload(BOB, serverTimestamp()))
    );
});

test('an unknown field is rejected rather than silently stored', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');

    await testing.assertFails(
        setDoc(doc(alice(), `users/${ALICE}/wallets/w3`), {
            ...walletPayload(ALICE, serverTimestamp()),
            not_a_real_field: 'x',
        })
    );
});

test('an unknown SUBCOLLECTION cannot be created', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');

    await testing.assertFails(
        setDoc(doc(alice(), `users/${ALICE}/arbitrary_junk/x`), {
            user_id: ALICE,
            _createdAt: serverTimestamp(),
            _updatedAt: serverTimestamp(),
            _deletedAt: null,
        })
    );
});

test('current_balance is create-only (CLOUD_CREATE_ONLY_ATTRIBUTES)', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc, updateDoc, serverTimestamp } = require('firebase/firestore');

    await env.withSecurityRulesDisabled(async (context) => {
        const { doc: adminDoc, setDoc: adminSet } = require('firebase/firestore');
        await adminSet(adminDoc(context.firestore(), `users/${ALICE}/wallets/w4`), {
            ...walletPayload(ALICE, new Date()),
        });
    });

    await testing.assertFails(
        updateDoc(doc(alice(), `users/${ALICE}/wallets/w4`), {
            current_balance: 999999,
            _updatedAt: serverTimestamp(),
        })
    );

    // A normal field on the same document still updates fine.
    await testing.assertSucceeds(
        updateDoc(doc(alice(), `users/${ALICE}/wallets/w4`), {
            name: 'Renamed',
            _updatedAt: serverTimestamp(),
        })
    );
    void setDoc;
});

test('hard delete is refused — deletion must be a tombstone', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, deleteDoc } = require('firebase/firestore');
    await testing.assertFails(deleteDoc(doc(alice(), `users/${ALICE}/wallets/w4`)));
});

// ---------------------------------------------------------------------------
// §15/§16 — shared collections
// ---------------------------------------------------------------------------

test('server-managed collections reject every client write', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc } = require('firebase/firestore');

    for (const collection of ['friends', 'friend_requests', 'split_expenses', 'split_members']) {
        await testing.assertFails(
            setDoc(doc(alice(), `${collection}/x`), { participantIds: [ALICE] })
        );
    }
});

test('a non-participant cannot read a split', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, getDoc, setDoc } = require('firebase/firestore');

    await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'split_expenses/s1'), {
            participantIds: [ALICE],
            total_amount: 100,
        });
    });

    await testing.assertSucceeds(getDoc(doc(alice(), 'split_expenses/s1')));
    await testing.assertFails(getDoc(doc(bob(), 'split_expenses/s1')));
});

test('split_operations is unreachable from any client', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, getDoc, setDoc } = require('firebase/firestore');

    await testing.assertFails(getDoc(doc(alice(), 'split_operations/op1')));
    await testing.assertFails(setDoc(doc(alice(), 'split_operations/op1'), { status: 'x' }));
});

test('public_profiles cannot be enumerated by a client', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { collection, getDocs } = require('firebase/firestore');

    // This is the assertion that stops the fork introducing an exposure Appwrite
    // does not have: a readable public_profiles would leak every user's email.
    await testing.assertFails(getDocs(collection(alice(), 'public_profiles')));
});

// ---------------------------------------------------------------------------
// notifications — the one partial-write case (DEC-OPEN-1)
// ---------------------------------------------------------------------------

test('a notification owner may update ONLY is_read/read_at', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc, updateDoc } = require('firebase/firestore');

    await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'notifications/n1'), {
            user_id: ALICE,
            title: 'Hello',
            body: 'World',
            is_read: false,
            read_at: null,
            participantIds: [ALICE],
        });
    });

    await testing.assertSucceeds(
        updateDoc(doc(alice(), 'notifications/n1'), {
            is_read: true,
            read_at: new Date().toISOString(),
        })
    );

    // Rewriting the body would let a user forge the content of their own inbox.
    await testing.assertFails(updateDoc(doc(alice(), 'notifications/n1'), { title: 'Forged' }));

    // And someone else's notification is invisible either way.
    await testing.assertFails(updateDoc(doc(bob(), 'notifications/n1'), { is_read: true }));
});

test('clients cannot create notifications', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc } = require('firebase/firestore');
    await testing.assertFails(
        setDoc(doc(alice(), 'notifications/forged'), { user_id: ALICE, title: 'x' })
    );
});

// ---------------------------------------------------------------------------
// §51 — entitlement
// ---------------------------------------------------------------------------

test('a user cannot make themselves Pro', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc } = require('firebase/firestore');

    // The Firebase replacement for Appwrite's HMAC over prefs: not "forgery is
    // detectable", but "the write does not happen".
    await testing.assertFails(
        setDoc(doc(alice(), `users/${ALICE}`), { prefs: { plan: 'pro' } }, { merge: true })
    );
});

test('a user CAN still update ordinary preferences', async (t) => {
    if (skipIfNoEmulator(t)) return;

    const { doc, setDoc } = require('firebase/firestore');

    await testing.assertSucceeds(
        setDoc(doc(alice(), `users/${ALICE}`), { prefs: { theme: 'dark' } }, { merge: true })
    );
});

assert.ok(true); // keep the module valid when every test skips
