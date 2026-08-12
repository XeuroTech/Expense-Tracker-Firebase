/**
 * `aiSmartAdd` confirm-time actions — the Firebase counterpart of
 * `backend/functions/ai_smart_add/src/actions.js`.
 *
 * ── WHAT CHANGED AND WHY (all unobservable — see splits.js for the same posture) ──
 *
 *   OWNERSHIP CHECKS DROPPED. `getOwnedDocument` there fetches from a flat
 *   collection and then checks `document.user_id === userId`. Every read here goes
 *   through `users/{uid}/{collection}/{docId}` instead — a document at that path
 *   cannot belong to another user, so the check is structurally redundant. This is
 *   the same "owner comes from the path" argument firestore.rules already makes for
 *   the client side.
 *
 *   NO PERMISSIONS ARRAY. Appwrite's `Permission.read/update/delete(Role.user(...))`
 *   has no Firestore analogue; access is governed by Security Rules against the
 *   path, not a per-document ACL.
 *
 *   NO SCHEMA FALLBACK. `createDocumentWithSchemaFallback` / `listAttributeKeys`
 *   exist purely because Appwrite collections have a fixed attribute schema that
 *   can reject an unknown field. Firestore documents are schemaless — there is
 *   nothing to fall back from.
 *
 *   MONEY ROUNDING. Wallet/payee balance mutations go through `applyBalanceDelta`
 *   (round-to-cents), the same helper `splits.js` and `automations.js` use, instead
 *   of Appwrite's un-rounded `a - b`. Eliminates float noise; does not change any
 *   result for a real currency amount.
 *
 * Every document handed back or matched against uses Appwrite's `$id` convention
 * (`{ $id: doc.id, ...doc.data() }`) rather than Firestore's native `.id`, so the
 * resolution logic in aiSmartAdd.js — copied close to verbatim from
 * `validation.js`, which is written entirely in terms of `.$id` — needs no changes.
 */

const { db, fail, stamps, touch, applyBalanceDelta } = require('./common');
const {
    COLL_WALLETS,
    COLL_PAYEES,
    COLL_CATEGORIES,
    COLL_TXS,
    COLL_PLANS,
    COLL_BUDGETS,
    COLL_BUDGET_PERIODS,
    TRANSACTION_TYPES,
    SUPPORTED_RECURRING_FREQUENCIES,
    SUPPORTED_BUDGET_PERIODS,
    WALLET_TYPES,
} = require('./aiSmartAddConstants');

const AUTO_CATEGORY_COLORS = ['#FF6B6B', '#4ECDC4', '#2ECC71', '#FFA502', '#9C27B0'];
const WALLET_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98FB98', '#DDA0DD'];
const DEFAULT_CURRENCY = '$';
const WALLET_CURRENCIES = {
    '$': '$', usd: '$', dollar: '$', dollars: '$',
    rs: 'Rs', pkr: 'Rs', rupee: 'Rs', rupees: 'Rs',
    '€': '€', eur: '€', euro: '€', euros: '€',
    '£': '£', gbp: '£', pound: '£', pounds: '£',
    'د.إ': 'د.إ', aed: 'د.إ', dirham: 'د.إ', dirhams: 'د.إ',
    '₹': '₹', inr: '₹',
};

const normalizeWalletCurrency = (currency) => {
    if (typeof currency !== 'string') return DEFAULT_CURRENCY;
    const normalized = currency.trim().toLowerCase();
    return WALLET_CURRENCIES[normalized] || DEFAULT_CURRENCY;
};

const stripUndefined = (data) => {
    const clean = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'undefined') clean[key] = value;
    }
    return clean;
};

const normalizeName = (value) => (
    typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : ''
);

