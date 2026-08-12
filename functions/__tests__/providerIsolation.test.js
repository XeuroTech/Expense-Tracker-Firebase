/**
 * PROVIDER ISOLATION — brief §4, §5, §67.
 *
 * WHAT THIS PROVES
 * ----------------
 * §4 requires that with Appwrite selected no Firebase operation is triggered, and
 * vice versa. §5 requires that neither backend receives duplicate writes. §67 forbids
 * an automatic mid-operation fallback from one provider to the other.
 *
 * Those are runtime properties, but the thing that MAKES them true is static:
 *
 *   1. Every raw Appwrite SDK call in the eight seam files sits behind a
 *      `BACKEND_PROVIDER` guard, so a Firebase build cannot reach Appwrite.
 *   2. No seam file STATICALLY imports the Firebase tree, so an Appwrite build never
 *      even evaluates the Firebase SDK (no app init, no auth persistence opened).
 *   3. No call site writes both providers — the branches are `if/else`, never
 *      sequential.
 *
 * This suite checks all three by parsing the real source. It is deliberately a
 * SNAPSHOT of the Appwrite call-site count: adding a new unguarded Appwrite call
 * changes the count and fails here, which forces a re-audit rather than letting a
 * cross-provider leak land silently.
 *
 * It needs no emulator, no network and no install.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', '..', '..', 'frontend', 'src');

/**
 * Every check in this suite reads the frontend's seam files, which live in the
 * separate frontend repo since the Firebase backend split
 * (BACKEND_MIGRATION_PROGRESS.md). It cannot run meaningfully from this
 * backend-only repo in isolation — skip cleanly rather than fail on a directory
 * absent by design. Run from a checkout with both repos as siblings to get real
 * isolation coverage.
 */
if (!fs.existsSync(SRC)) {
    test('provider isolation checks (SKIPPED — frontend/ is not part of this standalone backend repo)', (t) => {
        t.skip('This repo is backend-only by design; these checks need the frontend repo as a sibling directory.');
    });
    return;
}

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Raw provider-SDK calls, as opposed to calls that already go through a port.
 * `appwriteConfig.endpoint` counts because it is a hard-coded Appwrite host used by
 * a plain `fetch` (timeService, and the chunked web upload).
 */
