/**
 * `aiSmartAdd` — the Firebase counterpart of `backend/functions/ai_smart_add`.
 *
 * Previously deferred (see the old `functions/index.js` header): it needed the
 * Groq API key, which was not available at the time, and it was the one remaining
 * callable with no security or money implications, so it was the safest thing to
 * defer. This is that port.
 *
 * ── STRUCTURE MIRRORS THE SOURCE ────────────────────────────────────────────────
 * Appwrite splits this across constants.js / validation.js / actions.js / main.js.
 * This port keeps the same split — aiSmartAddConstants.js / aiSmartAdd.js (this
 * file: normalization, resolution, the Groq call, orchestration) /
 * aiSmartAddActions.js (confirm-time writes) — specifically so the two
 * implementations stay comparable side by side.
 *
 * ── WHAT IS A DIRECT PORT VS WHAT CHANGED ────────────────────────────────────────
 * `normalizeAiAction`, `resolveAction`, `recomputeMissingFields`, `applyDefaults`
 * and `buildPrompt` below are a line-by-line reproduction of
 * `backend/functions/ai_smart_add/src/validation.js` — same fields, same
 * defaulting, same missing-field rules, same prompt. Two things are intentionally
 * NOT reproduced, both already-solved problems on this side of the fork:
 *
 *   - `normalizeSubscription` / the HMAC subscription-signature check. Appwrite
 *     needs it because `prefs` is client-writable there (C-SUB-1). Under Firebase,
 *     subscription keys in `users/{uid}.prefs` are server-write-only in Security
 *     Rules, so `requirePro()` (common.js) already gives the same guarantee with
 *     no signature to verify. Using it here instead of reinventing the check is
 *     the same call splits.js and friends.js already made.
 *
 *   - `checkRateLimit`'s Appwrite implementation (list pending actions in the
 *     window, compare `.total` to a cap) has a read-then-write race under
 *     concurrent calls. `assertRateLimit` (common.js) is the same 8/60s budget
 *     enforced through a Firestore transaction, which is what the rest of this
 *     provider already uses for every other rate-limited callable.
 *
 * The duplicate-prompt check also changed shape without changing behaviour: the
 * Appwrite version queries `prompt_hash == X AND created_at > cutoff` — an
 * equality + range query on two different fields, which needs a composite index
 * regardless of collection size. This queries `prompt_hash == X` only (a single
 * equality, automatically indexed) and filters the small result by `created_at` in
 * memory, avoiding a new index for a check that only ever matches 0 or 1 documents
 * in practice. Same outcome, no deploy-time index dependency.
 */

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const {
    fail,
    requireAuth,
    requirePro,
    sha256,
    stamps,
    touch,
    withLogging,
    logEvent,
    assertRateLimit,
    deterministicId,
    withOperationMutex,
} = require('./common');
const {
    COLL_PENDING,
    COLL_TXS,
    MODEL,
    GROQ_BASE_URL,
    INTENTS,
    TRANSACTION_TYPES,
    FREQUENCIES,
    SUPPORTED_RECURRING_FREQUENCIES,
    BUDGET_PERIODS,
    SUPPORTED_BUDGET_PERIODS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX,
    PENDING_TTL_MS,
    DUPLICATE_WINDOW_MS,
    WALLET_TYPES,
    LOAN_TYPES,
    CATEGORY_TYPES,
} = require('./aiSmartAddConstants');
const {
    userCollection,
    getFinanceContext,
    ensureConfirmedCategory,
    deleteProvisionalCategory,
    cleanupUnusedProvisionalCategory,
    createTransaction,
    createRecurringPlan,
    createOrUpdateBudget,
    createWallet,
    createCategoryAction,
    createPayee,
    createLoan,
    createInvestment,
} = require('./aiSmartAddActions');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/**
 * Set once via `firebase functions:secrets:set GROQ_API_KEY --project <id>` before
 * deploy. Deliberately a Secret Manager secret, not a `.env` value or a plain
 * `process.env` read (unlike `TRANSACTIONAL_EMAIL_API_KEY` in account.js) — this
 * key can place real, billed calls to a third-party API on every parse.
 */
const GROQ_API_KEY = defineSecret('GROQ_API_KEY');

// ---------------------------------------------------------------------------
// Normalization — verbatim from validation.js
// ---------------------------------------------------------------------------

const cleanText = (value, max = 255) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
};

const cleanId = (value) => cleanText(value, 255);

const cleanNumber = (value) => {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
};

const cleanBalance = (value) => {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num >= 0 ? num : null;
};

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const clampConfidence = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
};

const pickValid = (value, allowed, fallback = null) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
    return allowed.includes(normalized) ? normalized : fallback;
};

const cleanCategoryType = (value) => pickValid(value, CATEGORY_TYPES, null);
const TRANSACTION_INTENTS = ['expense', 'income', 'transfer'];

const normalizeWalletType = (value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (normalized === 'credit' || normalized === 'credit card') return 'credit_card';
    return pickValid(normalized, WALLET_TYPES, null);
};

const cleanPendingCategory = (value) => {
    const name = cleanText(value?.name);
    const type = cleanCategoryType(value?.type);
    if (!name && !type) return null;
    return { name, type };
};

const cleanObject = (value) => (value && typeof value === 'object' ? value : {});

const normalizeMissingField = (value) => {
    const normalized = cleanText(value, 120);
    if (!normalized) return null;
    if (normalized === 'fromWallet') return 'fromWalletId';
    if (normalized === 'toWallet') return 'toWalletId';
    if (normalized === 'category') return 'categoryId';
    if (normalized === 'budget.category') return 'budget.categoryId';
    return normalized;
};

