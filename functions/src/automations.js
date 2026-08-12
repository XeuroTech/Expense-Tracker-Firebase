/**
 * Automation evaluation — the Firebase equivalent of `evaluate_automations`.
 *
 * ── WHY THIS WAS DEFERRED, AND WHY IT IS SAFE NOW ───────────────────────────────
 *
 * `functions/index.js` previously recorded this as NOT PORTED, for a real reason:
 * the Appwrite function lists *every* active automation project-wide on *every*
 * transaction-create event, with no owner scope, no recursion guard and no depth
 * ceiling. Reproducing that on Firestore would have been worse, not equal — Admin
 * SDK writes (split creation, settlement, `aiSmartAdd`) fire triggers too, so the
 * blast radius would include the money paths, not just client writes.
 *
 * This implementation closes all three gaps the deferral called for:
 *
 *   1. OWNER SCOPING BY CONSTRUCTION — the trigger is registered on
 *      `users/{uid}/transactions/{transactionId}`. `uid` comes from the trigger's
 *      OWN path parameter, never from a query. It is structurally impossible for
 *      this handler to read or mutate a different user's `wallets`/`budgets`,
 *      because every reference built inside it is rooted at the same `uid`.
 *
 *   2. RECURSION GUARD — a transaction created BY this handler (the `create_transfer`
 *      action) is stamped `origin: 'automation'`. The handler's first line checks
 *      for that marker and returns immediately. An automation-authored transaction
 *      can therefore never re-trigger automation evaluation.
 *
 *   3. DEPTH CEILING — belt-and-braces independent of (2): the same stamped
 *      transaction also carries `automationDepth: 1`. The handler refuses to run
 *      for any transaction at or above `MAX_AUTOMATION_DEPTH`, so even if the
 *      `origin` marker were ever renamed or dropped by a future edit, a second
 *      level of automation chaining still cannot happen.
 *
 * ── BEHAVIOUR PARITY ─────────────────────────────────────────────────────────────
 * Condition evaluation, amount templating (`{{amount}}` / `{{amount * N}}` / a
 * fixed number) and the two action types (`create_transfer`, `allocate_budget`) are
 * a direct, line-by-line reproduction of
 * `backend/functions/evaluate_automations/src/main.js`. Two deliberate exceptions,
 * both already true of the Appwrite version and preserved rather than "fixed" here
 * per the parity brief (do not invent different behaviour):
 *
 *   - `create_transfer` has NO insufficient-balance guard. The Appwrite function
 *     lets a transfer drive a wallet negative; this does too.
 *   - The created transfer transaction stores only the SOURCE `wallet_id`, exactly
 *     like the Appwrite version and like `ai_smart_add`'s own transfer handling —
 *     the destination wallet is not a field on the transaction document.
 *
 * There is currently no app UI that writes an `automations` document on EITHER
 * provider (confirmed by tracing the frontend — no screen creates one). This
 * function is therefore backend-complete and ready for whenever such a UI ships,
 * or for the same generic `dataAdapter` path a future screen would use — it is not
 * something end users can exercise today.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');

const { db, logEvent, touch, applyBalanceDelta, FieldValue } = require('./common');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/** One level of automation-authored transactions, never two. See header §3. */
const MAX_AUTOMATION_DEPTH = 1;

// ---------------------------------------------------------------------------
// Verbatim ports of evaluate_automations/src/main.js helpers
// ---------------------------------------------------------------------------

const extractRelationId = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            const id = extractRelationId(item);
            if (id) return id;
        }
        return null;
    }
    if (typeof value === 'object' && typeof value.$id === 'string') return value.$id;
    return null;
};