const APPWRITE_CALL = /account\.[a-zA-Z]+\(|databases\.[a-zA-Z]+\(|functions\.createExecution\(|storage\.[a-zA-Z]+\(|client\.subscribe\(|appwriteConfig\.endpoint/g;

const GUARD = /BACKEND_PROVIDER !== 'appwrite'|!isAppwriteProvider/g;

const count = (source, re) => (source.match(re) || []).length;

/**
 * The eight seams, with the EXACT number of raw Appwrite call sites each is expected
 * to retain. Every one of these lives on the Appwrite side of a guard.
 *
 * If you add an Appwrite call, this number must be updated *and* the new call must be
 * guarded — that is the point of pinning it.
 */
const SEAMS = [
    { file: 'context/AuthContext.tsx', appwriteCalls: 10, minGuards: 8 },
    { file: 'hooks/useRealtime.ts', appwriteCalls: 1, minGuards: 1 },
    { file: 'hooks/useStorage.ts', appwriteCalls: 2, minGuards: 2 },
    { file: 'hooks/useUpdateProfile.ts', appwriteCalls: 5, minGuards: 3 },
    { file: 'services/friendshipService.ts', appwriteCalls: 1, minGuards: 7 },
    { file: 'services/notificationService.ts', appwriteCalls: 4, minGuards: 6 },
    { file: 'services/splitExpenseService.ts', appwriteCalls: 4, minGuards: 4 },
    { file: 'services/timeService.ts', appwriteCalls: 2, minGuards: 1 },
];

// ---------------------------------------------------------------------------
// 1. Every seam is guarded
// ---------------------------------------------------------------------------

for (const seam of SEAMS) {
    test(`${seam.file} routes through a provider guard`, () => {
        const source = read(seam.file);

        // Both relative (`../backend/config`) and alias (`@/src/backend/config`)
        // forms are in use across the codebase.
        assert.ok(
            /from '((\.\.\/)+|@\/src\/)backend\/config'/.test(source),
            `${seam.file} must import BACKEND_PROVIDER — without it every call is unconditionally Appwrite.`
        );

        const guards = count(source, GUARD);
        assert.ok(
            guards >= seam.minGuards,
            `${seam.file} has ${guards} provider guards, expected at least ${seam.minGuards}. ` +
                `A removed guard means a Firebase build silently calls Appwrite.`
        );
    });

    test(`${seam.file} has no NEW unguarded Appwrite call`, () => {
        const source = read(seam.file);
        const actual = count(source, APPWRITE_CALL);

        assert.strictEqual(
            actual,
            seam.appwriteCalls,
            `${seam.file} has ${actual} raw Appwrite call sites, expected ${seam.appwriteCalls}. ` +
                `If you added one, confirm it is inside a BACKEND_PROVIDER branch and update this number. ` +
                `An unguarded call is a cross-provider leak (§4).`
        );
    });
}

// ---------------------------------------------------------------------------
// 2. An Appwrite build must never EVALUATE the Firebase tree
// ---------------------------------------------------------------------------

test('no seam file statically imports the Firebase SDK or provider tree', () => {
    // A static `import` is hoisted and evaluated at module load regardless of any
    // runtime branch. That would initialise the Firebase app — and open auth
    // persistence — inside a pure Appwrite build. Lazy `require` inside the guarded
    // branch is the only acceptable form.
    const staticFirebaseImport = /^\s*import\s[^;]*\sfrom\s+'(firebase\/[^']*|(\.\.\/)+backend\/firebase[^']*)'/m;

    for (const seam of SEAMS) {
        const source = read(seam.file);
        assert.ok(
            !staticFirebaseImport.test(source),
            `${seam.file} statically imports Firebase. Use a lazy require inside the guard instead.`
        );
    }
});

test('the lazy port accessors do not statically import either provider', () => {
    for (const file of ['backend/activePort.ts', 'backend/dataPort.ts']) {
        const source = read(file);
        const staticAdapterImport =
            /^\s*import\s[^;]*\sfrom\s+'\.\/(appwrite|firebase)\/[^']*'/m;

        assert.ok(
            !staticAdapterImport.test(source),
            `${file} statically imports a provider adapter. That defeats both the ` +
                `cycle break and provider isolation.`
        );
        assert.ok(
            /require\(/.test(source),
            `${file} must resolve adapters with a lazy require.`
        );
    }
});

test('the Appwrite adapter tree never references the Firebase tree', () => {
    const dir = path.join(SRC, 'backend', 'appwrite');
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        const source = fs.readFileSync(path.join(dir, name), 'utf8');
        assert.ok(
            !/backend\/firebase|from 'firebase\//.test(source) && !/\.\.\/firebase\//.test(source),
            `backend/appwrite/${name} references the Firebase tree.`
        );
    }
});

// ---------------------------------------------------------------------------
// 3. No dual-write (§5, §67)
// ---------------------------------------------------------------------------

test('every provider branch returns — no path reaches both backends', () => {
    // The hazard §5/§67 describes is a branch that calls the port and then FALLS
    // THROUGH into the Appwrite call, writing both backends. Each guard must
    // terminate its branch with `return`/`throw`, or assign via a ternary.
    for (const seam of SEAMS) {
        const source = read(seam.file);
        const lines = source.split('\n');

        lines.forEach((line, i) => {
            if (!/BACKEND_PROVIDER !== 'appwrite'|!isAppwriteProvider/.test(line)) return;
            // Ternary form: `cond ? portCall() : appwriteCall()` is exclusive by construction.
            if (line.includes('?') || line.trim().startsWith('const') || line.trim().startsWith('return')) return;

            // Three exclusive forms are acceptable:
            //   - the branch returns or throws
            //   - the branch is closed by `} else {`, which is exclusive by construction
            //   - a ternary (handled above)
            const block = lines.slice(i, i + 16).join('\n');
            assert.ok(
                /\breturn\b|\bthrow\b|\}\s*else\s*\{/.test(block),
                `${seam.file}:${i + 1} — a provider guard with no return/throw/else can fall ` +
                    `through into the Appwrite call and write BOTH backends (§5).`
            );
        });
    }
});

test('the provider default is appwrite for unset, empty and unknown values', () => {
    const source = read('backend/config.ts');

    assert.match(
        source,
        /const DEFAULT_PROVIDER: BackendProviderName = 'appwrite'/,
        'The rollback path (§66) requires appwrite to be the default.'
    );
    assert.match(
        source,
        /if \(!raw\) return DEFAULT_PROVIDER/,
        'An unset EXPO_PUBLIC_BACKEND_PROVIDER must resolve to appwrite.'
    );
    assert.match(
        source,
        /if \(!isKnownProvider\(raw\)\)[\s\S]{0,400}return DEFAULT_PROVIDER/,
        'An unrecognised provider value must fall back to appwrite, not throw or pick firebase.'
    );
});

test('registry refuses to silently substitute a provider', () => {
    const source = read('backend/registry.ts');
    assert.match(
        source,
        /default:\s*\{[\s\S]{0,200}throw new Error/,
        'An unknown provider must throw, never default to the other backend (§67).'
    );
});