const normalizeAiAction = (rawValue) => {
    const raw = cleanObject(rawValue);
    const rawMatches = cleanObject(raw.matches);
    const rawBudget = cleanObject(raw.budget);
    const rawRecurring = cleanObject(raw.recurring);
    const rawWallet = cleanObject(raw.wallet);
    const rawPayee = cleanObject(raw.payee);
    const rawLoan = cleanObject(raw.loan);
    const rawInvestment = cleanObject(raw.investment);
    const rawPendingCategory = cleanPendingCategory(raw.pendingCategoryToCreate);

    const rawIntent = typeof raw.intent === 'string' ? raw.intent.trim().toLowerCase() : null;
    const intentIsTransactionType = TRANSACTION_INTENTS.includes(rawIntent);
    const intent = intentIsTransactionType ? 'transaction' : pickValid(raw.intent, INTENTS, 'unknown');
    const transactionType = intentIsTransactionType
        ? rawIntent
        : pickValid(raw.transactionType, TRANSACTION_TYPES, null);
    const fromWalletId = cleanId(raw.fromWalletId) || cleanId(rawMatches.fromWalletId);
    const toWalletId = cleanId(raw.toWalletId) || cleanId(rawMatches.toWalletId);
    const topLevelCategoryId = cleanId(raw.categoryId) || cleanId(rawMatches.categoryId);
    const budgetCategoryId = cleanId(rawBudget.categoryId);
    const resolvedCategoryId = topLevelCategoryId || budgetCategoryId;
    const categoryName = cleanText(raw.categoryName) || cleanText(raw.category);
    const budgetCategoryName = cleanText(rawBudget.categoryName) || cleanText(rawBudget.category);
    const payeeName = cleanText(rawPayee.name)
        || cleanText(raw.payeeName)
        || cleanText(rawLoan.personName)
        || cleanText(rawInvestment.name);
    const loanAmount = cleanNumber(rawLoan.amount ?? raw.amount);
    const investmentProfit = cleanNumber(rawInvestment.profit);
    const investmentAmount = cleanNumber(rawInvestment.amount ?? raw.amount ?? rawInvestment.profit);
    const walletType = normalizeWalletType(rawWallet.type);

    const action = {
        intent,
        transactionType,
        amount: cleanNumber(raw.amount),
        fromWalletId,
        toWalletId,
        categoryId: resolvedCategoryId,
        categoryName,
        fromWallet: cleanText(raw.fromWallet),
        toWallet: cleanText(raw.toWallet),
        category: categoryName,
        pendingCategoryToCreate: rawPendingCategory,
        payee: {
            id: cleanId(rawPayee.id) || cleanId(rawMatches.payeeId),
            name: payeeName,
        },
        loan: {
            type: pickValid(rawLoan.type, LOAN_TYPES, null),
            personName: cleanText(rawLoan.personName) || payeeName,
            amount: loanAmount,
            walletId: cleanId(rawLoan.walletId) || cleanId(rawMatches.loanWalletId) || fromWalletId || toWalletId,
            date: normalizeDate(rawLoan.date) || normalizeDate(raw.date),
        },
        investment: {
            name: cleanText(rawInvestment.name) || payeeName,
            amount: investmentAmount,
            walletId: cleanId(rawInvestment.walletId) || cleanId(rawMatches.investmentWalletId) || fromWalletId || toWalletId,
            profit: investmentProfit,
            date: normalizeDate(rawInvestment.date) || normalizeDate(raw.date),
        },
        wallet: {
            name: cleanText(rawWallet.name),
            type: walletType,
            initialBalance: cleanBalance(rawWallet.initialBalance ?? rawWallet.currentBalance),
            currentBalance: cleanBalance(rawWallet.currentBalance ?? rawWallet.initialBalance),
            currency: cleanText(rawWallet.currency, 20),
        },
        note: cleanText(raw.note, 1000),
        merchant: cleanText(raw.merchant),
        date: normalizeDate(raw.date),
        recurring: {
            isRecurring: !!rawRecurring.isRecurring,
            frequency: pickValid(rawRecurring.frequency, FREQUENCIES, null),
            startDate: normalizeDate(rawRecurring.startDate),
            endDate: normalizeDate(rawRecurring.endDate),
        },
        budget: {
            category: budgetCategoryName,
            categoryName: budgetCategoryName,
            categoryId: budgetCategoryId,
            amount: cleanNumber(rawBudget.amount ?? raw.amount),
            period: pickValid(rawBudget.period, BUDGET_PERIODS, null),
        },
        confidence: clampConfidence(raw.confidence),
        missingFields: Array.isArray(raw.missingFields)
            ? Array.from(new Set(raw.missingFields.map(normalizeMissingField).filter(Boolean)))
            : [],
        matches: {
            fromWalletId,
            toWalletId,
            categoryId: resolvedCategoryId,
            payeeId: cleanId(rawPayee.id) || cleanId(rawMatches.payeeId),
            loanWalletId: cleanId(rawLoan.walletId) || cleanId(rawMatches.loanWalletId) || fromWalletId || toWalletId,
            investmentWalletId: cleanId(rawInvestment.walletId) || cleanId(rawMatches.investmentWalletId) || fromWalletId || toWalletId,
        },
    };

    return action;
};

const normalizeName = (value) => (
    typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : ''
);

const sameName = (left, right) => {
    const normalizedLeft = normalizeName(left);
    const normalizedRight = normalizeName(right);
    return !!normalizedLeft && normalizedLeft === normalizedRight;
};

/**
 * Phase 4 (Part K, RC-7) -- previously: first exact-name match, else first
 * SUBSTRING match in whatever order the wallet/category/payee list happened
 * to be in, with no ranking. Two similarly-named records could silently
 * resolve to whichever one came first -- unrelated to the user's intent.
 *
 * Now: an exact-name match still wins immediately (tie-broken deterministically
 * by `$id`, not array order, in the rare case of an exact-name collision).
 * Only when no exact match exists does substring matching run -- and if that
 * finds more than one candidate, this returns `null` (ambiguous) rather than
 * guessing. `null` flows into the same "missing/unresolved" path a true
 * no-match already takes.
 */
const findNamed = (items, name) => {
    if (!name) return null;
    const wanted = name.trim().toLowerCase();

    const exactMatches = items.filter((item) => sameName(item.name, name));
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) {
        return [...exactMatches].sort((a, b) => String(a.$id).localeCompare(String(b.$id)))[0];
    }

    const fuzzyMatches = items.filter((item) => {
        const candidate = String(item.name || '').trim().toLowerCase();
        return candidate.includes(wanted) || wanted.includes(candidate);
    });
    return fuzzyMatches.length === 1 ? fuzzyMatches[0] : null;
};

const findExactNamed = (items, name) => {
    if (!name) return null;
    return items.find((item) => sameName(item.name, name)) || null;
};

const findById = (items, id) => {
    if (!id) return null;
    return items.find((item) => item.$id === id) || null;
};