const parseAmountTemplate = (amountTemplate, baseAmount) => {
    const amount = Number(baseAmount) || 0;
    if (typeof amountTemplate === 'number') return amountTemplate;
    if (typeof amountTemplate !== 'string') return amount;

    const t = amountTemplate.trim();
    if (t === '') return amount;
    if (t === '{{amount}}') return amount;

    const m = t.match(/^\{\{\s*amount\s*\*\s*([0-9.]+)\s*\}\}$/);
    if (m && m[1]) {
        const mult = Number(m[1]);
        return amount * (Number.isFinite(mult) ? mult : 0);
    }

    const fixed = Number(t);
    if (Number.isFinite(fixed)) return fixed;

    return amount;
};

/**
 * `conditions` / `action_payload` are generic pass-through fields in the shared
 * schema (frontend/src/backend/firebase/cloudAttributes.ts has no type coercion
 * for them). Appwrite always stores them JSON-stringified; a Firestore write could
 * plausibly store either a string or a native object, so both are accepted.
 */
const parseMaybeJson = (value) => {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Moves money between two of the SAME user's wallets and records the transfer.
 *
 * Both wallets and the new transaction live under `users/{uid}/...`, so this is a
 * single-user Firestore transaction — no cross-user contention, no partial state on
 * failure (unlike the Appwrite version's three independent, non-transactional
 * writes).
 */
const runCreateTransfer = async (uid, automation, payload, amount) => {
    const sourceWalletId = payload.source_wallet_id;
    const destWalletId = payload.dest_wallet_id;

    if (!sourceWalletId || !destWalletId || sourceWalletId === destWalletId) {
        logEvent('evaluateAutomations', 'failure', {
            uid,
            automationId: automation.id,
            reason: 'invalid_wallet_payload',
        });
        return;
    }

    const userRef = db.collection('users').doc(uid);
    const sourceRef = userRef.collection('wallets').doc(sourceWalletId);
    const destRef = userRef.collection('wallets').doc(destWalletId);
    const txRef = userRef.collection('transactions').doc();

    try {
        await db.runTransaction(async (tx) => {
            // ---- READ PHASE ----
            const [sourceSnap, destSnap] = await Promise.all([tx.get(sourceRef), tx.get(destRef)]);

            if (!sourceSnap.exists || sourceSnap.data()._deletedAt) throw new Error('SOURCE_WALLET_NOT_FOUND');
            if (!destSnap.exists || destSnap.data()._deletedAt) throw new Error('DEST_WALLET_NOT_FOUND');

            const sourceBalance = Number(sourceSnap.data().current_balance) || 0;
            const destBalance = Number(destSnap.data().current_balance) || 0;

            // ---- WRITE PHASE ----
            // No insufficient-balance guard — preserved from the Appwrite version.
            tx.update(sourceRef, {
                current_balance: applyBalanceDelta(sourceBalance, -amount),
                ...touch(),
            });
            tx.update(destRef, {
                current_balance: applyBalanceDelta(destBalance, amount),
                ...touch(),
            });
            tx.set(txRef, {
                user_id: uid,
                amount,
                type: 'transfer',
                wallet_id: sourceWalletId,
                date: new Date().toISOString(),
                note: `Automated: ${automation.name || 'automation'}`,
                // Recursion guard + depth ceiling — see header §2/§3.
                origin: 'automation',
                automationDepth: MAX_AUTOMATION_DEPTH,
                automationId: automation.id,
                _createdAt: FieldValue.serverTimestamp(),
                _updatedAt: FieldValue.serverTimestamp(),
                _deletedAt: null,
            });
        });

        logEvent('evaluateAutomations', 'success', {
            uid,
            automationId: automation.id,
            actionType: 'create_transfer',
        });
    } catch (err) {
        logEvent('evaluateAutomations', 'failure', {
            uid,
            automationId: automation.id,
            errorMessage: err.message,
        });
    }
};

const runAllocateBudget = async (uid, automation, payload, amount) => {
    const budgetId = payload.budget_id;
    if (!budgetId) {
        logEvent('evaluateAutomations', 'failure', {
            uid,
            automationId: automation.id,
            reason: 'missing_budget_id',
        });
        return;
    }

    const budgetRef = db.collection('users').doc(uid).collection('budgets').doc(budgetId);

    try {
        await db.runTransaction(async (tx) => {
            const snapshot = await tx.get(budgetRef);
            if (!snapshot.exists || snapshot.data()._deletedAt) throw new Error('BUDGET_NOT_FOUND');

            const current = Number(snapshot.data().allocated_amount) || 0;
            tx.update(budgetRef, {
                allocated_amount: applyBalanceDelta(current, amount),
                ...touch(),
            });
        });

        logEvent('evaluateAutomations', 'success', {
            uid,
            automationId: automation.id,
            actionType: 'allocate_budget',
        });
    } catch (err) {
        logEvent('evaluateAutomations', 'failure', {
            uid,
            automationId: automation.id,
            errorMessage: err.message,
        });
    }
};

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * The trigger's entire body, factored out so it can be exercised directly against
 * the Firestore emulator in tests without constructing a synthetic CloudEvent —
 * the same reasoning `splits.js` and `common.js` already apply (test the real
 * logic function, not the `onCall`/`onDocumentCreated` wrapper around it).
 */
const evaluateAutomationsForTransaction = async (uid, transactionId, tx) => {
    // Guard §2 — never re-evaluate a transaction an automation itself created.
    if (tx.origin === 'automation') {
        logEvent('evaluateAutomations', 'success', { uid, transactionId, skipped: 'origin' });
        return;
    }

    // Guard §3 — independent depth ceiling, in case the marker above is ever lost.
    const depth = Number(tx.automationDepth) || 0;
    if (depth >= MAX_AUTOMATION_DEPTH) {
        logEvent('evaluateAutomations', 'success', { uid, transactionId, skipped: 'depth' });
        return;
    }

    const automationsRef = db.collection('users').doc(uid).collection('automations');
    const activeSnapshot = await automationsRef.where('is_active', '==', true).get();

    const automations = activeSnapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((automation) => automation.trigger_type === 'transaction_created');

    if (automations.length === 0) return;

    for (const automation of automations) {
        const condition = parseMaybeJson(automation.conditions) || {};
        const eventCategoryId = extractRelationId(tx.category_id);
        const conditionCategoryId = extractRelationId(condition.value);

        let conditionMet = false;
        if (condition.ignore_if_null === true && (!condition.value || condition.value === 'N/A')) {
            conditionMet = true;
        } else if (condition.field === 'category_id' && condition.operator === '==') {
            conditionMet = !!(eventCategoryId && conditionCategoryId && conditionCategoryId === eventCategoryId);
        }

        if (!conditionMet) continue;
        if (automation.action_type !== 'create_transfer' && automation.action_type !== 'allocate_budget') continue;

        const actionPayload = parseMaybeJson(automation.action_payload) || {};
        const targetAmount = parseAmountTemplate(actionPayload.amount, tx.amount);

        if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
            logEvent('evaluateAutomations', 'failure', {
                uid,
                automationId: automation.id,
                reason: 'invalid_target_amount',
            });
            continue;
        }

        if (automation.action_type === 'create_transfer') {
            await runCreateTransfer(uid, automation, actionPayload, targetAmount);
        } else {
            await runAllocateBudget(uid, automation, actionPayload, targetAmount);
        }
    }
};

const evaluateAutomationsOnTransactionCreate = onDocumentCreated(
    { document: 'users/{uid}/transactions/{transactionId}', region: REGION, maxInstances: 10 },
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) return;

        const { uid, transactionId } = event.params;
        await evaluateAutomationsForTransaction(uid, transactionId, snapshot.data() || {});
    }
);

module.exports = {
    evaluateAutomationsOnTransactionCreate,
    // Exported for tests: the core logic (functional, against the emulator) and
    // the pure helpers (static, no Firestore access).
    evaluateAutomationsForTransaction,
    extractRelationId,
    parseAmountTemplate,
    parseMaybeJson,
    MAX_AUTOMATION_DEPTH,
};
