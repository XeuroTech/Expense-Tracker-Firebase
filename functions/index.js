/**
 * Cloud Functions entry point — Unity Finance, FIREBASE PROVIDER.
 *
 * ── THE APPWRITE FUNCTIONS ARE UNTOUCHED ────────────────────────────────────────
 * All 23 remain deployed in `backend/functions/` and keep serving the Appwrite
 * provider. Nothing here replaces, disables or supersedes them. Both exist:
 *
 *     Appwrite Function   +   Firebase Function
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────────
 *
 * `financeSync`
 *     No equivalent, by design. Every guard it performs is expressible in Security
 *     Rules (see firestore.rules), so under Firebase the finance mirror is a direct,
 *     rules-enforced client path. The one guard that does NOT move is the Pro gate —
 *     it stays at the sync layer so the failure mode remains "sync stops" rather than
 *     "writes are denied". The Appwrite `finance-sync` function keeps running.
 *
 * `testProUpgrade`
 *     Deployed and USER-INVOKABLE on Appwrite — anyone who finds the endpoint can
 *     grant themselves Pro. It must not gain a Firebase equivalent. The client
 *     adapter rejects locally.
 *
 * `evaluateAutomations` — NOW PORTED as `evaluateAutomationsOnTransactionCreate`.
 *     Previously deferred: the Appwrite function lists active automations
 *     PROJECT-WIDE rather than scoping to the transaction's owner, has no recursion
 *     guard, and the default rule shape can match its own output. All three gaps
 *     are closed in the Firestore version — see src/automations.js for exactly how:
 *     owner scoping is structural (the trigger fires on `users/{uid}/transactions`,
 *     never a collection-group query), a recursion guard (`origin: 'automation'`)
 *     stops an automation-authored transaction from re-triggering, and an
 *     independent depth ceiling backstops that guard. The Appwrite function is
 *     unchanged and keeps running as-is.
 *
 * `createTransaction`, `updateTransaction`, `deleteTransaction`, `updateCategory`,
 * `deleteCategory`
 *     Dead on Appwrite — deployed with zero frontend references. Not reproduced, and
 *     not deleted from Appwrite either.
 *
 * `verifyEmail`, `resetPassword`
 *     Replaced by the platform: `sendEmailVerification()` and
 *     `sendPasswordResetEmail()` / `confirmPasswordReset()`.
 *
 * `aiSmartAdd` — NOW PORTED.
 *     See src/aiSmartAdd.js + src/aiSmartAddActions.js. Requires the `GROQ_API_KEY`
 *     secret to be set (`firebase functions:secrets:set GROQ_API_KEY`) before the
 *     parse path can actually call the model; auth, Pro-gating, rate limiting and
 *     the confirm/cancel lifecycle all work without it.
 */

const users = require('./src/users');
const friends = require('./src/friends');
const splits = require('./src/splits');
const notifications = require('./src/notifications');
const account = require('./src/account');
const billing = require('./src/billing');
const automations = require('./src/automations');
const aiSmartAdd = require('./src/aiSmartAdd');

// --- identity ---------------------------------------------------------------
exports.onUserCreated = users.onUserCreated;
exports.onUserDeleted = users.onUserDeleted;
exports.syncPublicProfile = users.syncPublicProfile;
exports.syncMyProfile = users.syncMyProfile;
exports.searchUsers = users.searchUsers;

// --- friends ----------------------------------------------------------------
exports.sendFriendRequest = friends.sendFriendRequest;
exports.respondFriendRequest = friends.respondFriendRequest;
exports.listFriends = friends.listFriends;
exports.listFriendRequests = friends.listFriendRequests;
exports.removeFriend = friends.removeFriend;
exports.refreshFriendAvatar = friends.refreshFriendAvatar;

// --- splits -----------------------------------------------------------------
exports.createSplitExpense = splits.createSplitExpense;
exports.respondSplitRequest = splits.respondSplitRequest;
exports.settleSplitPayment = splits.settleSplitPayment;

// --- notifications ----------------------------------------------------------
exports.onNotificationCreated = notifications.onNotificationCreated;
exports.notificationActions = notifications.notificationActions;
exports.registerDeviceToken = notifications.registerDeviceToken;

// --- account ----------------------------------------------------------------
exports.deleteAccount = account.deleteAccount;
exports.requestEmailChange = account.requestEmailChange;
exports.confirmEmailChange = account.confirmEmailChange;
exports.purgeTombstones = account.purgeTombstones;

// --- billing ----------------------------------------------------------------
exports.verifyGooglePurchase = billing.verifyGooglePurchase;
exports.verifyApplePurchase = billing.verifyApplePurchase;
exports.playRtdnHandler = billing.playRtdnHandler;
exports.appleNotificationsV2Handler = billing.appleNotificationsV2Handler;

// --- automation ---------------------------------------------------------------
exports.evaluateAutomationsOnTransactionCreate = automations.evaluateAutomationsOnTransactionCreate;

// --- AI smart add -------------------------------------------------------------
exports.aiSmartAdd = aiSmartAdd.aiSmartAdd;