/**
 * Phase 4 (Part K, RC-7) -- when an id was already resolved (persisted on the
 * pending action's `matches` at parse time, or supplied by the user editing
 * the draft before confirm), that id is authoritative: look it up directly
 * and either use it or fail. NEVER fall back to fuzzy name-matching for an id
 * that no longer resolves -- that would silently substitute a DIFFERENT,
 * similarly-named record for one the user already reviewed. Fuzzy-by-name
 * only ever runs when no id was ever given.
 */
const resolveByIdOrName = (items, id, name) => (id ? findById(items, id) : findNamed(items, name));

const addMissing = (set, field, isValid) => {
    if (!isValid) set.add(field);
};

const applyDefaults = (action) => {
    const next = {
        ...action,
        recurring: { ...action.recurring },
        budget: { ...action.budget },
        matches: { ...(action.matches || {}) },
    };

    if (next.intent === 'transaction' && !next.date) {
        next.date = new Date().toISOString();
    }

    if (next.intent === 'loan_create') {
        if (!next.loan.date) next.loan.date = next.date || new Date().toISOString();
        if (!next.date) next.date = next.loan.date;
    }

    if (next.intent === 'investment_create') {
        if (!next.investment.date) next.investment.date = next.date || new Date().toISOString();
        if (!next.date) next.date = next.investment.date;
    }

    if (next.intent === 'recurring_plan') {
        if (!next.recurring.startDate) {
            next.recurring.startDate = next.date || new Date().toISOString();
        }
        if (!next.date) {
            next.date = next.recurring.startDate;
        }
    }

    return next;
};

const recomputeMissingFields = (action) => {
    const missing = new Set();
    const withDefaults = applyDefaults(action);
    const next = {
        ...withDefaults,
        pendingCategoryToCreate: withDefaults.pendingCategoryToCreate
            ? { ...withDefaults.pendingCategoryToCreate }
            : null,
        payee: { ...(withDefaults.payee || {}) },
        loan: { ...(withDefaults.loan || {}) },
        investment: { ...(withDefaults.investment || {}) },
        wallet: { ...(withDefaults.wallet || {}) },
        recurring: { ...withDefaults.recurring },
        budget: { ...withDefaults.budget },
        matches: { ...(withDefaults.matches || {}) },
    };

    const hasCategory = () => !!next.matches.categoryId || (
        !!cleanText(next.pendingCategoryToCreate?.name)
        && CATEGORY_TYPES.includes(next.pendingCategoryToCreate?.type)
    );
    const hasPayee = () => !!next.matches.payeeId || !!cleanText(next.payee?.name);
    const positiveAmount = (value) => !!cleanNumber(value);

    if (next.intent === 'transaction') {
        addMissing(missing, 'transactionType', TRANSACTION_TYPES.includes(next.transactionType));
        addMissing(missing, 'amount', positiveAmount(next.amount));
        addMissing(missing, 'date', !!normalizeDate(next.date));

        if (next.transactionType === 'income' && !next.matches.toWalletId && next.matches.fromWalletId) {
            next.matches.toWalletId = next.matches.fromWalletId;
            next.toWalletId = next.matches.toWalletId;
            if (!next.toWallet) next.toWallet = next.fromWallet;
        }

        if (next.transactionType === 'expense') {
            addMissing(missing, 'fromWalletId', !!next.matches.fromWalletId);
            addMissing(missing, 'categoryId', hasCategory());
        }
        if (next.transactionType === 'income') {
            addMissing(missing, 'toWalletId', !!next.matches.toWalletId);
            addMissing(missing, 'categoryId', hasCategory());
        }
        if (next.transactionType === 'transfer') {
            addMissing(missing, 'fromWalletId', !!next.matches.fromWalletId);
            addMissing(missing, 'toWalletId', !!next.matches.toWalletId);
            if (
                next.matches.fromWalletId
                && next.matches.toWalletId
                && next.matches.fromWalletId === next.matches.toWalletId
            ) {
                missing.add('toWalletId');
            }
        }
    } else if (next.intent === 'category_create') {
        const pendingName = cleanText(next.pendingCategoryToCreate?.name) || cleanText(next.categoryName) || cleanText(next.category);
        const pendingType = next.pendingCategoryToCreate?.type || null;
        if (pendingName) {
            next.pendingCategoryToCreate = { name: pendingName, type: pendingType };
            next.categoryName = pendingName;
            next.category = pendingName;
        }
        addMissing(missing, 'categoryName', !!next.matches.categoryId || !!pendingName);
        addMissing(missing, 'pendingCategoryToCreate.type', !!next.matches.categoryId || CATEGORY_TYPES.includes(pendingType));
    } else if (next.intent === 'payee_create') {
        addMissing(missing, 'payee.name', !!cleanText(next.payee?.name));
    } else if (next.intent === 'loan_create') {
        next.loan.amount = cleanNumber(next.loan.amount ?? next.amount);
        next.amount = next.loan.amount;
        next.loan.walletId = next.matches.loanWalletId || next.loan.walletId || next.matches.fromWalletId || null;
        next.loan.personName = cleanText(next.loan.personName) || cleanText(next.payee?.name);
        next.payee.name = cleanText(next.payee?.name) || next.loan.personName;
        addMissing(missing, 'loan.type', LOAN_TYPES.includes(next.loan.type));
        addMissing(missing, 'loan.personName', next.loan.type === 'repayment' ? !!next.matches.payeeId : hasPayee());
        addMissing(missing, 'loan.amount', positiveAmount(next.loan.amount));
        addMissing(missing, 'loan.walletId', !!next.loan.walletId);
        addMissing(missing, 'loan.date', !!normalizeDate(next.loan.date));
    } else if (next.intent === 'investment_create') {
        next.investment.amount = cleanNumber(next.investment.amount ?? next.amount);
        next.investment.profit = cleanNumber(next.investment.profit);
        next.amount = next.investment.profit || next.investment.amount;
        next.investment.walletId = next.matches.investmentWalletId || next.investment.walletId || next.matches.fromWalletId || null;
        next.investment.name = cleanText(next.investment.name) || cleanText(next.payee?.name);
        next.payee.name = cleanText(next.payee?.name) || next.investment.name;
        addMissing(missing, 'investment.name', hasPayee());
        addMissing(missing, 'investment.amount', positiveAmount(next.investment.profit || next.investment.amount));
        addMissing(missing, 'investment.walletId', !!next.investment.walletId);
        addMissing(missing, 'investment.date', !!normalizeDate(next.investment.date));
    } else if (next.intent === 'recurring_plan') {
        addMissing(missing, 'transactionType', ['expense', 'income'].includes(next.transactionType));
        addMissing(missing, 'amount', positiveAmount(next.amount));
        addMissing(
            missing,
            'recurring.frequency',
            !!next.recurring.frequency && SUPPORTED_RECURRING_FREQUENCIES.includes(next.recurring.frequency)
        );
        addMissing(missing, 'recurring.startDate', !!normalizeDate(next.recurring.startDate));
    } else if (next.intent === 'budget') {
        const budgetCategoryId = next.budget.categoryId || next.matches.categoryId || null;
        if (budgetCategoryId) {
            next.matches.categoryId = budgetCategoryId;
            next.categoryId = budgetCategoryId;
            next.budget.categoryId = budgetCategoryId;
        }
        next.budget.amount = cleanNumber(next.budget.amount ?? next.amount);
        addMissing(missing, 'budget.amount', positiveAmount(next.budget.amount));
        addMissing(
            missing,
            'budget.period',
            !!next.budget.period && SUPPORTED_BUDGET_PERIODS.includes(next.budget.period)
        );
        addMissing(missing, 'budget.categoryId', hasCategory());
    } else if (next.intent === 'wallet_create') {
        const wallet = next.wallet || {};
        next.wallet = {
            ...wallet,
            currentBalance: cleanBalance(wallet.currentBalance ?? wallet.initialBalance),
            initialBalance: cleanBalance(wallet.initialBalance ?? wallet.currentBalance),
        };
        addMissing(missing, 'wallet.name', !!cleanText(next.wallet.name));
        addMissing(missing, 'wallet.type', WALLET_TYPES.includes(next.wallet.type));
        addMissing(missing, 'wallet.initialBalance', cleanBalance(next.wallet.initialBalance) !== null);
    } else {
        missing.add('intent');
    }

    next.fromWalletId = next.matches.fromWalletId || null;
    next.toWalletId = next.matches.toWalletId || null;
    next.categoryId = next.matches.categoryId || null;
    next.payee.id = next.matches.payeeId || next.payee.id || null;
    next.loan.walletId = next.matches.loanWalletId || next.loan.walletId || null;
    next.investment.walletId = next.matches.investmentWalletId || next.investment.walletId || null;
    next.budget.categoryId = next.matches.categoryId || next.budget.categoryId || null;
    next.budget.categoryName = next.budget.categoryName || next.budget.category || null;
    next.missingFields = Array.from(missing);
    return next;
};

