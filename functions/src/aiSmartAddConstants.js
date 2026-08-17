/**
 * Constants for the `aiSmartAdd` callable — verbatim from
 * `backend/functions/ai_smart_add/src/constants.js`, with two changes:
 *
 *   1. There is no `DB_ID`/`COLL_*` Appwrite collection-id map. The Firestore
 *      equivalent is a plain table NAME, resolved to `users/{uid}/{table}` by the
 *      caller — see the `collection()` calls in aiSmartAddActions.js.
 *   2. `COLL_PENDING` is `ai_pending_actions`, same as Appwrite, but lives at
 *      `users/{uid}/ai_pending_actions` (owner-scoped by construction) rather than
 *      a flat collection guarded by a `user_id` field. It is NOT in
 *      `OWNER_SCOPED_TABLES` (frontend/src/backend/firebase/paths.ts) and therefore
 *      not in Security Rules' `isFinanceCollection()` allowlist either — the
 *      client cannot read or write it under any table name, by construction. Only
 *      this callable (Admin SDK) ever touches it.
 */

module.exports = {
    COLL_WALLETS: 'wallets',
    COLL_PAYEES: 'payees',
    COLL_CATEGORIES: 'categories',
    COLL_TXS: 'transactions',
    COLL_PLANS: 'recurring_plans',
    COLL_BUDGETS: 'budgets',
    COLL_BUDGET_PERIODS: 'budget_periods',
    COLL_PENDING: 'ai_pending_actions',
    // llama-3.3-70b-versatile was deprecated/shut down by Groq on 2026-08-16 —
    // every call to it now fails, which surfaced to users as AI_SERVICE_REQUEST_FAILED.
    // openai/gpt-oss-120b is Groq's recommended replacement (supports the same
    // response_format: 'json_object' this callable relies on).
    MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    GROQ_BASE_URL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    PENDING_TTL_MS: 30 * 60 * 1000,
    DUPLICATE_WINDOW_MS: 5 * 60 * 1000,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX: 8,
    INTENTS: [
        'transaction',
        'category_create',
        'payee_create',
        'loan_create',
        'investment_create',
        'recurring_plan',
        'budget',
        'wallet_create',
        'unknown',
    ],
    TRANSACTION_TYPES: ['expense', 'income', 'transfer'],
    LOAN_TYPES: ['given', 'taken', 'repayment'],
    WALLET_TYPES: ['cash', 'bank', 'credit_card'],
    FREQUENCIES: ['daily', 'weekly', 'monthly', 'yearly'],
    SUPPORTED_RECURRING_FREQUENCIES: ['weekly', 'monthly', 'yearly'],
    BUDGET_PERIODS: ['weekly', 'monthly', 'yearly'],
    SUPPORTED_BUDGET_PERIODS: ['monthly', 'yearly'],
    CATEGORY_TYPES: ['expense', 'income'],
};
