/**
 * Shared infrastructure for the Firebase Cloud Functions.
 *
 * The 23 deployed Appwrite Functions are protected and untouched. "Ported" below
 * always means "the Firebase provider has an equivalent", never "the Appwrite one was
 * removed".
 */

const crypto = require('crypto');
const admin = require('firebase-admin');
const { logger } = require('firebase-functions');
const { HttpsError } = require('firebase-functions/v2/https');

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();
const auth = admin.auth();
const messaging = admin.messaging();
const { FieldValue, Timestamp } = admin.firestore;

// ---------------------------------------------------------------------------
// Metadata fields — MUST match frontend/src/backend/firebase/serialize.ts
// ---------------------------------------------------------------------------

const CREATED_AT = '_createdAt';
const UPDATED_AT = '_updatedAt';
const DELETED_AT = '_deletedAt';

/**
 * `_deletedAt: null` is written EXPLICITLY, never left absent.
 *
 * Firestore does not match a missing field against `== null`, so a document written
 * without it would be invisible to every pull. Since the pull result feeds
 * `localDb.removeSyncedMissingFromCloud`, an invisible document is a HARD DELETE of
 * the corresponding local row. Absence here is data loss.
 */
const stamps = () => ({
    [CREATED_AT]: FieldValue.serverTimestamp(),
    [UPDATED_AT]: FieldValue.serverTimestamp(),
    [DELETED_AT]: null,
});

const touch = () => ({ [UPDATED_AT]: FieldValue.serverTimestamp() });

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const STATUS_TO_FUNCTIONS_CODE = {
    400: 'invalid-argument',
    401: 'unauthenticated',
    403: 'permission-denied',
    404: 'not-found',
    409: 'already-exists',
    429: 'resource-exhausted',
    500: 'internal',
    501: 'unimplemented',
    503: 'unavailable',
};

/**
 * Builds the error the client's `toFunctionError` expects.
 *
 * The DOMAIN CODE goes in BOTH `message` and `details.domainCode`, verbatim. The UI
 * maps these strings to user-facing copy (C-FR-1), so renaming one silently changes
 * what a user reads. `message` is the primary channel because it survives every
 * transport; `details` is the belt-and-braces path.
 */
const fail = (domainCode, status = 400, extra = {}) =>
    new HttpsError(STATUS_TO_FUNCTIONS_CODE[status] || 'internal', domainCode, {
        domainCode,
        status,
        ...extra,
    });

// ---------------------------------------------------------------------------
// Auth / entitlement
// ---------------------------------------------------------------------------

/**
 * The uid from the VERIFIED auth context — never from the request body.
 *
 * This is what structurally removes the `email-change-handler` defect, where the
 * Appwrite implementation trusts `userId` from the body and any caller can act as any
 * user. A callable simply has no way to express that mistake.
 */
const requireAuth = (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw fail('Unauthorized', 401);
    return uid;
};

/**
 * Mirrors `requirePro` (finance_sync/src/main.js:143-155) exactly, including the
 * precedence: expired is reported before free.
 *
 * NOTE this gate exists on the SOCIAL/SPLIT callables, which is where Appwrite also
 * applies it. It is deliberately NOT in the Firestore rules for the finance mirror —
 * see the header of firestore.rules.
 */
const requirePro = async (uid) => {
    const snapshot = await db.collection('users').doc(uid).get();
    const prefs = (snapshot.exists && snapshot.data().prefs) || {};

    const plan = prefs.plan === 'pro' ? 'pro' : 'free';
    const status = ['active', 'expired', 'cancelled'].includes(prefs.subscriptionStatus)
        ? prefs.subscriptionStatus
        : 'active';
    const endDate = prefs.subscriptionExpiresAt || prefs.subscriptionEndDate || null;
    const expired = plan === 'pro' && !!endDate && new Date(endDate).getTime() <= Date.now();

    if (status === 'expired' || expired) throw fail('SUBSCRIPTION_EXPIRED', 403);
    if (plan !== 'pro' || status !== 'active') throw fail('PRO_PLAN_REQUIRED', 403);
};

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Order-independent key for a pair of users. Preserves the Appwrite `pair_key`. */
const pairKeyFor = (a, b) => [String(a), String(b)].sort().join('__');