const desiredCategoryTypeForAction = (action) => {
    if (action.intent === 'category_create') {
        return action.pendingCategoryToCreate?.type || 'expense';
    }
    if (action.transactionType === 'income') return 'income';
    if (action.transactionType === 'expense') return 'expense';
    if (action.intent === 'budget') return 'expense';
    return null;
};

const intentCanCreatePendingCategory = (action) => (
    ['transaction', 'budget', 'category_create'].includes(action.intent)
    && action.transactionType !== 'transfer'
);

const resolveAction = (action, wallets, categories, payees = []) => {
    const resolved = applyDefaults({
        ...action,
        pendingCategoryToCreate: action.pendingCategoryToCreate ? { ...action.pendingCategoryToCreate } : null,
        payee: { ...(action.payee || {}) },
        loan: { ...(action.loan || {}) },
        investment: { ...(action.investment || {}) },
        wallet: { ...(action.wallet || {}) },
        recurring: { ...action.recurring },
        budget: { ...action.budget },
        matches: { ...(action.matches || {}) },
    });

    const rawFromId = resolved.matches.fromWalletId || resolved.fromWalletId || null;
    const rawToId = resolved.matches.toWalletId || resolved.toWalletId || null;
    const fromWallet = resolveByIdOrName(wallets, rawFromId, resolved.fromWallet);
    const toWallet = resolveByIdOrName(wallets, rawToId, resolved.toWallet);

    resolved.matches.fromWalletId = fromWallet ? fromWallet.$id : null;
    resolved.matches.toWalletId = toWallet ? toWallet.$id : null;
    resolved.fromWallet = fromWallet ? fromWallet.name : null;
    resolved.toWallet = toWallet ? toWallet.name : null;

    if (resolved.transactionType === 'income' && !resolved.matches.toWalletId && resolved.matches.fromWalletId) {
        resolved.matches.toWalletId = resolved.matches.fromWalletId;
        if (!resolved.toWallet) resolved.toWallet = resolved.fromWallet;
    }

    if (resolved.transactionType !== 'income' && !resolved.matches.fromWalletId && resolved.matches.toWalletId) {
        resolved.matches.fromWalletId = resolved.matches.toWalletId;
        if (!resolved.fromWallet) resolved.fromWallet = resolved.toWallet;
    }

    const rawLoanWalletId = resolved.matches.loanWalletId || resolved.loan?.walletId || resolved.matches.fromWalletId || null;
    const loanWallet = findById(wallets, rawLoanWalletId) || fromWallet || toWallet;
    resolved.matches.loanWalletId = loanWallet ? loanWallet.$id : null;
    if (resolved.loan) resolved.loan.walletId = resolved.matches.loanWalletId;

    const rawInvestmentWalletId = resolved.matches.investmentWalletId
        || resolved.investment?.walletId
        || resolved.matches.fromWalletId
        || null;
    const investmentWallet = findById(wallets, rawInvestmentWalletId) || fromWallet || toWallet;
    resolved.matches.investmentWalletId = investmentWallet ? investmentWallet.$id : null;
    if (resolved.investment) resolved.investment.walletId = resolved.matches.investmentWalletId;

    const rawPayeeId = resolved.matches.payeeId || resolved.payee?.id || null;
    const requestedPayeeName = resolved.payee?.name || resolved.loan?.personName || resolved.investment?.name;
    const payee = resolveByIdOrName(payees, rawPayeeId, requestedPayeeName);
    resolved.matches.payeeId = payee ? payee.$id : null;
    resolved.payee = {
        ...(resolved.payee || {}),
        id: payee ? payee.$id : null,
        name: payee ? payee.name : cleanText(requestedPayeeName),
    };
    if (resolved.intent === 'loan_create') {
        resolved.loan.personName = resolved.payee.name || cleanText(resolved.loan.personName);
    }
    if (resolved.intent === 'investment_create') {
        resolved.investment.name = resolved.payee.name || cleanText(resolved.investment.name);
    }

    const rawCategoryId = resolved.budget.categoryId || resolved.matches.categoryId || resolved.categoryId || null;
    const desiredType = desiredCategoryTypeForAction(resolved);
    const typedCategories = desiredType
        ? categories.filter((category) => category.type === desiredType)
        : categories;
    const categoryName = resolved.intent === 'budget'
        ? (resolved.budget.categoryName || resolved.budget.category || resolved.categoryName || resolved.category)
        : (resolved.categoryName || resolved.category || resolved.pendingCategoryToCreate?.name);

    const categoryById = findById(categories, rawCategoryId);
    const exactNameAnyType = findExactNamed(categories, categoryName);
    const categoryByName = findNamed(typedCategories, categoryName);
    const category = categoryById && (!desiredType || categoryById.type === desiredType)
        ? categoryById
        : categoryByName;

    resolved.matches.categoryId = category ? category.$id : null;
    resolved.category = category ? category.name : categoryName;
    resolved.categoryName = resolved.category;
    if (resolved.intent === 'budget') {
        resolved.budget.category = category ? category.name : resolved.budget.category;
        resolved.budget.categoryName = resolved.budget.category;
    }

    if (category) {
        resolved.pendingCategoryToCreate = null;
    } else if (
        intentCanCreatePendingCategory(resolved)
        && categoryName
        && desiredType
        && (!exactNameAnyType || exactNameAnyType.type === desiredType)
    ) {
        resolved.pendingCategoryToCreate = { name: categoryName, type: desiredType };
    } else if (resolved.pendingCategoryToCreate?.name) {
        resolved.pendingCategoryToCreate = {
            name: resolved.pendingCategoryToCreate.name,
            type: cleanCategoryType(resolved.pendingCategoryToCreate.type),
        };
    } else {
        resolved.pendingCategoryToCreate = null;
    }

    resolved.fromWalletId = resolved.matches.fromWalletId || null;
    resolved.toWalletId = resolved.matches.toWalletId || null;
    resolved.categoryId = resolved.matches.categoryId || null;
    resolved.budget.categoryId = resolved.matches.categoryId || null;

    return recomputeMissingFields(resolved);
};

