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
 * `evaluateAutomations`
 *     NOT PORTED, and this is a decision rather than an omission. The Appwrite
 *     function lists active automations PROJECT-WIDE rather than scoping to the
 *     transaction's owner, and it has no recursion guard while the default rule shape
 *     can match its own output. Firestore makes both worse: triggers fire on Admin
 *     SDK writes too, so the blast radius would include split creation, settlement
 *     and AI smart-add — not just client writes.
 *
 *     Three things are required before any automation trigger ships: owner scoping by
 *     construction (the subcollection path gives this for free), a recursion guard
 *     (an `origin: 'automation'` marker the trigger ignores), and a depth ceiling.
 *     Until then automations are Appwrite-only — a capability gap that is stated here
 *     rather than discovered in production.
 *
 *     This is NOT permission to change the Appwrite function. It stays as it is.
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
 * `aiSmartAdd`
 *     Not yet ported. It needs the Groq API key, which is not available here, and it
 *     is the one remaining callable with no security or money implications — so it is
 *     the safest thing to defer. Recorded in BACKEND_MIGRATION_PROGRESS.md.
 */

const users = require('./src/users');
const friends = require('./src/friends');
const splits = require('./src/splits');
const notifications = require('./src/notifications');
const account = require('./src/account');
const billing = require('./src/billing');

// --- identity ---------------------------------------------------------------
exports.onUserCreated = users.onUserCreated;
exports.onUserDeleted = users.onUserDeleted;
exports.syncPublicProfile = users.syncPublicProfile;
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