/**
 * Deterministic document id from any number of components.
 *
 * Used for `friend_requests` (from `pair_key`), `split_members` (from
 * `(splitExpenseId, memberUid)`), `split_operations` and `device_tokens`
 * (`sha256(token)`). Truncated to 40 hex characters — well inside Firestore's 1500-byte
 * id limit and far beyond any realistic collision risk.
 */
const deterministicId = (...parts) => sha256(parts.map(String).join('::')).slice(0, 40);

// ---------------------------------------------------------------------------
// Idempotency mutex
// ---------------------------------------------------------------------------

/**
 * Reads a timestamp-like value as epoch millis, whether it is a real Firestore
 * `Timestamp` (has `.toMillis()`) or an ISO string. Returns 0 for anything else
 * (missing, unparsable) so a caller comparing ages treats it as infinitely old
 * rather than throwing.
 */
const toMillis = (value) => {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Phase 3 (Task 1) — how long a `split_operations` mutex may sit `in_progress`
 * before recovery is willing to consider the invocation that created it dead
 * rather than merely slow.
 *
 * Every callable that can pass a `recovery` option below is registered with
 * `onCall({ timeoutSeconds: 120, ... })`. Cloud Functions HARD-KILLS an
 * instance at that ceiling — there is no way for an invocation to still be
 * legitimately running past it. 150s (120s + a 30s margin for clock skew and
 * Firestore write propagation) is therefore a age past which "the process that
 * created this mutex is dead" is a certainty, not a guess.
 */
const MUTEX_STALE_AFTER_MS = 150 * 1000;

/**
 * `split_operations` — the server-side mutex (C-SP-3, C-SP-4).
 *
 * ⚠️  `create()` IS LOAD BEARING. ⚠️
 *
 * It throws ALREADY_EXISTS on collision. `set()` overwrites SILENTLY, which would
 * destroy the mutex entirely and let two concurrent invocations both move money. This
 * is the single most dangerous line in the whole Firebase backend to get wrong, and
 * the two calls differ by one word.
 *
 * A completed operation REPLAYS its stored result rather than re-executing, so a
 * client retry after a network timeout returns the original outcome instead of
 * creating a second split or a second settlement.
 *
 * Phase 3 (Task 1) — optional `recovery` param, `{ checkCompleted, staleAfterMs }`.
 *
 * Omitted (as `createSplitExpense` still does — that mutex's crash-recovery gap is
 * unchanged, out of Phase 3's stated scope): behavior is IDENTICAL to before this
 * param existed.
 *
 * Supplied (as `respondSplitRequest`/`settleSplitPayment` do below): when a
 * collision is hit against a mutex that is neither `completed` nor freshly
 * `in_progress`, this closes the one real gap in the scheme above — a process that
 * crashed or timed out AFTER its Firestore transaction committed but BEFORE the
 * `ref.update({status:'completed',...})` a few lines down could run, leaving the
 * mutex wedged `in_progress` forever with no way for a future retry to tell "already
 * succeeded" apart from "never ran". `checkCompleted()` answers that by reading the
 * ACTUAL financial state the handler would have produced (never the mutex) and
 * returning the reconstructed result if it finds the operation's effect already
 * committed, or `null` if it does not:
 *
 *   - `checkCompleted()` returns a result -> the transaction committed; only the
 *     mutex's own bookkeeping write was lost. Repair that bookkeeping (a plain
 *     `set(...,{merge:true})`, never a `create()`) and return the reconstructed
 *     result. No financial write of any kind happens on this path.
 *   - `checkCompleted()` returns null AND the mutex is older than `staleAfterMs`
 *     -> no trace of this operation exists, and Cloud Functions' own timeout
 *     guarantees whatever created this mutex is dead, not slow. Safe to reclaim:
 *     delete the stale mutex and retry the acquisition from scratch, which lets a
 *     genuinely fresh attempt execute `handler()`.
 *   - `checkCompleted()` returns null AND the mutex is still within `staleAfterMs`
 *     -> ambiguous: this could be a live, legitimately-running call. Recovering now
 *     would race it. Refuse with the ordinary busy code, exactly as if `recovery`
 *     had not been supplied — the caller's existing retry-after-a-moment path
 *     already handles this, and the ambiguity resolves itself (to one of the two
 *     cases above) once enough time passes.
 */
const withOperationMutex = async (operationId, inProgressCode, handler, recovery) => {
    const ref = db.collection('split_operations').doc(operationId);

    try {
        await ref.create({
            status: 'in_progress',
            startedAt: FieldValue.serverTimestamp(),
            ...stamps(),
        });
    } catch (error) {
        if (error.code !== 6 && error.code !== 'already-exists') throw error;

        const existing = await ref.get();
        const data = existing.data() || {};

        if (data.status === 'completed' && data.result) {
            return JSON.parse(data.result);
        }

        if (recovery && data.status === 'in_progress') {
            const reconstructed = await recovery.checkCompleted();

            if (reconstructed) {
                // Case B — bookkeeping repair only. No financial write.
                await ref.set(
                    {
                        status: 'completed',
                        result: JSON.stringify(reconstructed),
                        completedAt: FieldValue.serverTimestamp(),
                        recoveredAt: FieldValue.serverTimestamp(),
                        ...touch(),
                    },
                    { merge: true }
                );
                logEvent('operationMutexRecovery', 'success', { operationId, outcome: 'reconstructed' });
                return reconstructed;
            }

            const ageMs = Date.now() - toMillis(data.startedAt);
            const staleAfterMs = (recovery && recovery.staleAfterMs) || MUTEX_STALE_AFTER_MS;

            if (ageMs >= staleAfterMs) {
                // Case A — no financial trace, and the prior invocation is
                // guaranteed dead (Cloud Functions' own timeoutSeconds ceiling).
                // delete(), never set() — a third, still-live caller racing this
                // same recovery must see a clean create() collision, not a
                // silently overwritten mutex.
                await ref.delete().catch(() => undefined);
                logEvent('operationMutexRecovery', 'success', { operationId, outcome: 'reclaimed', ageMs });
                return withOperationMutex(operationId, inProgressCode, handler, recovery);
            }
            // Case C — ambiguous; fall through to the ordinary busy response.
        }

        throw fail(inProgressCode, 409);
    }

    try {
        const result = await handler();
        await ref.update({
            status: 'completed',
            result: JSON.stringify(result),
            completedAt: FieldValue.serverTimestamp(),
            ...touch(),
        });
        return result;
    } catch (error) {
        // Release the mutex so a corrected retry is possible. A FAILED operation must
        // not wedge the user out of ever retrying — that was the purpose of the
        // `needs_recovery` states in the Appwrite saga, which Firestore transactions
        // make unnecessary because a failed transaction leaves nothing partial behind.
        await ref.delete().catch(() => undefined);
        throw error;
    }
};

// ---------------------------------------------------------------------------
// Firestore transaction retry — ABORTED / contention only
// ---------------------------------------------------------------------------

/** gRPC / Firestore codes that indicate transient transaction contention. */
const RETRYABLE_TRANSACTION_CODES = new Set([
    4,
    10,
    13,
    14,
    'deadline-exceeded',
    'aborted',
    'internal',
    'unavailable',
]);

/** Domain/business errors from `fail()` must never be retried. */
const isHttpsDomainError = (error) => error instanceof HttpsError;

/**
 * True when Firestore aborted a transaction due to lock contention or another
 * transient infrastructure fault — NOT for INSUFFICIENT_BALANCE etc.
 */
const isRetryableTransactionError = (error) => {
    if (!error || isHttpsDomainError(error)) return false;

    const code =
        typeof error.code === 'string' && /^\d+$/.test(error.code) ? Number(error.code) : error.code;
    if (RETRYABLE_TRANSACTION_CODES.has(code)) return true;

    const message = String(error.message || '');
    return (
        message.includes('Transaction lock timeout') ||
        message.includes('ABORTED') ||
        message.includes('contention')
    );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full jitter in [baseDelayMs, cap] — spreads concurrent wallet contenders. */
const computeRetryDelayMs = (attempt, { baseDelayMs, maxDelayMs }) => {
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return baseDelayMs + Math.floor(Math.random() * Math.max(1, cap - baseDelayMs));
};

/**
 * Runs `db.runTransaction` with bounded exponential backoff + jitter for ABORTED
 * / contention errors. Aborted attempts commit nothing; retries reuse the same
 * callback closure (same doc refs, same deterministic txn ids). HttpsError domain
 * failures propagate immediately.
 */
const runTransactionWithRetry = async (updateFunction, options = {}) => {
    const maxAttempts = options.maxAttempts ?? 12;
    const baseDelayMs = options.baseDelayMs ?? 50;
    const maxDelayMs = options.maxDelayMs ?? 1500;
    const transactionOptions = options.transactionOptions;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await db.runTransaction(updateFunction, transactionOptions);
        } catch (error) {
            if (!isRetryableTransactionError(error) || attempt >= maxAttempts) throw error;

            const delayMs = computeRetryDelayMs(attempt, { baseDelayMs, maxDelayMs });
            await sleep(delayMs);
        }
    }
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * ⚠️  FROZEN ARITHMETIC (C-SP-1). ⚠️
 *
 * Verbatim from create_split_expense/src/main.js:67-68. Every amount is converted to
 * integer cents before any arithmetic and back exactly once at the end. Do not
 * "simplify" these — `Math.round(x * 100)` and `Number((c / 100).toFixed(2))` are not
 * interchangeable with the obvious alternatives at the boundaries, and a one-cent
 * divergence from the Appwrite implementation is a defect.
 */
const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (value) => Number((value / 100).toFixed(2));

/** Verbatim from create_split_expense/src/main.js:367 / :438. */
const applyBalanceDelta = (currentBalance, delta) =>
    Number((Number(currentBalance) + Number(delta)).toFixed(2));

/**
 * STRUCTURED LOGGING — brief §43.
 *
 * Every log carries: operation, user, request/event id, outcome, duration and an
 * error CATEGORY. Cloud Logging indexes the jsonPayload, so these are queryable —
 * `jsonPayload.operation="settleSplitPayment" AND jsonPayload.outcome="failure"`.
 *
 * §43 also says what must NEVER be logged: passwords, OTPs, private tokens, and
 * financial payloads beyond what is needed. That is enforced here rather than left to
 * each call site, because a redaction rule only applied by convention is one that
 * eventually gets forgotten. Keys are dropped by name, and any value that looks like a
 * JWT or a long opaque token is dropped whatever it is called.
 */
const REDACTED_KEYS = new Set([
    'code', 'otp', 'token', 'password', 'secret', 'hash', 'code_hash',
    'privateKey', 'private_key', 'authorization', 'idToken', 'accessToken',
    'receipt', 'signedPayload', 'purchaseToken',
]);

const looksLikeSecret = (value) =>
    typeof value === 'string' &&
    (/^ey[A-Za-z0-9_-]{10,}\./.test(value) || /^[A-Za-z0-9_-]{40,}$/.test(value));

const scrub = (fields = {}) => {
    const safe = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (REDACTED_KEYS.has(key) || looksLikeSecret(value)) {
            safe[key] = '[redacted]';
            continue;
        }
        safe[key] = value;
    }
    return safe;
};