// ---------------------------------------------------------------------------
// Groq call — buildPrompt is verbatim from validation.js
// ---------------------------------------------------------------------------

const buildPrompt = (prompt, wallets, categories, payees = [], budgets = [], recurringPlans = [], context = {}) => {
    const timezone = cleanText(context.timezone, 120) || 'UTC';
    const currency = cleanText(context.currency, 20) || 'USD';
    const nowIso = new Date().toISOString();

    return [
        {
            role: 'system',
            content: [
                'You convert personal finance commands into strict JSON only.',
                'Return only one JSON object, no markdown, no comments, no explanations.',
                'Allowed intents are transaction, category_create, payee_create, loan_create, investment_create, recurring_plan, budget, wallet_create, unknown.',
                'Allowed transaction types are expense, income, transfer.',
                'Expense, income, and transfer are transaction features. Return intent transaction and set transactionType to expense, income, or transfer.',
                'Use transaction intent only for normal expense, income, and transfer transactions.',
                'Use loan_create for loans, loan repayments, borrowing, lending, or money given/taken as a loan.',
                'Use investment_create for investing capital or recording investment profit.',
                'For wallet creation prompts, use intent wallet_create and fill only the wallet object.',
                'Wallet creation must not use transactionType, fromWalletId, toWalletId, or categoryId.',
                'For wallet creation, infer bank when the prompt names a bank or bank account, cash for physical cash, and credit_card only when the user clearly says credit card.',
                'Wallet currency is optional. Never include wallet.currency in missingFields and never make it required.',
                'Allowed wallet types in this app are cash, bank, credit_card. If the user says credit, return credit_card.',
                'Categories in this app support only expense and income types. Do not invent loan or investment category types.',
                'Category-only prompts must use category_create and must not ask for amount, wallet, transactionType, or date.',
                'Never invent wallet IDs or category IDs.',
                'Never invent payee IDs. Choose wallet/category/payee IDs only from the provided lists.',
                'Match wallet, category, and payee names case-insensitively.',
                'If a required existing ID is not in the provided lists, set that ID to null.',
                'If a transaction or budget category does not exist and the category name is clear, set categoryId null and set pendingCategoryToCreate with the category name and correct type.',
                'If an existing category with the same name and correct type exists, use its ID and set pendingCategoryToCreate null.',
                'Do not set pendingCategoryToCreate when the category already exists.',
                'Never create duplicate categories.',
                'If unsure, set the ID to null and add the required ID field to missingFields.',
                'For merchant names like KFC, map to an existing category only if a confident category match exists.',
                'If no confident existing category match exists but the category name is clear, return it as pendingCategoryToCreate.',
                'Respect required fields by intent and include them in missingFields when absent.',
                'missingFields must contain only visible required fields for the chosen intent.',
                'Do not require transaction fields for category_create, payee_create, loan_create, investment_create, budget, or wallet_create unless listed for that intent.',
                'Do not include unsupported fields outside the requested response shape.',
                'Output date and recurring dates as ISO strings.',
                'Keep confidence between 0 and 1.',
            ].join(' '),
        },
        {
            role: 'user',
            content: JSON.stringify({
                command: prompt,
                context: {
                    currentDate: nowIso,
                    timezone,
                    currency,
                    wallets: wallets.map((wallet) => ({
                        id: wallet.$id, name: wallet.name, type: wallet.type, currency: wallet.currency,
                    })),
                    categories: categories.map((category) => ({
                        id: category.$id, name: category.name, type: category.type,
                    })),
                    payees: payees.map((payee) => ({
                        id: payee.$id,
                        name: payee.name,
                        isBusiness: !!payee.is_business,
                        loanBalance: payee.loan_balance || 0,
                        investedAmount: payee.invested_amount || 0,
                        totalProfits: payee.total_profits || 0,
                    })),
                    existingBudgets: budgets.map((budget) => ({
                        id: budget.$id,
                        name: budget.name,
                        categoryId: typeof budget.category_id === 'string' ? budget.category_id : budget.category_id?.$id,
                        amount: budget.allocated_amount,
                        period: budget.period,
                    })),
                    existingRecurringPlans: recurringPlans.map((plan) => ({
                        id: plan.$id, name: plan.name, amount: plan.amount, type: plan.type,
                        category: plan.category, interval: plan.interval,
                    })),
                    loan: {
                        appModel: 'loan actions are stored as transactions with types loan_given, loan_taken, loan_repay and a required payee/person',
                        requiredFields: ['loan.type', 'loan.personName or payee.id', 'loan.amount', 'loan.walletId', 'loan.date'],
                        allowedTypes: LOAN_TYPES,
                    },
                    investment: {
                        appModel: 'investment actions are stored as transactions with types invest_cap or invest_prof and a required payee/business',
                        requiredFields: ['investment.name or payee.id', 'investment.amount or investment.profit', 'investment.walletId', 'investment.date'],
                    },
                    category: {
                        allowedTypes: CATEGORY_TYPES,
                        requiredFields: ['categoryName', 'pendingCategoryToCreate.type'],
                    },
                    payee: { requiredFields: ['payee.name'] },
                    recurring: {
                        allowedFrequency: SUPPORTED_RECURRING_FREQUENCIES,
                        requiredFields: ['amount', 'transactionType', 'recurring.frequency', 'recurring.startDate'],
                        modelFields: ['name', 'amount', 'type', 'category', 'interval', 'start_date', 'payee_id', 'total_paid'],
                    },
                    budget: {
                        allowedPeriod: SUPPORTED_BUDGET_PERIODS,
                        requiredFields: ['budget.categoryId', 'budget.amount', 'budget.period'],
                        modelFields: ['name', 'category_id', 'allocated_amount', 'spent_amount', 'period', 'start_date', 'carry_forward'],
                    },
                    wallet: {
                        allowedTypes: WALLET_TYPES,
                        requiredFields: ['wallet.name', 'wallet.type', 'wallet.initialBalance'],
                        modelFields: ['name', 'type', 'current_balance', 'color_hex', 'icon_id'],
                        optionalModelFields: ['currency', 'credit_limit', 'due_date'],
                    },
                    allowedIntents: INTENTS,
                    allowedTransactionTypes: TRANSACTION_TYPES,
                    requiredFieldsByIntent: {
                        transaction_expense: ['transactionType', 'amount', 'fromWalletId', 'categoryId or pendingCategoryToCreate', 'date'],
                        transaction_income: ['transactionType', 'amount', 'toWalletId', 'categoryId or pendingCategoryToCreate', 'date'],
                        transaction_transfer: ['transactionType', 'amount', 'fromWalletId', 'toWalletId', 'date'],
                        category_create: ['categoryName', 'pendingCategoryToCreate.type'],
                        payee_create: ['payee.name'],
                        loan_create: ['loan.type', 'loan.personName or payee.id', 'loan.amount', 'loan.walletId', 'loan.date'],
                        investment_create: ['investment.name or payee.id', 'investment.amount or investment.profit', 'investment.walletId', 'investment.date'],
                        recurring_plan: ['amount', 'transactionType', 'recurring.frequency', 'recurring.startDate'],
                        budget: ['budget.categoryId or pendingCategoryToCreate', 'budget.amount', 'budget.period'],
                        wallet_create: ['wallet.name', 'wallet.type', 'wallet.initialBalance'],
                    },
                },
                responseShape: {
                    intent: 'transaction | category_create | payee_create | loan_create | investment_create | recurring_plan | budget | wallet_create | unknown',
                    transactionType: 'expense | income | transfer | null',
                    amount: 'number | null',
                    fromWalletId: 'string | null',
                    toWalletId: 'string | null',
                    categoryId: 'string | null',
                    categoryName: 'string | null',
                    pendingCategoryToCreate: { name: 'string | null', type: 'expense | income | null' },
                    payee: { id: 'string | null', name: 'string | null' },
                    loan: {
                        type: 'given | taken | repayment | null', personName: 'string | null',
                        amount: 'number | null', walletId: 'string | null', date: 'string | null',
                    },
                    investment: {
                        name: 'string | null', amount: 'number | null', walletId: 'string | null',
                        profit: 'number | null', date: 'string | null',
                    },
                    note: 'string | null',
                    merchant: 'string | null',
                    date: 'string | null',
                    recurring: {
                        isRecurring: 'boolean', frequency: 'daily | weekly | monthly | yearly | null',
                        startDate: 'string | null', endDate: 'string | null',
                    },
                    budget: {
                        categoryId: 'string | null', categoryName: 'string | null',
                        amount: 'number | null', period: 'monthly | yearly | null',
                    },
                    wallet: {
                        name: 'string | null', type: 'cash | bank | credit_card | null',
                        initialBalance: 'number | null', currency: 'string | null',
                    },
                    confidence: 'number from 0 to 1',
                    missingFields: 'string[]',
                },
            }),
        },
    ];
};