const sameName = (left, right) => {
    const normalizedLeft = normalizeName(left);
    const normalizedRight = normalizeName(right);
    return !!normalizedLeft && normalizedLeft === normalizedRight;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const userCollection = (uid, collectionName) => db.collection('users').doc(uid).collection(collectionName);

/** `getOwnedDocument`, minus the ownership check — see header. */
const getRequiredDoc = async (uid, collectionName, documentId, notFoundCode) => {
    if (!documentId) throw fail(notFoundCode, 404);
    const snapshot = await userCollection(uid, collectionName).doc(documentId).get();
    if (!snapshot.exists || snapshot.data()._deletedAt) {
        throw fail(notFoundCode, 404);
    }
    return { $id: snapshot.id, ...snapshot.data() };
};

const listOwnedDocuments = async (uid, collectionName, max = 100) => {
    const snapshot = await userCollection(uid, collectionName)
        .where('_deletedAt', '==', null)
        .limit(max)
        .get();
    return snapshot.docs.map((doc) => ({ $id: doc.id, ...doc.data() }));
};

const findOwnedByName = async (uid, collectionName, name, predicate = () => true) => {
    if (!name) return null;
    const documents = await listOwnedDocuments(uid, collectionName);
    return documents.find((document) => sameName(document.name, name) && predicate(document)) || null;
};

/** `listUserDocs` — the finance context handed to the prompt and to resolution. */
const getFinanceContext = async (uid) => {
    const [wallets, categories, payees, budgets, recurringPlans] = await Promise.all([
        listOwnedDocuments(uid, COLL_WALLETS),
        listOwnedDocuments(uid, COLL_CATEGORIES),
        listOwnedDocuments(uid, COLL_PAYEES),
        listOwnedDocuments(uid, COLL_BUDGETS),
        listOwnedDocuments(uid, COLL_PLANS),
    ]);
    return { wallets, categories, payees, budgets, recurringPlans };
};

// ---------------------------------------------------------------------------
// Category resolution
// ---------------------------------------------------------------------------

const getRequestedCategoryName = (action) => {
    if (action.intent === 'budget') return action.budget.category || action.category;
    if (action.intent === 'transaction') return action.category;
    return null;
};

const getCategoryType = (action) => (action.transactionType === 'income' ? 'income' : 'expense');

const getPendingCategory = (action) => {
    const pending = action.pendingCategoryToCreate || {};
    const name = pending.name || action.categoryName || getRequestedCategoryName(action);
    const type = pending.type || getCategoryType(action);
    if (!name || !['expense', 'income'].includes(type)) return null;
    return { name: name.trim(), type };
};

const applyCategoryMatch = (action, category) => ({
    ...action,
    categoryId: category.$id,
    category: category.name,
    categoryName: category.name,
    pendingCategoryToCreate: null,
    budget: {
        ...(action.budget || {}),
        category: action.intent === 'budget' ? category.name : action.budget?.category,
        categoryName: action.intent === 'budget' ? category.name : action.budget?.categoryName,
        categoryId: action.intent === 'budget' ? category.$id : action.budget?.categoryId,
    },
    matches: { ...(action.matches || {}), categoryId: category.$id },
});

const createConfirmedCategory = async (uid, name, type) => {
    const existing = await findOwnedByName(uid, COLL_CATEGORIES, name, (category) => category.type === type);
    if (existing) return existing;

    const colorIndex = Math.abs(name.length + type.length) % AUTO_CATEGORY_COLORS.length;
    const ref = userCollection(uid, COLL_CATEGORIES).doc();
    await ref.set({
        user_id: uid,
        name,
        type,
        color: AUTO_CATEGORY_COLORS[colorIndex],
        icon: type === 'income' ? 'cash-outline' : 'pricetag-outline',
        ...stamps(),
    });
    const written = await ref.get();
    return { $id: ref.id, ...written.data() };
};

const ensureConfirmedCategory = async (uid, action) => {
    if (!['transaction', 'budget', 'category_create'].includes(action.intent)) return action;
    if (action.intent === 'transaction' && action.transactionType === 'transfer') return action;

    if (action.matches?.categoryId) {
        const category = await getRequiredDoc(uid, COLL_CATEGORIES, action.matches.categoryId, 'AI_CATEGORY_NOT_FOUND');
        return applyCategoryMatch(action, category);
    }

    const pending = getPendingCategory(action);
    if (!pending) return action;

    const duplicateAnyType = await findOwnedByName(uid, COLL_CATEGORIES, pending.name);
    if (duplicateAnyType && duplicateAnyType.type !== pending.type) return action;

    const category = duplicateAnyType || await createConfirmedCategory(uid, pending.name, pending.type);
    return applyCategoryMatch(action, category);
};

/**
 * Ported for module parity with actions.js — NOT reachable from the current
 * parse/confirm flow (main.js never imports it either; `ensureConfirmedCategory`
 * is what confirm actually uses). Kept so `deleteProvisionalCategory` /
 * `cleanupUnusedProvisionalCategory` below have a real producer of
 * `matches.autoCategoryId` if a future flow starts calling it, exactly as in
 * the Appwrite source.
 */
const createProvisionalCategory = async (uid, action) => {
    if (!['transaction', 'budget'].includes(action.intent)) return action;
    if (action.matches?.categoryId) return action;

    const categoryName = getRequestedCategoryName(action);
    if (!categoryName) return action;

    const type = getCategoryType(action);
    const colorIndex = Math.abs(categoryName.length + type.length) % AUTO_CATEGORY_COLORS.length;
    const ref = userCollection(uid, COLL_CATEGORIES).doc();
    await ref.set({
        user_id: uid,
        name: categoryName,
        type,
        color: AUTO_CATEGORY_COLORS[colorIndex],
        icon: type === 'income' ? 'cash-outline' : 'pricetag-outline',
        ...stamps(),
    });

    return {
        ...action,
        category: categoryName,
        budget: { ...action.budget, category: action.intent === 'budget' ? categoryName : action.budget.category },
        matches: {
            ...(action.matches || {}),
            categoryId: ref.id,
            autoCategoryId: ref.id,
            autoCategoryName: categoryName,
        },
        missingFields: (action.missingFields || []).filter((f) => f !== 'category' && f !== 'budget.category'),
    };
};

const deleteProvisionalCategory = async (uid, action) => {
    const categoryId = action?.matches?.autoCategoryId;
    if (!categoryId) return;

    const ref = userCollection(uid, COLL_CATEGORIES).doc(categoryId);
    const snapshot = await ref.get();
    if (snapshot.exists) await ref.delete();
};

const cleanupUnusedProvisionalCategory = async (uid, originalAction, confirmedAction) => {
    const autoCategoryId = originalAction?.matches?.autoCategoryId;
    if (!autoCategoryId || confirmedAction?.matches?.categoryId === autoCategoryId) return;
    await deleteProvisionalCategory(uid, originalAction);
};

// ---------------------------------------------------------------------------
// Payee resolution
// ---------------------------------------------------------------------------

const createOrFindPayee = async (uid, name, isBusiness = false) => {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return null;

    const existing = await findOwnedByName(uid, COLL_PAYEES, cleanName);
    if (existing) return existing;

    const ref = userCollection(uid, COLL_PAYEES).doc();
    await ref.set({
        user_id: uid,
        name: cleanName,
        is_business: !!isBusiness,
        loan_balance: 0,
        invested_amount: 0,
        total_profits: 0,
        ...stamps(),
    });
    const written = await ref.get();
    return { $id: ref.id, ...written.data() };
};

const ensurePayeeForAction = async (uid, action, isBusiness = false) => {
    const payeeId = action.matches?.payeeId || action.payee?.id;
    if (payeeId) {
        const payee = await getRequiredDoc(uid, COLL_PAYEES, payeeId, 'AI_PAYEE_NOT_FOUND');
        return {
            action: {
                ...action,
                payee: { ...(action.payee || {}), id: payee.$id, name: payee.name },
                matches: { ...(action.matches || {}), payeeId: payee.$id },
            },
            payee,
        };
    }

    const name = action.payee?.name || action.loan?.personName || action.investment?.name;
    const payee = await createOrFindPayee(uid, name, isBusiness);
    if (!payee) return { action, payee: null };

    return {
        action: {
            ...action,
            payee: { ...(action.payee || {}), id: payee.$id, name: payee.name },
            matches: { ...(action.matches || {}), payeeId: payee.$id },
        },
        payee,
    };
};

// ---------------------------------------------------------------------------
// Budget side-effects of a transaction — updateBudgetsForTransaction
// ---------------------------------------------------------------------------

const updateBudgetsForTransaction = async (uid, type, categoryId, amount, date) => {
    if (type !== 'expense' || !categoryId) return;

    const budgetsSnapshot = await userCollection(uid, COLL_BUDGETS)
        .where('category_id', '==', categoryId)
        .limit(25)
        .get();

    const txDate = new Date(date);

    for (const budgetDoc of budgetsSnapshot.docs) {
        const budget = budgetDoc.data();
        if (budget._deletedAt) continue;

        await budgetDoc.ref.set(
            { spent_amount: applyBalanceDelta(Number(budget.spent_amount) || 0, amount), ...touch() },
            { merge: true }
        );

        const periodsSnapshot = await userCollection(uid, COLL_BUDGET_PERIODS)
            .where('budget_id', '==', budgetDoc.id)
            .limit(50)
            .get();

        for (const periodDoc of periodsSnapshot.docs) {
            const period = periodDoc.data();
            if (period._deletedAt) continue;

            const starts = new Date(period.period_start);
            const ends = new Date(period.period_end);
            if (txDate >= starts && txDate <= ends) {
                await periodDoc.ref.set(
                    { spent_amount: applyBalanceDelta(Number(period.spent_amount) || 0, amount), ...touch() },
                    { merge: true }
                );
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Confirm-time actions — one per intent
// ---------------------------------------------------------------------------

const createTransaction = async (uid, action) => {
    const type = action.transactionType;
    const amount = action.amount;
    const walletId = type === 'income'
        ? (action.matches.toWalletId || action.matches.fromWalletId)
        : action.matches.fromWalletId;
    const toWalletId = action.matches.toWalletId;
    const categoryId = action.matches.categoryId;
    const payeeId = action.matches.payeeId || action.payee?.id;

    if (!TRANSACTION_TYPES.includes(type) || !amount || amount <= 0 || !walletId) {
        throw fail('AI_MISSING_TRANSACTION_DETAILS', 400);
    }
    if (['expense', 'income'].includes(type) && !categoryId) throw fail('AI_MISSING_TRANSACTION_CATEGORY', 400);
    if (type === 'transfer' && !toWalletId) throw fail('AI_MISSING_DESTINATION_WALLET', 400);

    const walletRef = userCollection(uid, COLL_WALLETS).doc(walletId);
    const destRef = type === 'transfer' ? userCollection(uid, COLL_WALLETS).doc(toWalletId) : null;
    const payeeRef = payeeId ? userCollection(uid, COLL_PAYEES).doc(payeeId) : null;
    const txRef = userCollection(uid, COLL_TXS).doc();

    const date = action.date || new Date().toISOString();
    let note = action.note || action.merchant || null;

    await db.runTransaction(async (tx) => {
        // ---- READ PHASE ----
        const walletSnap = await tx.get(walletRef);
        if (!walletSnap.exists || walletSnap.data()._deletedAt) throw fail('AI_WALLET_NOT_FOUND', 404);

        const destSnap = destRef ? await tx.get(destRef) : null;
        if (destRef && (!destSnap.exists || destSnap.data()._deletedAt)) {
            throw fail('AI_DESTINATION_WALLET_NOT_FOUND', 404);
        }

        if (payeeRef) {
            const payeeSnap = await tx.get(payeeRef);
            if (!payeeSnap.exists || payeeSnap.data()._deletedAt) throw fail('AI_PAYEE_NOT_FOUND', 404);
        }

        const walletBalance = Number(walletSnap.data().current_balance) || 0;
        const walletDelta = type === 'income' ? amount : -amount;
        const nextWalletBalance = applyBalanceDelta(walletBalance, walletDelta);

        if (nextWalletBalance < 0) throw fail('AI_INSUFFICIENT_BALANCE', 400);
        if (!note && type === 'transfer') note = `Transfer to ${destSnap.data().name}`;

        // ---- WRITE PHASE ----
        tx.set(txRef, {
            user_id: uid,
            amount,
            type,
            wallet_id: walletId,
            payee_id: payeeId || null,
            category_id: categoryId || null,
            date,
            note,
            ...stamps(),
        });

        tx.update(walletRef, { current_balance: nextWalletBalance, ...touch() });

        if (destRef) {
            const destBalance = Number(destSnap.data().current_balance) || 0;
            tx.update(destRef, { current_balance: applyBalanceDelta(destBalance, amount), ...touch() });
        }
    });

    await updateBudgetsForTransaction(uid, type, categoryId, amount, date);

    const written = await txRef.get();
    return { result_type: 'transaction', result_document_id: txRef.id, document: { $id: txRef.id, ...written.data() } };
};

const createRecurringPlan = async (uid, action) => {
    const frequency = action.recurring.frequency;

    if (!action.amount || !SUPPORTED_RECURRING_FREQUENCIES.includes(frequency)) {
        throw fail('AI_MISSING_RECURRING_DETAILS', 400);
    }
    if (!['expense', 'income'].includes(action.transactionType)) throw fail('AI_MISSING_RECURRING_TYPE', 400);

    const name = action.merchant || action.note || action.categoryName || action.category || 'Smart recurring plan';
    const category = action.transactionType === 'income' ? 'income' : 'expense';

    const ref = userCollection(uid, COLL_PLANS).doc();
    await ref.set({
        user_id: uid,
        name,
        amount: action.amount,
        type: 'fixed',
        category,
        interval: frequency,
        start_date: action.recurring.startDate || action.date || new Date().toISOString(),
        total_paid: 0,
        ...stamps(),
    });

    const written = await ref.get();
    return { result_type: 'recurring_plan', result_document_id: ref.id, document: { $id: ref.id, ...written.data() } };
};

const budgetStartDate = (period) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    if (period === 'monthly') date.setDate(1);
    if (period === 'yearly') {
        date.setMonth(0);
        date.setDate(1);
    }
    return date.toISOString();
};

const createOrUpdateBudget = async (uid, action) => {
    const categoryId = action.budget.categoryId || action.matches.categoryId;
    const amount = action.budget.amount || action.amount;
    const period = action.budget.period || 'monthly';

    if (!categoryId || !amount || !SUPPORTED_BUDGET_PERIODS.includes(period)) {
        throw fail('AI_MISSING_BUDGET_DETAILS', 400);
    }

    const category = await getRequiredDoc(uid, COLL_CATEGORIES, categoryId, 'AI_CATEGORY_NOT_FOUND');

    const existingSnapshot = await userCollection(uid, COLL_BUDGETS)
        .where('category_id', '==', categoryId)
        .limit(25)
        .get();
    const existing = existingSnapshot.docs.find((doc) => !doc.data()._deletedAt && doc.data().period === period);

    if (existing) {
        await existing.ref.set(
            { allocated_amount: amount, start_date: budgetStartDate(period), ...touch() },
            { merge: true }
        );
        const written = await existing.ref.get();
        return { result_type: 'budget', result_document_id: existing.id, document: { $id: existing.id, ...written.data() } };
    }

    const ref = userCollection(uid, COLL_BUDGETS).doc();
    await ref.set({
        user_id: uid,
        name: `${category.name} Budget`,
        category_id: categoryId,
        allocated_amount: amount,
        spent_amount: 0,
        period,
        start_date: budgetStartDate(period),
        carry_forward: false,
        ...stamps(),
    });

    const written = await ref.get();
    return { result_type: 'budget', result_document_id: ref.id, document: { $id: ref.id, ...written.data() } };
};

const createWallet = async (uid, action) => {
    const wallet = action.wallet || {};
    const name = typeof wallet.name === 'string' ? wallet.name.trim() : '';
    const type = wallet.type;
    const balance = Number(wallet.currentBalance ?? wallet.initialBalance);

    if (!name) throw fail('AI_MISSING_WALLET_NAME', 400);
    if (!WALLET_TYPES.includes(type)) throw fail('AI_MISSING_WALLET_TYPE', 400);
    if (!Number.isFinite(balance) || balance < 0) throw fail('AI_MISSING_WALLET_BALANCE', 400);

    const colorIndex = Math.abs(name.length + type.length) % WALLET_COLORS.length;
    const ref = userCollection(uid, COLL_WALLETS).doc();

    await ref.set(stripUndefined({
        user_id: uid,
        name,
        type,
        current_balance: balance,
        currency: wallet.currency ? normalizeWalletCurrency(wallet.currency) : undefined,
        color_hex: wallet.colorHex || WALLET_COLORS[colorIndex],
        icon_id: wallet.iconId || undefined,
        ...stamps(),
    }));

    const written = await ref.get();
    return { result_type: 'wallet', result_document_id: ref.id, document: { $id: ref.id, ...written.data() } };
};

const createCategoryAction = async (uid, action) => {
    const resolved = await ensureConfirmedCategory(uid, action);
    const categoryId = resolved.matches?.categoryId;
    if (!categoryId) throw fail('AI_MISSING_CATEGORY_DETAILS', 400);

    const category = await getRequiredDoc(uid, COLL_CATEGORIES, categoryId, 'AI_CATEGORY_NOT_FOUND');
    return { result_type: 'category', result_document_id: category.$id, document: category, action: resolved };
};

const createPayee = async (uid, action) => {
    const { action: resolved, payee } = await ensurePayeeForAction(uid, action, false);
    if (!payee) throw fail('AI_MISSING_PAYEE_DETAILS', 400);
    return { result_type: 'payee', result_document_id: payee.$id, document: payee, action: resolved };
};

const createLoan = async (uid, action) => {
    if (action.loan?.type === 'repayment' && !(action.matches?.payeeId || action.payee?.id)) {
        throw fail('AI_MISSING_LOAN_PAYEE', 400);
    }

    const { action: withPayee, payee } = await ensurePayeeForAction(uid, action, false);
    const loan = withPayee.loan || {};
    const amount = loan.amount;
    const walletId = withPayee.matches?.loanWalletId || loan.walletId;
    const loanTypeMap = { given: 'loan_given', taken: 'loan_taken', repayment: 'loan_repay' };
    const type = loanTypeMap[loan.type];

    if (!type || !amount || amount <= 0 || !walletId || !payee) {
        throw fail('AI_MISSING_LOAN_DETAILS', 400);
    }

    const walletRef = userCollection(uid, COLL_WALLETS).doc(walletId);
    const payeeRef = userCollection(uid, COLL_PAYEES).doc(payee.$id);
    const txRef = userCollection(uid, COLL_TXS).doc();
    const date = loan.date || withPayee.date || new Date().toISOString();
    const note = withPayee.note || `Loan ${loan.type} ${payee.name}`;

    await db.runTransaction(async (tx) => {
        const walletSnap = await tx.get(walletRef);
        if (!walletSnap.exists || walletSnap.data()._deletedAt) throw fail('AI_WALLET_NOT_FOUND', 404);
        const payeeSnap = await tx.get(payeeRef);
        if (!payeeSnap.exists || payeeSnap.data()._deletedAt) throw fail('AI_PAYEE_NOT_FOUND', 404);

        const walletBalance = Number(walletSnap.data().current_balance) || 0;
        const loanBalance = Number(payeeSnap.data().loan_balance) || 0;

        let walletDelta = 0;
        let loanDelta = 0;

        if (type === 'loan_given') {
            walletDelta = -amount;
            loanDelta = amount;
        } else if (type === 'loan_taken') {
            walletDelta = amount;
            loanDelta = -amount;
        } else if (type === 'loan_repay') {
            if (loanBalance > 0) {
                walletDelta = amount;
                loanDelta = -amount;
            } else {
                walletDelta = -amount;
                loanDelta = amount;
            }
        }

        tx.set(txRef, {
            user_id: uid,
            amount,
            type,
            wallet_id: walletId,
            payee_id: payee.$id,
            date,
            note,
            ...stamps(),
        });
        tx.update(walletRef, { current_balance: applyBalanceDelta(walletBalance, walletDelta), ...touch() });
        tx.update(payeeRef, { loan_balance: applyBalanceDelta(loanBalance, loanDelta), ...touch() });
    });

    const written = await txRef.get();
    return {
        result_type: 'loan',
        result_document_id: txRef.id,
        document: { $id: txRef.id, ...written.data() },
        action: withPayee,
    };
};

const createInvestment = async (uid, action) => {
    const { action: withPayee, payee } = await ensurePayeeForAction(uid, action, true);
    const investment = withPayee.investment || {};
    const amount = investment.profit || investment.amount;
    const walletId = withPayee.matches?.investmentWalletId || investment.walletId;
    const type = investment.profit ? 'invest_prof' : 'invest_cap';

    if (!amount || amount <= 0 || !walletId || !payee) throw fail('AI_MISSING_INVESTMENT_DETAILS', 400);

    const walletRef = userCollection(uid, COLL_WALLETS).doc(walletId);
    const payeeRef = userCollection(uid, COLL_PAYEES).doc(payee.$id);
    const txRef = userCollection(uid, COLL_TXS).doc();
    const date = investment.date || withPayee.date || new Date().toISOString();
    const note = withPayee.note || (type === 'invest_prof'
        ? `Investment profit from ${payee.name}`
        : `Investment in ${payee.name}`);

    await db.runTransaction(async (tx) => {
        const walletSnap = await tx.get(walletRef);
        if (!walletSnap.exists || walletSnap.data()._deletedAt) throw fail('AI_WALLET_NOT_FOUND', 404);
        const payeeSnap = await tx.get(payeeRef);
        if (!payeeSnap.exists || payeeSnap.data()._deletedAt) throw fail('AI_PAYEE_NOT_FOUND', 404);

        const walletBalance = Number(walletSnap.data().current_balance) || 0;
        const walletDelta = type === 'invest_prof' ? amount : -amount;

        tx.set(txRef, {
            user_id: uid,
            amount,
            type,
            wallet_id: walletId,
            payee_id: payee.$id,
            date,
            note,
            ...stamps(),
        });
        tx.update(walletRef, { current_balance: applyBalanceDelta(walletBalance, walletDelta), ...touch() });

        if (type === 'invest_prof') {
            const totalProfits = Number(payeeSnap.data().total_profits) || 0;
            tx.update(payeeRef, { total_profits: applyBalanceDelta(totalProfits, amount), ...touch() });
        } else {
            const invested = Number(payeeSnap.data().invested_amount) || 0;
            tx.update(payeeRef, { invested_amount: applyBalanceDelta(invested, amount), ...touch() });
        }
    });

    const written = await txRef.get();
    return {
        result_type: 'investment',
        result_document_id: txRef.id,
        document: { $id: txRef.id, ...written.data() },
        action: withPayee,
    };
};

module.exports = {
    userCollection,
    getRequiredDoc,
    listOwnedDocuments,
    findOwnedByName,
    getFinanceContext,
    ensureConfirmedCategory,
    createProvisionalCategory,
    deleteProvisionalCategory,
    cleanupUnusedProvisionalCategory,
    ensurePayeeForAction,
    createTransaction,
    createRecurringPlan,
    createOrUpdateBudget,
    createWallet,
    createCategoryAction,
    createPayee,
    createLoan,
    createInvestment,
};