/**
 * Wraps an operation so success and failure are both recorded exactly once.
 *
 * Errors are re-thrown unchanged — this observes, it never swallows. The error is
 * logged by CATEGORY (`err.code`/domain code) rather than by message, so a domain
 * code stays greppable and a stack trace never carries user data into the log.
 */
const withLogging = (operation, uid, fields, run) => {
    const startedAt = Date.now();
    const base = { operation, uid: uid || null, ...scrub(fields) };

    return Promise.resolve()
        .then(run)
        .then((result) => {
            logger.info(operation, {
                ...base,
                outcome: 'success',
                durationMs: Date.now() - startedAt,
            });
            return result;
        })
        .catch((error) => {
            logger.error(operation, {
                ...base,
                outcome: 'failure',
                durationMs: Date.now() - startedAt,
                errorCategory: error && (error.code || error.errorInfo || 'unknown'),
                errorMessage: error && error.message,
            });
            throw error;
        });
};

/** One-off structured event, for paths that are not a whole operation. */
const logEvent = (operation, outcome, fields = {}) => {
    const payload = { operation, outcome, ...scrub(fields) };
    if (outcome === 'failure') logger.error(operation, payload);
    else logger.info(operation, payload);
};

// ---------------------------------------------------------------------------
// Rate limiting — brief §16/§17
// ---------------------------------------------------------------------------