const callGroq = async (prompt, wallets, categories, payees, budgets, recurringPlans, context) => {
    const apiKey = GROQ_API_KEY.value();
    if (!apiKey) throw fail('AI_SERVICE_NOT_CONFIGURED', 500);

    let response;
    try {
        response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                messages: buildPrompt(prompt, wallets, categories, payees, budgets, recurringPlans, context),
                temperature: 0.1,
                response_format: { type: 'json_object' },
            }),
        });
    } catch (err) {
        // Logged server-side only — the client still gets the generic domain code.
        logEvent('aiSmartAdd.callGroq', 'failure', { reason: 'fetch_threw', errorMessage: err && err.message, errorName: err && err.name });
        throw fail('AI_SERVICE_REQUEST_FAILED', 502);
    }

    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        logEvent('aiSmartAdd.callGroq', 'failure', {
            reason: 'non_ok_response',
            httpStatus: response.status,
            bodySnippet: bodyText.slice(0, 300),
        });
        throw fail('AI_SERVICE_REQUEST_FAILED', 502);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw fail('AI_SERVICE_INVALID_RESPONSE', 502);

    try {
        return JSON.parse(content);
    } catch {
        throw fail('AI_SERVICE_INVALID_RESPONSE', 502);
    }
};

// ---------------------------------------------------------------------------
// Pending-action lifecycle — parse / confirm / cancel
// ---------------------------------------------------------------------------

const pendingCollectionIntent = (intent) => (
    ['transaction', 'recurring_plan', 'budget', 'unknown'].includes(intent) ? intent : 'unknown'
);

