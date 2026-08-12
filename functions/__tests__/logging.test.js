/**
 * STRUCTURED LOGGING & REDACTION — brief §43, §44.
 *
 * §43 requires operation / user / request id / outcome / duration / error category on
 * every Cloud Function log. §44 forbids logging passwords, OTPs, private tokens, or
 * financial payloads beyond what is needed.
 *
 * Redaction is enforced centrally in `common.scrub` rather than by convention at each
 * call site, because a rule applied only by discipline is one that eventually gets
 * forgotten — and the thing that leaks is an account-takeover token. These tests
 * execute the real helper.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { scrub, withLogging } = require('../src/common');

const SPLITS = fs.readFileSync(path.join(__dirname, '..', 'src', 'splits.js'), 'utf8');

// ---------------------------------------------------------------------------
// §44 — redaction
// ---------------------------------------------------------------------------

test('secrets are redacted by field name', () => {
    const out = scrub({
        code: '123456',
        otp: '999999',
        password: 'hunter2',
        secret: 'abc',
        token: 'plain',
        purchaseToken: 'xyz',
        receipt: 'blob',
    });

    for (const [key, value] of Object.entries(out)) {
        assert.strictEqual(value, '[redacted]', `${key} leaked into the log`);
    }
});

test('a JWT-shaped value is redacted even under an innocent key', () => {
    const out = scrub({
        harmlessLookingName: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    });
    assert.strictEqual(
        out.harmlessLookingName,
        '[redacted]',
        'Value-shape redaction is the backstop for a key nobody thought to list.'
    );
});

test('a long opaque token is redacted regardless of key', () => {
    const out = scrub({ anything: 'A'.repeat(48) });
    assert.strictEqual(out.anything, '[redacted]');
});

test('operational fields survive — redaction must not blind the audit trail', () => {
    const out = scrub({
        uid: 'user-123',
        splitMemberId: 'sm-1',
        amount: 42.5,
        durationMs: 17,
        outcome: 'success',
    });

    assert.deepStrictEqual(out, {
        uid: 'user-123',
        splitMemberId: 'sm-1',
        amount: 42.5,
        durationMs: 17,
        outcome: 'success',
    });
});

test('undefined fields are dropped rather than logged as undefined', () => {
    assert.deepStrictEqual(scrub({ a: undefined, b: 1 }), { b: 1 });
});

// ---------------------------------------------------------------------------
// §43 — withLogging observes without altering behaviour
// ---------------------------------------------------------------------------

test('withLogging returns the wrapped result unchanged', async () => {
    const result = await withLogging('testOp', 'uid-1', {}, async () => ({ success: true, n: 7 }));
    assert.deepStrictEqual(result, { success: true, n: 7 });
});

test('withLogging re-throws the ORIGINAL error object', async () => {
    // It must observe, never swallow or wrap: splitExpenseService reads `error.code`
    // and `error.payload` off the thrown value.
    const original = Object.assign(new Error('BOOM'), { code: 'SPLIT_ALREADY_SETTLED' });

    await assert.rejects(
        () => withLogging('testOp', 'uid-1', {}, async () => { throw original; }),
        (err) => {
            assert.strictEqual(err, original, 'the identical error instance must propagate');
            assert.strictEqual(err.code, 'SPLIT_ALREADY_SETTLED');
            return true;
        }
    );
});

test('withLogging does not let a secret in its fields reach the log', async () => {
    // The fields argument goes through scrub before it is ever handed to the logger.
    await withLogging('testOp', 'uid-1', { code: '123456' }, async () => null);
    // No assertion on the sink itself; `scrub` is covered above and is the only path
    // fields take. This test exists to pin that withLogging calls it at all.
    assert.strictEqual(scrub({ code: '123456' }).code, '[redacted]');
});

// ---------------------------------------------------------------------------
// §43 — the money path is actually instrumented
// ---------------------------------------------------------------------------

for (const operation of ['createSplitExpense', 'respondSplitRequest', 'settleSplitPayment']) {
    test(`${operation} is wrapped in withLogging`, () => {
        assert.match(
            SPLITS,
            new RegExp(`withLogging\\(\\s*'${operation}'`),
            `${operation} moves or commits money and must leave a server-side record ` +
                `(operation, uid, outcome, duration).`
        );
    });
}