/**
 * Per-user, per-operation rate limiting on the abuse-prone callables (friend
 * requests, split creation, split settlement, search, device-token registration).
 *
 * ⚠️ WHY FIRESTORE, NOT IN-MEMORY. ⚠️
 *
 * A gen2 function scales across many independent instances with no shared memory —
 * an in-memory counter would let a caller get a fresh, empty counter on every new
 * instance, i.e. no limit at all under real concurrency. Firestore is the only shared
 * state already available, so the limiter is a small per-window counter document,
 * incremented inside a transaction so two concurrent requests cannot both slip under
 * the cap (the same "transaction, not read-then-write" shape as `withOperationMutex`).
 *
 * FIXED WINDOW, not sliding. Simpler, and the abuse this defends against — a script
 * hammering `sendFriendRequest` or `settleSplitPayment` — does not need sub-window
 * precision. A determined caller can get up to ~2x the limit at a window boundary;
 * that is an accepted tradeoff for a Firestore-only budget, same as documented for
 * `withOperationMutex`'s window-based mutex release.
 *
 * §17: this is one LAYER, not a substitute for Blaze having no automatic spending
 * cap. It bounds request COUNT per user per operation; it says nothing about total
 * project spend, which still needs budget alerts (console-only, cannot be scripted
 * from here) and `maxInstances` (set per function below) as separate layers.
 *
 * Cleanup: window documents are small and self-identifying by `expires_at`, but
 * Firestore does not expire them on its own — a TTL policy on `rate_limits.expires_at`
 * should be set once via the console (Firestore -> TTL) so old windows do not
 * accumulate forever. Not required for correctness, only for storage hygiene, so it
 * is recorded here rather than blocking this deploy.
 */
