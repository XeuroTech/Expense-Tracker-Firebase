/**
 * ERROR CONTRACT PARITY — brief §41, §42.
 *
 * §41: every Firebase failure mode must map to a controlled, provider-neutral error,
 *      and raw Firebase internals must not reach the UI.
 * §42: equivalent domain meanings must produce the SAME application-level error from
 *      both adapters (Appwrite "unauthorized" ≡ Firebase "permission-denied").
 *
 * WHY THIS IS NOT COSMETIC
 * ------------------------
 * The two legacy shapes are load-bearing and INCOMPATIBLE:
 *
 *   finance-sync path      error.code = HTTP status NUMBER, message = domain code
 *   function-wrapper path  error.code = domain code STRING, error.status = HTTP
 *
 * `syncService.ts:1190-1197` branches on `getErrorCode(error) === 403 && message ===
 * 'PRO_PLAN_REQUIRED'`. That is CONTROL FLOW, not error handling (C-ERR-2). If the
 * finance translator emitted the string 'permission-denied' as `code`, a downgraded
 * user's sync would fail forever instead of cleanly disabling cloud sync.
 *
 * These assertions read the real source, so they fail if either translator is
 * "tidied up" into a single shared shape.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', '..', '..', 'frontend', 'src');
const FB = path.join(SRC, 'backend', 'firebase');

/**
 * This suite compares the frontend's Appwrite and Firebase error translators, which
 * live in the separate frontend repo since the Firebase backend split
 * (BACKEND_MIGRATION_PROGRESS.md). It cannot run meaningfully from this backend-only
 * repo in isolation — skip cleanly rather than fail on a directory absent by design.
 * Run from a checkout with both repos as siblings to get real parity coverage.
 */
if (!fs.existsSync(SRC)) {
    test('error contract parity checks (SKIPPED — frontend/ is not part of this standalone backend repo)', (t) => {
        t.skip('This repo is backend-only by design; these checks need the frontend repo as a sibling directory.');
    });
    return;
}

const errorsSource = fs.readFileSync(path.join(FB, 'errors.ts'), 'utf8');
const coreErrorsSource = fs.readFileSync(path.join(SRC, 'backend', 'core', 'errors.ts'), 'utf8');

/** Extracts a `Record<string, number>` literal as real data. */
const parseStatusMap = (name) => {
    const block = errorsSource.match(
        new RegExp(`const ${name}: Record<string, number> = \\{([\\s\\S]*?)\\};`)
    );
    assert.ok(block, `Could not parse ${name} from errors.ts`);

    const map = {};
    for (const line of block[1].split('\n')) {
        const m = line.match(/'?([a-zA-Z/-]+)'?\s*:\s*(\d+)/);
        if (m) map[m[1]] = Number(m[2]);
    }
    return map;
};

const GRPC = parseStatusMap('GRPC_TO_HTTP');
const AUTH = parseStatusMap('AUTH_CODE_TO_HTTP');

// ---------------------------------------------------------------------------
// §41 — every listed failure mode is mapped
// ---------------------------------------------------------------------------

/** The exact list enumerated in brief §41, with the status each must produce. */
const REQUIRED_BY_BRIEF = {
    unauthenticated: 401,
    'permission-denied': 403,
    'not-found': 404,
    'already-exists': 409,
    'failed-precondition': 400,
    aborted: 409,
    'resource-exhausted': 429,
    'deadline-exceeded': 504,
    unavailable: 503,
};

for (const [code, expected] of Object.entries(REQUIRED_BY_BRIEF)) {
    test(`§41: "${code}" maps to a controlled status`, () => {
        assert.ok(
            code in GRPC,
            `"${code}" is unmapped, so it would surface to the UI as a raw Firebase error.`
        );
        assert.strictEqual(
            GRPC[code],
            expected,
            `"${code}" maps to ${GRPC[code]}, expected ${expected}.`
        );
    });
}

test('§41: auth failures are mapped, not leaked', () => {
    // These are the codes a user can actually trigger from the login/register screens.
    for (const code of [
        'auth/invalid-email',
        'auth/user-not-found',
        'auth/wrong-password',
        'auth/invalid-credential',
        'auth/email-already-in-use',
        'auth/weak-password',
        'auth/too-many-requests',
        'auth/network-request-failed',
    ]) {
        assert.ok(code in AUTH, `${code} is unmapped — the raw SDK string would reach the UI.`);
    }

    assert.strictEqual(AUTH['auth/email-already-in-use'], 409);
    assert.strictEqual(AUTH['auth/too-many-requests'], 429);
});

// ---------------------------------------------------------------------------
// The two legacy shapes must stay DIFFERENT
// ---------------------------------------------------------------------------