const serializePending = (document) => {
    const action = JSON.parse(document.action_json);
    return {
        $id: document.$id,
        prompt: document.prompt,
        intent: action.intent || document.intent,
        status: document.status,
        confidence: document.confidence || 0,
        created_at: document.created_at,
        expires_at: document.expires_at,
        action,
    };
};

const cancelPending = async (uid, pendingActionId) => {
    if (!pendingActionId) throw fail('AI_PENDING_ACTION_NOT_FOUND', 404);

    const ref = userCollection(uid, COLL_PENDING).doc(pendingActionId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw fail('AI_PENDING_ACTION_NOT_FOUND', 404);

    const pending = snapshot.data();
    if (pending.status !== 'pending') throw fail('AI_PENDING_ACTION_INACTIVE', 409);

    await deleteProvisionalCategory(uid, JSON.parse(pending.action_json));
    await ref.set({ status: 'cancelled', ...touch() }, { merge: true });
};

// ---------------------------------------------------------------------------
// Phase 4 (Part H/I/J, RC-5/RC-6) -- confirm idempotency.
//
// A `confirm:<pendingActionId>` operation mutex (reusing `withOperationMutex`
// from common.js -- the SAME mechanism splits.js already relies on, Phase 3's
// `recovery` option included) wraps the entire confirm sequence. At most one
// financial execution can ever occur per pendingActionId:
//
//   - Mutex already `completed` -> replay its cached result verbatim. No
//     financial write runs.
//   - Mutex `recovered` (stale, the previous attempt crashed before marking
//     itself completed) -> the ACTUAL pending-action state is read, never
//     the mutex, to tell apart:
//       (a) pending.status === 'confirmed' -> the whole sequence, including
//           the financial write, already landed. Reconstruct the result from
//           what was persisted.
//       (b) pending.status === 'pending' AND the deterministic transaction
//           document for this pendingActionId already exists -> the
//           financial write landed (createTransaction/createLoan/
//           createInvestment's own Firestore transaction committed) but the
//           LAST step (marking the pending action confirmed) never did.
//           Finish that step only -- no financial write runs again.
//       (c) neither signal -> genuinely never got that far; safe to run the
//           normal sequence.
//   - Busy (fresh, non-stale, still processing) -> refused; a live call may
//     still be running.
//
// `createTransaction`/`createLoan`/`createInvestment` are each given the SAME
// deterministic transaction id (`smartadd_tx_<pendingActionId>`), which is
// what makes (b) above verifiable, and is also their own independent
// idempotent-replay key if this sequence is ever re-entered (each already
// checks for that document's existence inside its own `db.runTransaction`).
// ---------------------------------------------------------------------------

const RESULT_COLLECTION_BY_TYPE = {
    transaction: COLL_TXS,
    loan: COLL_TXS,
    investment: COLL_TXS,
    recurring_plan: undefined, // resolved dynamically below (needs COLL_PLANS etc.)
};

const buildConfirmResultFromPending = async (uid, pending) => {
    const resultType = pending.result_type;
    const documentId = pending.result_document_id;
    if (!resultType || !documentId) return { result_type: resultType, result_document_id: documentId, document: null };

    const collectionByType = {
        transaction: COLL_TXS, loan: COLL_TXS, investment: COLL_TXS,
        recurring_plan: COLL_PLANS, budget: COLL_BUDGETS, wallet: COLL_WALLETS,
        category: COLL_CATEGORIES, payee: COLL_PAYEES,
    };
    const collectionName = collectionByType[resultType];
    if (!collectionName) return { result_type: resultType, result_document_id: documentId, document: null };

    const snapshot = await userCollection(uid, collectionName).doc(documentId).get();
    const document = snapshot.exists ? { $id: snapshot.id, ...snapshot.data() } : null;
    return { result_type: resultType, result_document_id: documentId, document };
};

const RESULT_TYPE_BY_TX_TYPE = {
    expense: 'transaction', income: 'transaction', transfer: 'transaction',
    loan_given: 'loan', loan_taken: 'loan', loan_repay: 'loan',
    invest_cap: 'investment', invest_prof: 'investment',
};

const finalizeRecoveredFinancialConfirm = async (uid, pendingRef, existingTx) => {
    const resultType = RESULT_TYPE_BY_TX_TYPE[existingTx.type] || 'transaction';
    await pendingRef.set(
        {
            status: 'confirmed',
            result_type: resultType,
            result_document_id: existingTx.$id,
            ...touch(),
        },
        { merge: true }
    );
    return { result_type: resultType, result_document_id: existingTx.$id, document: existingTx };
};

/** The normal (non-recovery) confirm sequence -- unchanged steps, plus the deterministic `transactionId`. */
const runConfirmSequence = async (uid, pending, pendingRef, body, pendingActionId) => {
    if (pending.status !== 'pending') throw fail('AI_PENDING_ACTION_INACTIVE', 409);

    if (new Date(pending.expires_at).getTime() <= Date.now()) {
        await deleteProvisionalCategory(uid, JSON.parse(pending.action_json));
        await pendingRef.set({ status: 'expired', ...touch() }, { merge: true });
        throw fail('AI_PENDING_ACTION_EXPIRED', 409);
    }

    const { wallets, categories, payees } = await getFinanceContext(uid);
    const pendingAction = JSON.parse(pending.action_json);
    const rawAction = body.actionData || pendingAction;
    let resolved = resolveAction(normalizeAiAction(rawAction), wallets, categories, payees);

    if (['transaction', 'budget', 'category_create'].includes(resolved.intent)) {
        resolved = await ensureConfirmedCategory(uid, resolved);
    }

    const transactionId = deterministicId('smartadd_tx', pendingActionId);

    let result;
    if (resolved.intent === 'transaction') result = await createTransaction(uid, resolved, { transactionId });
    else if (resolved.intent === 'recurring_plan') result = await createRecurringPlan(uid, resolved);
    else if (resolved.intent === 'budget') result = await createOrUpdateBudget(uid, resolved);
    else if (resolved.intent === 'wallet_create') result = await createWallet(uid, resolved);
    else if (resolved.intent === 'category_create') result = await createCategoryAction(uid, resolved);
    else if (resolved.intent === 'payee_create') result = await createPayee(uid, resolved);
    else if (resolved.intent === 'loan_create') result = await createLoan(uid, resolved, { transactionId });
    else if (resolved.intent === 'investment_create') result = await createInvestment(uid, resolved, { transactionId });
    else throw fail('AI_UNKNOWN_SMART_ACTION', 400);

    if (result.action) resolved = result.action;

    await cleanupUnusedProvisionalCategory(uid, pendingAction, resolved);
    await pendingRef.set(
        {
            status: 'confirmed',
            action_json: JSON.stringify(resolved),
            result_type: result.result_type,
            result_document_id: result.result_document_id,
            ...touch(),
        },
        { merge: true }
    );

    return result;
};

const confirmPending = async (uid, body) => {
    const pendingActionId = String(body.pendingActionId || '').trim();
    if (!pendingActionId) throw fail('AI_PENDING_ACTION_NOT_FOUND', 404);

    const pendingRef = userCollection(uid, COLL_PENDING).doc(pendingActionId);

    // Checked BEFORE the mutex, because a terminal pending action must not be
    // re-confirmed — withOperationMutex would otherwise replay the completed
    // mutex result and make a second call look successful. Timeout recovery
    // while status is still 'pending' (financial write landed, confirm step
    // not yet marked) is handled inside checkCompleted below; once status
    // has left 'pending', the action is inactive by definition.
    const preCheck = await pendingRef.get();
    if (!preCheck.exists) throw fail('AI_PENDING_ACTION_NOT_FOUND', 404);
    if (preCheck.data().status !== 'pending') throw fail('AI_PENDING_ACTION_INACTIVE', 409);

    const operationId = deterministicId('confirm', pendingActionId);

    return withOperationMutex(operationId, 'AI_SMART_ADD_CONFIRM_IN_PROGRESS', async () => {
        const snapshot = await pendingRef.get();
        if (!snapshot.exists) throw fail('AI_PENDING_ACTION_NOT_FOUND', 404);
        const pending = snapshot.data();

        return runConfirmSequence(uid, pending, pendingRef, body, pendingActionId);
    }, {
        checkCompleted: async () => {
            const snapshot = await pendingRef.get();
            if (!snapshot.exists) return null;
            const pending = snapshot.data();

            if (pending.status === 'confirmed') {
                return buildConfirmResultFromPending(uid, pending);
            }
            if (pending.status === 'pending') {
                const transactionId = deterministicId('smartadd_tx', pendingActionId);
                const txSnapshot = await userCollection(uid, COLL_TXS).doc(transactionId).get();
                if (txSnapshot.exists) {
                    return finalizeRecoveredFinancialConfirm(uid, pendingRef, { $id: txSnapshot.id, ...txSnapshot.data() });
                }
            }
            return null;
        },
    });
};

const parsePrompt = async (uid, prompt, context = {}) => {
    // §16 — a script hammering this places a real, billed Groq call every time.
    await assertRateLimit(uid, 'aiSmartAdd', { max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });

    const promptHash = sha256(`${uid}:${prompt.trim().toLowerCase()}`);
    const duplicateCutoff = Date.now() - DUPLICATE_WINDOW_MS;

    // Single-equality query (see file header for why this avoids a composite index).
    const recentSnapshot = await userCollection(uid, COLL_PENDING)
        .where('prompt_hash', '==', promptHash)
        .limit(5)
        .get();

    const duplicate = recentSnapshot.docs
        .map((doc) => ({ $id: doc.id, ...doc.data() }))
        .filter((doc) => new Date(doc.created_at).getTime() > duplicateCutoff)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (duplicate) {
        if (duplicate.status === 'pending') {
            return { pendingAction: serializePending(duplicate), duplicate: true };
        }
        throw fail('AI_DUPLICATE_ACTION', 409);
    }

    const { wallets, categories, payees, budgets, recurringPlans } = await getFinanceContext(uid);
    const aiPayload = await callGroq(prompt, wallets, categories, payees, budgets, recurringPlans, context);
    const resolved = resolveAction(normalizeAiAction(aiPayload), wallets, categories, payees);

    const now = new Date();
    const ref = userCollection(uid, COLL_PENDING).doc();
    const pendingData = {
        user_id: uid,
        prompt,
        prompt_hash: promptHash,
        intent: pendingCollectionIntent(resolved.intent),
        status: 'pending',
        action_json: JSON.stringify(resolved),
        confidence: resolved.confidence,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
        ...stamps(),
    };
    await ref.set(pendingData);

    return { pendingAction: serializePending({ $id: ref.id, ...pendingData }) };
};

// ---------------------------------------------------------------------------
// Callable
// ---------------------------------------------------------------------------

const aiSmartAddHandler = async (request) => {
    const uid = requireAuth(request);
    await requirePro(uid);

    const data = request.data || {};
    const action = data.action;

    if (action === 'cancel') {
        await cancelPending(uid, String(data.pendingActionId || '').trim());
        return { success: true };
    }

    if (action === 'confirm') {
        const result = await confirmPending(uid, data);
        return { success: true, ...result };
    }

    const prompt = cleanText(data.prompt, 1000);
    if (!prompt) throw fail('AI_PROMPT_REQUIRED', 400);

    const result = await parsePrompt(uid, prompt, {
        timezone: cleanText(data.timezone, 120),
        currency: cleanText(data.currency, 20),
    });
    return { success: true, ...result };
};

// §43: one structured record per invocation — operation, uid, outcome, duration
// and error category. Sensitive keys are scrubbed in withLogging; `prompt` itself
// is user finance text, not a secret, but is still left out of the log fields —
// only the action/intent shape is recorded.
const aiSmartAdd = onCall(
    { region: REGION, timeoutSeconds: 60, maxInstances: 10, secrets: [GROQ_API_KEY] },
    (request) =>
        withLogging(
            'aiSmartAdd',
            request.auth && request.auth.uid,
            { action: (request.data && request.data.action) || 'parse' },
            () => aiSmartAddHandler(request)
        )
);

module.exports = {
    aiSmartAdd,
    // Exported for unit tests — pure functions, no Firestore/network access.
    normalizeAiAction,
    resolveAction,
    recomputeMissingFields,
    applyDefaults,
    buildPrompt,
    // Exported for functional tests against the Firestore emulator — the real
    // confirm/cancel lifecycle, bypassing the `onCall`/auth/Pro-gate wrapper, the
    // same pattern automations.js and common.js already use for their own tests.
    confirmPending,
    cancelPending,
};