const RATE_LIMIT_COLLECTION = 'rate_limits';

const assertRateLimit = async (uid, operation, { max, windowMs }) => {
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const docId = deterministicId('rl', uid, operation, String(windowStart));
    const ref = db.collection(RATE_LIMIT_COLLECTION).doc(docId);

    for (let wave = 1; wave <= 5; wave++) {
        try {
            const allowed = await runTransactionWithRetry(
                async (tx) => {
                    const snapshot = await tx.get(ref);
                    const count = (snapshot.exists && snapshot.data().count) || 0;
                    if (count >= max) return false;

                    tx.set(
                        ref,
                        {
                            uid,
                            operation,
                            count: count + 1,
                            windowStart,
                            expires_at: Timestamp.fromMillis(windowStart + windowMs),
                            ...touch(),
                        },
                        { merge: true }
                    );
                    return true;
                },
                { maxAttempts: 8, maxDelayMs: 1000, baseDelayMs: 40 }
            );

            if (!allowed) {
                logEvent('rateLimit', 'failure', { operation, uid });
                throw fail('RATE_LIMITED', 429, { retryAfterMs: windowStart + windowMs - Date.now() });
            }
            return;
        } catch (error) {
            if (isHttpsDomainError(error)) throw error;
            if (!isRetryableTransactionError(error) || wave >= 5) throw error;
            await sleep(computeRetryDelayMs(wave, { baseDelayMs: 75, maxDelayMs: 1000 }));
        }
    }
};

module.exports = {
    admin,
    auth,
    db,
    messaging,
    logger,
    withLogging,
    logEvent,
    scrub,
    FieldValue,
    Timestamp,
    CREATED_AT,
    UPDATED_AT,
    DELETED_AT,
    stamps,
    touch,
    fail,
    requireAuth,
    requirePro,
    sha256,
    pairKeyFor,
    deterministicId,
    withOperationMutex,
    runTransactionWithRetry,
    isRetryableTransactionError,
    toCents,
    fromCents,
    applyBalanceDelta,
    assertRateLimit,
};