test('toFinanceSyncError emits error.code as the HTTP status NUMBER', () => {
    const fn = errorsSource.match(
        /export const toFinanceSyncError[\s\S]*?^\};/m
    );
    assert.ok(fn, 'toFinanceSyncError not found');
    assert.match(
        fn[0],
        /legacyCode:\s*status/,
        'toFinanceSyncError must set legacyCode to the numeric status — syncService.ts:1190 ' +
            'compares it against 403 to drive the Pro-downgrade path (C-ERR-2).'
    );
    assert.match(
        fn[0],
        /message\s*=\s*domainCode/,
        'The finance shape puts the DOMAIN CODE in `message`; syncService matches on it.'
    );
});

test('toFunctionError emits error.code as the domain code STRING', () => {
    const fn = errorsSource.match(/export const toFunctionError[\s\S]*?^\};/m);
    assert.ok(fn, 'toFunctionError not found');
    assert.match(
        fn[0],
        /legacyCode:\s*domainCode/,
        'toFunctionError must set legacyCode to the domain string — friendshipService and ' +
            'notificationService read error.code as a string.'
    );
    assert.match(fn[0], /status,/, 'toFunctionError must also carry the HTTP status separately.');
});

test('the two translators are genuinely distinct', () => {
    // A refactor that collapses them into one would silently break one of the two
    // consumers, and nothing else in the suite would notice.
    assert.notStrictEqual(
        errorsSource.indexOf('export const toFinanceSyncError'),
        errorsSource.indexOf('export const toFunctionError'),
        'Both translators must exist separately.'
    );
});

// ---------------------------------------------------------------------------
// §42 — equivalent domain meaning, equivalent neutral error
// ---------------------------------------------------------------------------

test('§42: the Pro gate produces the same classification on both providers', () => {
    assert.match(
        errorsSource,
        /if \(domainCode === 'PRO_PLAN_REQUIRED'\) return 'pro_required'/,
        'PRO_PLAN_REQUIRED must classify as pro_required regardless of transport status.'
    );
    assert.match(
        errorsSource,
        /if \(domainCode === 'SUBSCRIPTION_EXPIRED'\) return 'subscription_expired'/
    );

    // And the shared predicate both providers are read through must be intact.
    assert.match(
        coreErrorsSource,
        /getErrorCode\(error\) === 403 &&[\s\S]{0,200}PRO_PLAN_REQUIRED[\s\S]{0,120}SUBSCRIPTION_EXPIRED/,
        'isProGateError must keep matching the exact (403, domain-code) pair.'
    );
});

test('§42: domain codes pass through verbatim', () => {
    // Renaming a domain code silently changes the copy the user reads, because the UI
    // maps these strings to messages.
    assert.match(
        errorsSource,
        /\/\^\[A-Z\]\[A-Z0-9_\]\{2,\}\$\//,
        'extractDomainCode must recognise SCREAMING_SNAKE_CASE domain codes.'
    );
    assert.ok(
        !/domainCode\s*=\s*domainCode\.toLowerCase\(\)|\.replace\([^)]*domainCode/.test(errorsSource),
        'Domain codes must never be rewritten.'
    );
});

// ---------------------------------------------------------------------------
// §41 — no adapter may leak a raw Firebase error
// ---------------------------------------------------------------------------

test('§41: every Firebase adapter routes failures through a translator', () => {
    const adapters = fs
        .readdirSync(FB)
        .filter((f) => f.endsWith('Adapter.ts'));

    assert.ok(adapters.length >= 8, `Expected the full adapter set, found ${adapters.length}`);

    for (const name of adapters) {
        const source = fs.readFileSync(path.join(FB, name), 'utf8');
        const hasTryCatch = /catch\s*\(/.test(source);
        if (!hasTryCatch) continue;

        assert.ok(
            /toFunctionError|toFinanceSyncError|BackendError/.test(source),
            `${name} catches errors but never constructs a neutral error — a raw ` +
                `FirebaseError would reach the UI (§41).`
        );
    }
});

test('§41: the callable wrapper normalises BOTH failure channels', () => {
    const callables = fs.readFileSync(path.join(FB, 'callables.ts'), 'utf8');

    // Channel 1: a rejected promise (HttpsError).
    assert.match(callables, /catch \(error\)[\s\S]{0,200}toFunctionError/);
    // Channel 2: `{ success: false, error: 'CODE' }` inside a 200 response — the shape
    // the ported Appwrite functions use.
    assert.match(callables, /data\.success === false/);
    // And the envelope must be preserved for the split retry/reconciliation hints.
    assert.match(
        callables,
        /payload:\s*data/,
        'The raw envelope must be attached; splitExpenseService reads error.payload.retryAfterMs.'
    );
});
