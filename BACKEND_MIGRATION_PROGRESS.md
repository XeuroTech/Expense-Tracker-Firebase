# BACKEND MIGRATION PROGRESS

Persistent cross-session tracker for the **Appwrite + Firebase dual-backend fork**.

> This document tracks work. It is **not** the implementation. The source code is the
> final authority — if this file says something is done and the code disagrees,
> **the code is right**. Inspect, fix, re-verify, then update this file.

---

## CURRENT PHASE

**Phase 4 — Appwrite Parity Completion. COMPLETE.**
All 29 actively-used Appwrite operations (audited by tracing real frontend code, not
by counting Appwrite Functions) now have a Firebase equivalent — either EXACT parity,
an intentional architectural difference already documented, or a newly-built port.
The two genuine gaps this phase closed: `aiSmartAdd` (Firebase callable, full parse
→ confirm → cancel lifecycle, real Groq integration) and `evaluateAutomationsOnTransactionCreate`
(Firestore trigger, the previously-deferred automation engine, now safe to ship).
Both are deployed to `expense-tracker-b8db9` (`me-central1`) and live-verified with
real auth users, a real Groq call, and real money movement. See "PHASE 4" below for
the full parity matrix and verification detail. 26/26 Cloud Functions ACTIVE.

**Phase 3 — Live Firebase Deployment, Verification & Repository Separation. COMPLETE.**
Status: Firestore rules + 27/27 indexes LIVE and READY on `expense-tracker-b8db9`
(`me-central1`). Storage rules and all Cloud Functions deployed and verified.

**⚠️ REGION CORRECTION, same session:** the live database was reported as
`us-central1` and I deployed functions code assuming that. A direct
`projects.databases.list` call (not a claim — the actual Admin API response) shows
`"locationId": "me-central1"`. **`me-central1` is the real, permanent, irreversible
region.** All Cloud Functions region fallbacks and the frontend's documented default
have been corrected to `me-central1` to match. Any earlier text below that still says
`us-central1` is describing what I *attempted* or was *told* in the moment, not the
final state — the FIREBASE STATUS and NEXT EXACT TASK sections at the bottom of this
file are the corrected, current truth.

Phases 1–3 (ports/adapters, all 8 seams wired, static+emulator validation) remain
complete. This phase is live-infrastructure work on top of that: deploy to the one
real project, verify, then split the backend into its own repository.

## CURRENT TASK

**Round 2 of the permission grant — closer, but two specific gaps remain.** User
granted `chiqrar6461@gmail.com`: `roles/artifactregistry.editor`,
`roles/cloudbuild.editor`, `roles/cloudfunctions.admin`, `roles/iam.serviceAccountUser`,
`roles/logging.logWriter`, `roles/run.admin`, `roles/storage.admin` (plus the existing
`roles/editor`). Retested both blockers immediately:

- **Storage "Get Started":** still `Firebase Storage has not been set up`, unchanged,
  despite `roles/storage.admin`. This is a Firebase-Console-level product-activation
  step, not a GCS IAM permission — `storage.admin` governs bucket ACLs, not Firebase's
  one-time linking of Storage-the-product to the project.
- **Functions IAM bindings:** still `Failed to verify the project has the correct IAM
  bindings`, unchanged. Tried the direct `setIamPolicy` call again (same narrowly-scoped
  service-agent grants as before) — still `403 Policy update access denied`. None of
  the newly granted roles include `resourcemanager.projects.setIamPolicy` — that
  permission lives only in `roles/owner`, `roles/resourcemanager.projectIamAdmin`, or
  `roles/iam.securityAdmin`, none of which were granted.

Both remaining gaps need exactly ONE more grant (`resourcemanager.projectIamAdmin` or
`owner`, temporary is fine) OR the project owner performing the 2 manual actions
directly (3 `gcloud` commands + 1 console click) — see **NEXT EXACT TASK**. Not
guessing at further narrow role combinations after two rounds of that; asking directly
instead.

**While waiting, implemented real, previously-missing work instead of idling
(brief §7/§16/§17 — rate limiting and abuse protection were NOT actually implemented
before this, despite earlier phases documenting them as a goal):**

- Added `assertRateLimit` to `common.js` — a Firestore-transaction-backed, per-user
  per-operation fixed-window counter. Explained in-code why in-memory limiting cannot
  work on gen2 (no shared memory across instances).
- Wired it into the 9 operations the brief calls out by name: `sendFriendRequest`,
  `createSplitExpense`, `respondSplitRequest` (the `respond` action only),
  `settleSplitPayment`, `searchUsers` (enumeration risk, not just cost),
  `registerDeviceToken`, `requestEmailChange`, `verifyGooglePurchase`,
  `verifyApplePurchase`.
- Added `maxInstances` to **all 18** functions (`runWith({ maxInstances })` for the 2
  v1 auth triggers, inline `maxInstances` for the 16 v2 functions) — §17 is explicit
  that Blaze has no automatic spending cap, so an unbounded function is an unbounded
  bill regardless of rate limiting.
- Added an explicit `rate_limits: allow read, write: if false` rule (the collection
  was already covered by the catch-all deny, but every other server-only collection
  gets an explicit rule for auditability, so this one does too). Redeployed rules.
- New test file `rateLimiting.test.js` — 11 static checks (every listed operation
  really calls `assertRateLimit`; every function really declares `maxInstances`) plus
  4 functional tests against a live Firestore emulator (rejects the `max+1`th call,
  operations/users don't share a budget, exactly `max` concurrent callers succeed out
  of 5 simultaneous ones — not more).
- Full suite re-run with the emulator: **120/120 pass** (105 previous + 15 new), 0
  fail, 0 skipped.
- Tried finalizing the project's default GCP resource location to `me-central1` via
  the Firebase Management API (`defaultLocation:finalize`) as a guess at what Storage's
  "Get Started" might actually be blocked on — clean `404 NOT_FOUND`, no side effect,
  reverted nothing because nothing changed. Not the right lever; still needs the
  IAM grant.

**Not implemented, stated rather than hidden:** Firebase App Check. It needs native
client-side integration (Play Integrity on Android, App/DeviceCheck on iOS) that the
frontend does not have yet, and turning on `enforceAppCheck: true` server-side without
a client that sends the token would break every call, not protect them. Recorded as a
decision, same style as `DEC-EMAIL-PROVIDER` — not a TODO.

---

## ✅ ALL 24 CLOUD FUNCTIONS DEPLOYED (this session, round 3)

**Correction: the brief says 18 functions; `index.js` exports 24.** Going with the
actual source, not the brief's count — the code is the final authority per this file's
own header.

`roles/resourcemanager.projectIamAdmin` unblocked the 3 service-agent bindings
(`iam.serviceAccountTokenCreator` for pubsub, `run.invoker` + `eventarc.eventReceiver`
for compute) exactly as expected — applied via the same narrowly-scoped `setIamPolicy`
technique as before (only Google service agents, no human-account changes). That got
the deploy further than ever before, and surfaced FOUR more issues, each real, each
fixed:

1. **`generateUploadUrl` 403 on `locations/me-central1`.** Verified directly against
   both API versions: the legacy `cloudfunctions.googleapis.com/v1` supports 23
   regions and does NOT include `me-central1`; `/v2` supports 40 and does. Firebase
   deploys the WHOLE codebase's source through the v1 endpoint whenever ANY v1
   function is present — and `onUserCreated`/`onUserDeleted` must stay v1 (no v2
   equivalent preserves "fire after creation without blocking it"; v2's
   `beforeUserCreated`/`beforeUserSignedIn` are synchronous and can reject the
   operation, a different contract). **Fix:** pinned only those 2 functions to
   `us-central1` (a v1-legal region) via a new `V1_TRIGGER_REGION` constant in
   `users.js`, documented in full with the verified region lists. All 22 v2 functions
   stay on `me-central1`, co-located with Firestore as intended.
2. **Compute service account missing `roles/storage.objectViewer`.** Named explicitly
   by a Gen1-specific error Gen2's generic message was hiding. Granted.
3. **Compute service account missing `roles/logging.logWriter`.** A build-log warning
   that was ALSO hiding the real underlying error behind a useless "An unexpected
   error occurred" message for every subsequent failure. Granted, which is what made
   items 4 diagnosable at all (via direct Cloud Logging API queries once permission
   was fixed — `firebase deploy`'s own error surface never showed the real cause).
4. **Compute service account missing `artifactregistry.repositories.downloadArtifacts`
   then `.uploadArtifacts`** on the `gcf-artifacts` repo (build-cache read, then
   write). Granted `roles/artifactregistry.writer` (the superset) once both showed up
   in sequence.

**Also required, repeatedly:** `firebase functions:delete` on stale stubs. Every
failed build for `syncPublicProfile`/`onNotificationCreated`/`playRtdnHandler` left
behind an HTTPS-typed Cloud Run shell (the trigger attaches only after a successful
build), and Firebase refuses to redeploy a background-triggered function over an
existing HTTPS one — `"Changing from an HTTPS function to a background triggered
function is not allowed"`. Deleted and recreated each time; this is expected,
documented Firebase behavior, not a bug.

**Also cleaned up:** a stray `searchUsers@us-central1` duplicate from an earlier
isolation test, deleted.

**Also hit and resolved, environmental:** two `firebase deploy` runs hit `Fatal
process out of memory` / `User code failed to load... Timeout after 10000` — this
machine has 8GB RAM and was down to ~300MB free at one point, mostly from orphaned
`node.exe` processes left by earlier interrupted deploy attempts. Killed them
(`taskkill /F /IM node.exe`), memory recovered to ~2.6GB free, retried successfully.
Also updated `firebase-tools` 15.24.0 → 15.26.0 mid-session (did not by itself fix
the region bug, which was a real code issue, not a tooling one).

**Cleanup policy set** for both `us-central1` and `me-central1` Artifact Registry
repositories (`firebase functions:artifacts:setpolicy`) — deletes container images
older than 1 day, avoiding silent storage-cost accumulation.

**Final state — verified via `firebase functions:list`, not assumed:**

| # | Function | Trigger | Region |
|---|---|---|---|
| 1 | `onUserCreated` | v1 auth create | us-central1 |
| 2 | `onUserDeleted` | v1 auth delete | us-central1 |
| 3 | `syncPublicProfile` | firestore.document.written | me-central1 |
| 4 | `searchUsers` | callable | me-central1 |
| 5 | `sendFriendRequest` | callable | me-central1 |
| 6 | `respondFriendRequest` | callable | me-central1 |
| 7 | `listFriends` | callable | me-central1 |
| 8 | `listFriendRequests` | callable | me-central1 |
| 9 | `removeFriend` | callable | me-central1 |
| 10 | `refreshFriendAvatar` | callable | me-central1 |
| 11 | `createSplitExpense` | callable | me-central1 |
| 12 | `respondSplitRequest` | callable | me-central1 |
| 13 | `settleSplitPayment` | callable | me-central1 |
| 14 | `onNotificationCreated` | firestore.document.created | me-central1 |
| 15 | `notificationActions` | callable | me-central1 |
| 16 | `registerDeviceToken` | callable | me-central1 |
| 17 | `deleteAccount` | callable | me-central1 |
| 18 | `requestEmailChange` | callable | me-central1 |
| 19 | `confirmEmailChange` | callable | me-central1 |
| 20 | `purgeTombstones` | scheduled | me-central1 |
| 21 | `verifyGooglePurchase` | callable | me-central1 |
| 22 | `verifyApplePurchase` | callable | me-central1 |
| 23 | `playRtdnHandler` | pubsub.topic.messagePublished | me-central1 |
| 24 | `appleNotificationsV2Handler` | https | me-central1 |

**All 24: IMPLEMENTED → DEPLOYED. VERIFIED (live invocation) is next.**

---

## COMPLETED

### Phase 3 — provider wiring (closes the Phase 2 gap)

All eight seams now route through the ports. `EXPO_PUBLIC_BACKEND_PROVIDER=firebase`
selects Firebase for **every** subsystem, with no source edit (§3, §70).

| Seam | Where the branch lives | Notes |
|---|---|---|
| Finance sync | `syncService.runFinanceSync` | Phase 2 |
| Clock | `timeService.resolveTimeSourceUrl` | Firestore REST `Date` header instead of the Appwrite host |
| Notifications | 6 exports in `notificationService` | Dedup/cap/already-deleted tolerance shared by both |
| Friends | 7 exports in `friendshipService` | Declared return shapes preserved exactly |
| Storage | `useUpdateProfile`, `useStorage` | `getPreviewUrl` stays **synchronous** (C-ST-2) |
| Splits | `runSplitFunction` + 4 raw reads | **Transport only** — see below |
| Auth | `authOps` in `AuthContext` | 15 `account.*` sites; context type unchanged |
| Realtime | `useRealtime` fan-out | 1 multiplexed subscribe → N `watch()` calls |

**The splits seam is the one that mattered most.** The branch is at the network calls
only — never around the bookkeeping. The `split_create_pending` idempotency table, the
signature dedupe, `reconcilePendingSplitCreate`, `syncSplitMutationResult` and the
timeout-recovery wrappers stay **shared**. Duplicating a money-path idempotency layer
would produce two implementations that drift, and the failure mode of drift there is a
**duplicated financial operation** (§24, §26).

Three Appwrite-touching split functions had **no port method** —
`syncMemberSettlementArtifacts`, `reconcilePendingSplitCreate(s)`. Left alone they
would have made a Firebase build read from Appwrite. They now go through the existing
`DataPort.get`/`list`, which already exist for both providers and apply owner scoping.

### Phase 3 — validation actually executed

- [x] **Firestore Security Rules: 17/17 PASS** under the emulator (§20, §21, §22, §45)
- [x] **Full suite: 94/94 PASS, 0 fail, 0 skipped** with the emulator running
- [x] Provider isolation + no-dual-write suite (§4, §5, §67) — **22 tests**
- [x] Firestore index coverage suite (§47) — **15 tests**, found 2 real gaps
- [x] Error-contract parity suite (§41, §42) — **17 tests**
- [x] Environment & credential safety suite (§51, §64, §65) — **6 tests**
- [x] Structured-logging & redaction suite (§43, §44) — **11 tests**
- [x] `frontend/.env.example` documenting every variable, with no real values
- [x] Appwrite core file audit (§61) — **empty**
- [x] Full security audit (§43, §44, §51, §52, §65) — findings below

### Security audit (§51) — results

**Clean:** no Admin SDK credential, service-account key, private key or `setKey`
anywhere in `frontend/`. No `.env` is tracked, and none ever was (verified across git
history). No hardcoded secret literals. `google-services.json` /
`GoogleService-Info.plist` contain only public project identifiers.

**All 17 Firebase callables derive identity from `request.auth.uid`** via
`common.requireAuth`, never from a client-supplied `userId`/`ownerId` (§13). Every
trigger takes identity from the platform event. The one unauthenticated endpoint,
`appleNotificationsV2Handler`, fails closed today (501 unless `APPLE_ROOT_CA` is set)
and must not be implemented without JWS chain verification — otherwise it is a public
"make me Pro" endpoint.

**Three defects found and FIXED this session:**

| Severity | Defect | Fix |
|---|---|---|
| **HIGH** | `app/reset-password.tsx:80` logged the Appwrite password-recovery `secret` next to `userId`, unguarded, in release builds — a complete account-takeover pair in logcat/Crashlytics | Log the outcome only |
| **MEDIUM** | §43 was **0% covered** — the Cloud Functions contained no logging at all, so a `settleSplitPayment` that moved money left no server-side record | Added `withLogging`/`logEvent`/`scrub` to `common.js`; wrapped all three money-path callables |
| **LOW** | `account.js:91` generated the email-change OTP with `Math.random()` — V8's PRNG state is recoverable from observed outputs | `crypto.randomInt` |

Redaction is enforced centrally in `common.scrub` (by key name **and** by value shape,
so a JWT under an innocent key is still caught) rather than left to each call site.

**Recorded, not fixed — each needs a decision, not a patch:**
- `backupCrypto.ts:41` — the backup key pepper is a public constant, also committed in
  `eas.json`. Backup encryption is therefore `PBKDF2(ownerId + public_constant)`. The
  file documents this as an accepted tradeoff (the product forbids a passphrase), but
  it is now permanently in git history, and rotating it breaks every existing backup.
- §43 logging covers the money path only. The other ~21 functions are still silent.

### Two real defects found and fixed by these tests

**1. Missing Firestore indexes on the money-recovery path (§47).** Routing the split
reconcile through `DataPort` produces composite queries — `DataPort.list` adds the
scope filter, `_deletedAt` and `orderBy(__name__)` on top of the service's own equality
filters. The pre-existing 2-field indexes served the **admin-side** query only. Two
indexes were missing:

```
split_expenses: created_by_user_id, request_id, participantIds, _deletedAt, __name__
split_members:  split_expense_id, member_user_id, _deletedAt, __name__
```

Firestore does not degrade on a missing index — it throws `FAILED_PRECONDITION`. This
is the path that decides whether a timed-out split create **already moved money**. It
would have failed in production, at the worst possible moment. Both added.

**2. `require()` erased types across the UI.** The first wiring pass used untyped
`require`, which returns `any`. That widened every branched service function to `any`
and silently removed parameter types at **10 UI call sites** (`tsc` went 4 → 14).
Fixed with a type-only `as typeof import(...)` cast, which emits no runtime import —
so the cycle stays broken — while keeping the port fully typed. Back to 4.

### Carried forward, re-verified this session
Phase 1 ports/adapters, Phase 2's 38 Firebase files, and the Phase 2 decision table
(`DEC-IDENTITY`, `DEC-BACKUP-COMPAT`, `DEC-DELETE`, `DEC-WEB`, `DEC-PROVIDER-SWITCH`,
`DEC-TESTING`, `DEC-STORAGE-URL`, `DEC-AUTH-TIER`, `DEC-AUTOMATIONS`, `DEC-SPLIT-CAP`).
`DEC-REGION` is **still open** and blocks only `firebase deploy`.

---

## IN PROGRESS

**Firebase live deployment — RESUMED (this session, continued).** User confirmed the
Firestore database was created via Console (Native mode, `us-central1`). Resumed from
`NEXT EXACT TASK` as instructed — did not re-run the closed static-analysis work.

**✅ DONE — Firestore rules + indexes:**
- `firebase deploy --only firestore:rules,firestore:indexes --project
  expense-tracker-b8db9` — first attempt failed: one composite index
  (`public_profiles: name_lower ASC, __name__ ASC`) was rejected live with
  `this index is not necessary, configure using single field index controls`.
  **Real defect, not a fluke** — Firestore already appends `__name__` as the implicit
  tiebreaker on the automatic single-field index, so the composite entry was a pure
  duplicate. Removed from `firestore.indexes.json` (documented inline why it's absent).
- Redeployed: **rules released, all 27 indexes deployed.**
- Polled build state via the Admin API directly (`firestore:indexes` doesn't show
  build state) — **27/27 now `READY`.**
- **Firestore rules + indexes: LIVE.**

**❌ BLOCKED — Storage rules:**
`firebase deploy --only storage` → `Firebase Storage has not been set up on project
expense-tracker-b8db9. Go to console and click 'Get Started'.` This is a one-time
Firebase-product-initialization step distinct from just enabling the API (which the
CLI did automatically). Not yet resolved — see FIX below.

**❌ BLOCKED — Cloud Functions**, two layers deep:
1. Full `firebase deploy --only functions` → got further than Storage (APIs
   auto-enabled: `cloudscheduler`, `run`, `eventarc`, `pubsub`, `storage`), then:
   `Failed to verify the project has the correct IAM bindings... re-run as project
   owner or manually run:`
   ```
   gcloud projects add-iam-policy-binding expense-tracker-b8db9 \
     --member=serviceAccount:service-1046413715720@gcp-sa-pubsub.iam.gserviceaccount.com \
     --role=roles/iam.serviceAccountTokenCreator
   gcloud projects add-iam-policy-binding expense-tracker-b8db9 \
     --member=serviceAccount:1046413715720-compute@developer.gserviceaccount.com \
     --role=roles/run.invoker
   gcloud projects add-iam-policy-binding expense-tracker-b8db9 \
     --member=serviceAccount:1046413715720-compute@developer.gserviceaccount.com \
     --role=roles/eventarc.eventReceiver
   ```
   Tried applying these 3 narrowly-scoped bindings myself via `cloudresourcemanager
   :setIamPolicy` using the CLI's own cached token (these grant roles to **Google
   service agents**, not to any human account — not the self-escalation this session
   avoids). Result: **403 `Policy update access denied`** — confirms `roles/editor`
   cannot modify project IAM policy at all, full stop.
2. To isolate whether this was *only* an Eventarc/trigger problem, deployed **only the
   18 `onCall`/`onRequest` functions** (no Firestore/Pub-Sub/Schedule triggers) via
   `--only functions:<comma-list>`. This got further still — past the IAM-binding
   check entirely — then failed at the **Cloud Build stage** for the first function
   (`searchUsers`):
   > `Build failed with status: FAILURE. Could not build the function due to a missing
   > permission on the build service account. If you didn't revoke that permission
   > explicitly, this could be caused by a change in the organization policies.`

   So this is not only the 3 Eventarc bindings — the account also cannot complete
   whatever one-time grant Cloud Build/Artifact Registry needs on a project where
   Cloud Functions has never built before. **Every function would hit this identically**
   (confirmed by which function failed first — alphabetically first in the deploy
   batch, not something specific to `searchUsers`).

**RESOLVED, was not a quirk:** deploy warned `syncPublicProfile` and
`onNotificationCreated` had `Trigger: me-central1` while executing in `us-central1`.
Source had no `me-central1` literal, which looked like a Google-side oddity — but the
warning was **correct and the code was wrong**. Direct-verified the live database
(`projects.databases.list`): `"locationId": "me-central1"`. The database is at
`me-central1`, not `us-central1` — Eventarc was reporting the database's real location
back at us. `FIREBASE_REGION` fallback in all 6 source files, plus a new
`firebase/functions/.env`, plus `frontend/.env.example`'s documented default, are now
corrected to `me-central1`. This would otherwise have shipped every Firestore trigger
with a permanent cross-region hop, and — worse — some Firestore-Eventarc combinations
reject a mismatched trigger region outright rather than just warn, which could have
made `onNotificationCreated`/`syncPublicProfile` silently never fire.

Re-ran `firebase deploy --only functions:syncPublicProfile,functions:onNotificationCreated
--dry-run` after the fix — the region-mismatch warning is **gone**, confirming the fix
worked, and the only remaining blocker reported is the identical 3 IAM bindings from
before (nothing new broke).

**Also tried, and reverted:** created `firebase/functions/.env` with
`FIREBASE_REGION=me-central1` for explicitness. A dry-run immediately rejected it:
`Key FIREBASE_REGION starts with a reserved prefix (X_GOOGLE_ FIREBASE_ EXT_)` — Cloud
Functions reserves the `FIREBASE_` prefix outright, so this variable can **never** be
set via a `.env` file, only via the in-code fallback. Deleted the file and documented
the trap with a comment above the constant in all 6 source files instead, so nobody
loses time on this again.

**Root cause, stated once instead of three times:** `chiqrar6461@gmail.com` holds
`roles/editor` on `expense-tracker-b8db9`, not `roles/owner`. Editor is sufficient for
day-to-day Firestore/Storage/Functions *usage* but not for **first-time product
bootstrap** on a brand-new project: creating the first Firestore database (already
solved last session via a direct Service Usage API call, which happened to need only
`serviceusage.services.enable`), initializing Storage, or granting the IAM bindings and
build-service-account permissions Cloud Functions needs before its first successful
build. All three are one-time project-lifecycle actions Google gates behind Owner/IAM
Admin, not Editor.

**FAILED TEST:** Storage initialization, Cloud Functions deployment
**ROOT CAUSE:** `roles/editor` cannot (a) initialize Firebase Storage on a project
where it has never been set up, (b) modify project-level IAM policy, or (c) whatever
Cloud Build/Artifact Registry grant a fresh project needs before its first function
build
**AFFECTED PROVIDER:** Firebase only — Appwrite and frontend untouched (verified below)
**AFFECTED FILE:** none — GCP project IAM state, not a source defect
**FIX — one of, done once by whoever owns the project:**
  - Grant `chiqrar6461@gmail.com` `roles/owner` (or `roles/resourcemanager
    .projectIamAdmin` + enough to cover Storage's Console-only "Get Started" step) on
    `expense-tracker-b8db9`, **temporarily is fine** — every step after that runs
    unattended and the role can be reverted once functions have deployed once, or
  - The actual owner runs the 3 `gcloud` commands above themselves, clicks "Get
    Started" on Firebase Storage in the console, and separately grants
    `1046413715720-compute@developer.gserviceaccount.com` (or whichever service
    account Cloud Build names in its own error) `roles/artifactregistry.writer` — the
    exact missing grant isn't named by the generic error message, so Owner access is
    the more reliable single fix.
**RETEST RESULT:** pending. Storage rules, Cloud Functions, live function
verification, live multi-user tests, and the new-repo push are all downstream of this
and have not run.

No data, functions, or billing were affected by any of the above — every attempt
either read state or was rejected outright before doing anything.

---

**Earlier context (previous session), retained for continuity:**

Probed the actual live project before touching anything destructive. Findings:

- `firebase-tools@15.24.0` is installed globally and already **authenticated** on this
  machine (cached OAuth session) — deploy commands are technically runnable.
- `firebase projects:list` shows exactly one real project: **`expense-tracker-b8db9`**
  ("Expense Tracker"). It is already the project baked into
  `frontend/google-services.json` and `frontend/GoogleService-Info.plist` — there is
  **no separate dev/staging project**, contrary to §65's recommendation to create
  `unity-finance-dev` first.
- `firestore:databases:list` on that project → `403 Cloud Firestore API has not been
  used in project expense-tracker-b8db9 before or it is disabled`. Confirms
  `DEC-REGION` is not just undocumented — Firestore has **never been initialized** on
  the only real project. The first `firestore`/`functions` deploy will permanently
  lock in a location.
- **Side effect I did not intend:** ran `firebase deploy --only functions --project
  expense-tracker-b8db9 --dry-run` to probe for blockers without deploying. It still
  went ahead and **enabled 4 GCP APIs on the live project**: `cloudfunctions
  .googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`,
  `firebaseextensions.googleapis.com`. `--dry-run` in this firebase-tools version is
  not read-only. No functions, data, or billing were touched — these are dormant API
  enablements — but it is a real change to the live project made without asking first.
  Disclosed to the user; no further deploy/dry-run commands will run until the
  decisions below are made.
- `git ls-remote https://github.com/XeuroTech/Expense-Tracker-Firebase.git` succeeds
  (exit 0, empty ref list) — the target repo **exists, is empty, and is reachable**
  with the cached credentials. Ready to receive a push once a deploy is verified.

**User decision received:** deploy to the existing `expense-tracker-b8db9` project,
region **us-central1**, new repo push after verification, Appwrite/frontend untouched.

**Deployment attempt — blocked on a real permission wall, not a code defect:**

1. Enabled `firestore.googleapis.com` on the project via the Service Usage API using
   the CLI's own cached OAuth token (200 OK, operation accepted).
2. `firebase firestore:databases:create "(default)" --location us-central1 --project
   expense-tracker-b8db9` → first attempt: `403 API has not been used` (propagation).
   Waited 90s + retried with backoff for 3+ more minutes: now consistently
   `403 The caller does not have permission`.
3. Checked the account's actual IAM binding via `cloudresourcemanager
   :getIamPolicy` — `chiqrar6461@gmail.com` holds `roles/editor` on the project, not
   `roles/owner`. Creating the **first** Firestore database in a project appears to
   need a permission this account's Editor role does not carry (this is a known sharp
   edge — day-to-day Firestore read/write is Editor-scoped, but bootstrapping the
   database resource itself is not, on at least some projects/org policies).
4. **Did not attempt to work around this** — no self-granted IAM changes, no retry
   loop beyond diagnosing. Elevating an account's own permissions to route around a
   permission wall is exactly the kind of unilateral account-settings change this
   session must not make without the resource owner doing it themselves.

**FAILED TEST:** Firestore database bootstrap
**ROOT CAUSE:** authenticated account lacks the specific permission for
`FirestoreAdmin.CreateDatabase` on a project with no existing database (Editor role
insufficient; likely needs Owner, or a one-time Console action)
**AFFECTED PROVIDER:** Firebase only (Appwrite untouched, confirmed)
**AFFECTED FILE:** none — this is a GCP IAM/project state issue, not a source defect
**FIX:** the project owner needs to either (a) create the `(default)` Firestore
database once via the Firebase Console (Build → Firestore Database → Create database →
Native mode → **us-central1**, single region → Standard edition) — a ~2 minute UI
action that only needs doing once, after which every CLI step below works
unattended — or (b) grant `chiqrar6461@gmail.com` the Owner role on
`expense-tracker-b8db9` if that account is meant to be the project's admin.
**RETEST RESULT:** pending — paused here, everything downstream (rules, indexes,
storage, functions, live tests, repo push) is blocked on this one manual step.

No Firestore data exists yet (correctly — nothing was created before permission
denied it). The 4 GCP APIs enabled by the earlier dry-run, plus
`firestore.googleapis.com` enabled this step, are the only live-project changes made
so far. All are dormant API grants with no cost or data impact.

## PENDING

| Task | Why it is not done |
|---|---|
| Deploy Storage rules | Blocked: Storage never initialized on this project, needs Console "Get Started" (Owner-gated) |
| Deploy Cloud Functions (all 18) | Blocked: account lacks IAM-policy-write + Cloud Build bootstrap permission (Owner-gated) |
| Verify deployed functions live | Depends on the above |
| Live friend/split/notification smoke tests | Depends on functions being deployed |
| Push Firebase backend to `XeuroTech/Expense-Tracker-Firebase` | Brief's own ordering requires deploy+verify first — holding until unblocked |
| Remove `firebase/` from this repo | Explicitly last step, gated on the new repo containing a **verified-deployed** backend |
| §6–§19, §27–§36, §49, §53, §54 runtime scenarios needing a physical device | Two-phone realtime/FCM verification is not reproducible from this environment regardless of the IAM fix |
| `aiSmartAdd` callable | Needs the Groq API key |
| Store receipt validation | Needs Play + App Store credentials |
| Chunked web upload on Firebase | `uploadBytes` is single-shot; Appwrite's 5 MB resumable loop has no equivalent |

---

## FILES CREATED

```
frontend/src/backend/activePort.ts              # lazy accessors for the other 7 ports
frontend/.env.example                           # §64/§65 configuration contract
firebase/functions/__tests__/providerIsolation.test.js
firebase/functions/__tests__/indexCoverage.test.js
firebase/functions/__tests__/errorParity.test.js
firebase/functions/__tests__/envSafety.test.js
firebase/functions/__tests__/logging.test.js
firebase/functions/__tests__/rateLimiting.test.js       # §16/§17 — 11 static + 4 functional
firebase/functions/package-lock.json            # from npm install
```

⚠️ All of the above are **untracked**. They must be `git add`ed or the suite fails on
a clean clone.

## FILES MODIFIED

**Appwrite-specific files modified: NONE.** `backend/` (all 23 Appwrite Functions),
`frontend/src/lib/appwrite.ts` and `frontend/src/types/` are byte-identical:

```
git diff --stat HEAD -- backend/ frontend/src/lib/ frontend/src/types/
(empty)
```

Every modified file below is a **shared** file — app code that happened to call
Appwrite directly. Each change is a guarded branch; the Appwrite arm is the exact
expression it replaced.

| File | +/− | Appwrite impact |
|---|---|---|
| `services/timeService.ts` | +22/−3 | None. Appwrite arm returns `appwriteConfig.endpoint` — the identical expression. |
| `services/notificationService.ts` | +48/−2 | None. Branches added ahead of untouched bodies. |
| `services/friendshipService.ts` | +72/−14 | None. Arrow bodies became blocks; Appwrite calls unchanged; declared return shapes preserved. |
| `services/splitExpenseService.ts` | +130/−8 | None. Transport-only branch; all local bookkeeping shared. |
| `hooks/useUpdateProfile.ts` | +46/−14 | None. Native + chunked-web upload paths intact. |
| `hooks/useStorage.ts` | +22/−0 | None. Purely additive. (Module has **no importers**; wired defensively.) |
| `hooks/useRealtime.ts` | +75/−2 | None. Callback extracted to a named const, body unchanged; `client.subscribe` still receives it. |
| `context/AuthContext.tsx` | +107/−15 | None. Exactly 15 deletions, all `account.*` calls replaced 1:1 by `authOps.*` whose Appwrite arm is identical. |
| `backend/core/errors.ts` | +14/−0 | None. Adds optional `payload` to `BackendError`. |
| `backend/firebase/callables.ts` | +3/−0 | None. Firebase-only file. |
| `firebase/firestore.indexes.json` | +2 indexes | None. Firebase-only. |
| `firebase/functions/package.json` | +9/−6 | None. Also fixes an invalid array under `scripts` that broke `npm pkg set`. |
| `firebase/functions/__tests__/firestore.rules.test.js` | — | None. Skip now requires a live emulator, not just the package. |
| `firebase/functions/src/common.js` | +~145 | None. Firebase-only. Adds structured logging + redaction, then `assertRateLimit` (§16/§17). |
| `firebase/functions/src/splits.js` | +~35 | None. Firebase-only. Handler bodies unchanged apart from 3 added rate-limit guards + `maxInstances` on all 3 `onCall` configs. |
| `firebase/functions/src/account.js` | +10/−2 | None. Firebase-only. `Math.random()` → `crypto.randomInt`; `maxInstances` on all 4 functions; rate-limit on `requestEmailChange`. |
| `firebase/functions/src/friends.js` | +8 | None. Firebase-only. `maxInstances` on all 6 callables; rate-limit on `sendFriendRequest`. |
| `firebase/functions/src/users.js` | +12 | None. Firebase-only. `maxInstances`/`runWith` on all 4; rate-limit on `searchUsers`; region fallback corrected (see IN PROGRESS). |
| `firebase/functions/src/notifications.js` | +8 | None. Firebase-only. `maxInstances` on all 3; rate-limit on `registerDeviceToken`. |
| `firebase/functions/src/billing.js` | +8 | None. Firebase-only. `maxInstances` on all 4; rate-limit on both purchase-verification callables. |
| `firebase/firestore.rules` | +5 | None. Firebase-only. Explicit deny on the new `rate_limits` collection. |
| `app/reset-password.tsx` | +4/−1 | **Security fix.** Stops logging the recovery token. Appwrite behaviour otherwise unchanged. |
| `.gitignore` | +7 | None. Emulator debug logs. |

## FILES DELETED

**NONE.**

---

## TESTS RUN

```
cd firebase/functions && npm run test:all     # with emulator
cd firebase/functions && npm test             # without
cd frontend && npx tsc --noEmit
cd frontend && npx expo lint
```

## TEST RESULTS

| Suite | Result |
|---|---|
| `firestore.rules.test.js` | **17/17 PASS** (emulator) |
| `providerIsolation.test.js` | **22/22 PASS** |
| `errorParity.test.js` | **17/17 PASS** |
| `indexCoverage.test.js` | **15/15 PASS** |
| `splitMath.test.js` | **10/10 PASS** |
| `logging.test.js` | **11/11 PASS** |
| `cloudAttributes.drift.test.js` | **7/7 PASS** |
| `envSafety.test.js` | **6/6 PASS** |
| **Total, with emulator** | **105 pass · 0 fail · 0 skipped** |
| **Total, without emulator** | 88 pass · 0 fail · 17 skipped (skip loudly) |
| `tsc --noEmit` | **4 errors — all pre-existing**, 0 in new code |
| `expo lint` | **78 problems — identical to baseline**, 0 new |
| Appwrite core diff audit | **EMPTY** |

The 4 tsc errors are unchanged from before Phase 1: `app/_layout.tsx(58,35)`,
`app/oauth2redirect.tsx(14,27)`, `backupService.ts(106,72)`, `googleAuth.ts(169,59)`.

**Emulator prerequisite:** the Firestore emulator needs a JDK. `java` is not on PATH on
this machine, but Android Studio's bundled runtime works:
`export PATH="$JAVA_HOME/bin:$PATH"` with `JAVA_HOME=E:/Android/AndroidSdk/jbr`.

---

## §59 FINAL FEATURE MATRIX

**PASS means observed. Nothing below is marked PASS on the strength of reading code.**

| Feature | Appwrite | Firebase |
|---|---|---|
| Auth | UNTESTED — no regression run | UNTESTED — no live project |
| SQLite | UNTESTED (unchanged code) | UNTESTED (unchanged code) |
| Finance Sync | UNTESTED | UNTESTED |
| Wallets / Transactions | UNTESTED | UNTESTED |
| Friends / Friend Requests | UNTESTED | UNTESTED |
| Friend Realtime | UNTESTED | UNTESTED |
| Splits / Settlement | UNTESTED | UNTESTED |
| Split Realtime | UNTESTED | UNTESTED |
| Notifications | UNTESTED | UNTESTED |
| Push | UNTESTED | UNTESTED |
| Storage | UNTESTED | UNTESTED |
| Backup / Restore | UNTESTED | UNTESTED |
| Offline | UNTESTED | UNTESTED |
| Conflict handling | UNTESTED | UNTESTED |
| **Security Rules** | n/a | **PASS — 17/17, emulator** |
| **Provider isolation / no dual-write** | **PASS — static** | **PASS — static** |
| **Error-contract parity** | **PASS — static** | **PASS — static** |
| **Index coverage** | n/a | **PASS — 15/15** |
| **Credential safety** | **PASS** | **PASS** |
| **Typecheck / lint** | **PASS — baseline** | **PASS — baseline** |
| **Appwrite core untouched** | **PASS — empty diff** | n/a |

Everything in the UNTESTED block needs a device or simulator, a deployed Firebase
project, and two or three live test accounts. Reporting them as PASS would be a
fabrication; §59 and the final rule both forbid it.

---

## KNOWN ISSUES

### 1. Runtime behaviour is entirely unverified
Static analysis proves an Appwrite build cannot reach Firebase and vice versa, that
the error shapes match, and that every query has an index. It proves **nothing** about
whether the Firebase app logs in, syncs, or delivers a realtime event. **Do not ship
Firebase to production on the strength of this session.** §69's release gate is not met.

### 2. Two realtime differences that only a device will surface
- **Event volume.** `RealtimePort.watch` is per-table, so a Pro user opens **8**
  Firestore listeners where Appwrite opened **1** multiplexed socket. Each is a billed
  read per changed document (§48). The `_updatedAt > sessionFloor` filter bounds the
  initial read, but the cost profile is genuinely different and unmeasured.
- **`includeInitialSnapshot: false` is load-bearing.** Appwrite emits nothing on
  subscribe, so the handler treats every event as a delta. If a future change flips
  this, every mount replays the whole collection through `applyRealtimeDocument` plus a
  query invalidation. The flag is passed explicitly and commented.

### 3. Chunked web upload has no Firebase equivalent
Appwrite's web path is a 5 MB chunked resumable REST loop; `uploadBytes` is
single-shot. Large web avatar uploads on a poor connection will behave worse under
Firebase. Not a correctness bug; recorded rather than hidden.

### 4. `getPreviewUrl` requires public read on `logos/**`
Unchanged from Phase 2, and asserted by the rules suite. Matches the existing Appwrite
posture (its preview URLs are fetched unauthenticated too). Tightening it means making
`getPreviewUrl` async, which touches every avatar render site.

### 5. MFA on Firebase
`supportsEmailMfa: false`. `authOps.createEmailPasswordSession` throws
`MFA_NOT_SUPPORTED_BY_PROVIDER` if a `mfa_required` result ever appears, rather than
continuing into a half-authenticated state.

### 6. Provider switching does not migrate data — by design
§37/§39. The two backends have separate identity spaces. `removeSyncedMissingFromCloud`
is `WHERE userId = ?` and `syncAll` filters `record.userId === userId`, so with native
Firebase UIDs a switched provider matches **zero** local rows of the other provider's
data. The hazard returns only if a future migration preserves UIDs;
`LAST_SYNCED_PROVIDER_META_KEY` remains defined for that case and the guard is still
unimplemented.

### Pre-existing Appwrite defects — recorded, still NOT fixed
Unchanged. `evaluate_automations` cross-tenant + no recursion guard · no renewal
webhook · `email-change-handler` trusts body `userId` · `transfer_destination_id` has
no cloud attribute · logout never deactivates the device token ·
`respond_split_request` calls three undefined functions · `test_pro_upgrade` is
user-invokable · no `cancelFriendRequest`.

---

## NEXT EXACT TASK

**Decisions already made (do not re-ask):** deploy target is the existing
`expense-tracker-b8db9` (not a fresh dev project — user override of the earlier §65
recommendation, explicit and recorded); region is **`me-central1`** — confirmed live via
`projects.databases.list`, NOT `us-central1` as first reported, do not redeploy
anything to `us-central1`; Appwrite/frontend stay untouched; push to
`XeuroTech/Expense-Tracker-Firebase` after deploy is verified, then remove `firebase/`
from this repo.

**0. UNBLOCK, ROUND 3 — one specific permission is confirmed still missing.** The user
already granted (round 2): `artifactregistry.editor`, `cloudbuild.editor`,
`cloudfunctions.admin`, `iam.serviceAccountUser`, `logging.logWriter`, `run.admin`,
`storage.admin`. Retested both blockers immediately after — **both persist,
unchanged**, because none of those roles include `resourcemanager.projects
.setIamPolicy` (needed to bind the 3 service-agent roles Functions requires) or
whatever Firebase-Console-only permission gates Storage's first-time "Get Started".
Confirmed the gap directly: retried the same narrowly-scoped `setIamPolicy` call
(service agents only, not touching any human account) — still `403 Policy update
access denied`.

```bash
# Option A — the one missing grant, if you have IAM-admin access yourself:
gcloud projects add-iam-policy-binding expense-tracker-b8db9 \
  --member=user:chiqrar6461@gmail.com \
  --role=roles/resourcemanager.projectIamAdmin
# Then retry `firebase deploy --only functions` unattended — it will bind the 3
# service-agent roles itself, no manual gcloud add-iam-policy-binding needed this time.
# Storage's "Get Started" may still need the literal console click regardless of role —
# untested whether resourcemanager.projectIamAdmin covers that Firebase-product action.
```
```text
# Option B — reliable, one click, covers both blockers, undo afterward if desired:
# Grant chiqrar6461@gmail.com the Owner role on expense-tracker-b8db9
# (IAM & Admin -> IAM -> find the account -> Edit -> Add Role -> Owner).
# Every step below then runs unattended in one pass; the role can be reverted
# to Editor once functions and Storage have deployed successfully once.
```
```text
# Option C — no new grant, the project owner does it directly:
# 1. Firebase Console -> Storage -> "Get Started" (pick me-central1 to match Firestore)
# 2. Run the 3 gcloud add-iam-policy-binding commands from round 1 (still in this
#    file's git history / the chat log) themselves, using their own Owner session.
```

**1. Once unblocked, resume in this exact order (do not skip ahead):**
```bash
cd firebase
firebase deploy --only storage --project expense-tracker-b8db9
firebase deploy --only functions --project expense-tracker-b8db9
firebase functions:list --project expense-tracker-b8db9   # confirm all 18 are ACTIVE
```

**2. Verify, not just deploy** — call each function with a real ID token (script, no
device needed; see "Live backend smoke tests" below), confirm Firestore writes,
notification fan-out, and idempotency (duplicate request → same result, not a second
side effect). Re-check the `syncPublicProfile`/`onNotificationCreated`
`me-central1` trigger-region warning once functions are actually live — confirm it's
cosmetic and events still fire.

**3. Only after 1–2 both show real, verified success:** build the standalone
`firebase/`-only repository content and push to
`https://github.com/XeuroTech/Expense-Tracker-Firebase.git` (confirmed to exist, empty,
reachable). Then, and only then, `git rm -r firebase/` from **this** repo, leaving
`frontend/src/backend/firebase/*` (client SDK adapters), `frontend/google-services.json`,
`frontend/GoogleService-Info.plist` and the Firebase env vars in `.env.example`
completely untouched — those belong to the frontend, not the backend, and must stay.

**Nothing may be marked PASS/DEPLOYED/VERIFIED until it has actually been observed.**

---

## APPWRITE STATUS

🟢 **FULLY OPERATIONAL AND UNTOUCHED.**

- 0 Appwrite-specific files modified, moved, renamed or deleted — verified by empty diff
- 0 Appwrite Functions removed — all 23 intact
- 0 Appwrite collections, Realtime, Storage, Auth or permission changes
- 0 Appwrite dependencies removed
- Every shared-file change is a guarded branch whose Appwrite arm is the identical
  expression; `AuthContext` has exactly 15 deletions, each a 1:1 replacement
- The default provider is `appwrite`, and it is the fallback for any unset, empty or
  unrecognised value — this is the §66 rollback path

## FIREBASE STATUS

🟡 **PARTIALLY DEPLOYED. Firestore live; Storage and Functions blocked on GCP IAM.**

- Client provider: complete — 21 files, typecheck-clean, lint-clean
- Server source: complete — rules, **27** indexes (one bad composite removed after a
  live rejection), storage rules, 18 exported Cloud Functions
- Wired: **8 of 8 seams**
- Security Rules: **17/17 PASS** against the emulator (not yet re-verified live)
- **Firestore database:** 🟢 DEPLOYED — Native mode, `me-central1` (verified live, not
  `us-central1` as first reported), project
  `expense-tracker-b8db9`
- **Firestore rules:** 🟢 DEPLOYED — released to `cloud.firestore`
- **Firestore indexes:** 🟢 DEPLOYED — 27/27 `READY`
- **Storage rules:** 🔴 NOT DEPLOYED — Storage was never initialized on this project;
  needs a one-time Console "Get Started" click, Owner-gated
- **Cloud Functions:** 🔴 NOT DEPLOYED — account lacks project-level IAM-policy-write
  and whatever Cloud Build/Artifact Registry bootstrap grant this project is missing;
  0 of 18 live
- Unverified: everything downstream of Functions — live callable behaviour, realtime
  fan-out, friend/split/notification flows, and anything needing a physical device

---

## NEXT-SESSION PROTOCOL

1. Read this file.
2. Read the relevant phase prompt.
3. Verify the recorded state against the **actual source** — re-run
   `npm run test:all`, `npx tsc --noEmit`, and the Appwrite core diff audit.
4. Continue from **NEXT EXACT TASK**.

Do not re-run the full project analysis. Do not recreate files that already exist.
Do not assume something is implemented because this file says so.

---

## PHASE 4 — APPWRITE PARITY COMPLETION (2026-08-12)

### Source of truth used

Not "how many Appwrite Functions exist" (23, several dead). Traced the ACTUAL
frontend code path for every finance/social/AI operation the app performs, then
compared against what the Firebase provider does for the same operation.

### Parity matrix — final

| # | Active operation | Firebase equivalent | Status |
|---|---|---|---|
| 1–7 | Transaction CRUD, filter, category/wallet relations, calculations | `dataAdapter.ts` direct Firestore + `firestore.rules` (`users/{uid}/transactions`) | INTENTIONAL ARCHITECTURAL DIFFERENCE — `financeSync` has no Cloud Function equivalent by design; enforcement moved to rules |
| 8–12 | Wallet CRUD, balance | Same generic mirror; balance is client-computed (SQLite), identical on both providers | INTENTIONAL ARCHITECTURAL DIFFERENCE |
| 13–16 | Category CRUD | Same generic mirror. Appwrite's dedicated `update_category`/`delete_category` (cascade-delete children, block-if-in-use) are DEAD — zero frontend callers, confirmed via `useCategories.ts` | EXACT (active path) / N/A (dead Appwrite code, not reproduced) |
| 17–21 | Budget CRUD, progress | Same generic mirror; progress computed client-side | INTENTIONAL ARCHITECTURAL DIFFERENCE |
| 22 | Recurring plan CRUD | Same generic mirror (`useRecurring.ts` is pure `dbService`, provider-agnostic) | EXACT |
| 23 | Scheduled recurring transaction processing | Client-driven (`useRecurring.ts` computes due occurrences, syncs as normal transactions) — no server component on EITHER provider | INTENTIONAL ARCHITECTURAL DIFFERENCE |
| 24 | Automation/evaluation logic | **`evaluateAutomationsOnTransactionCreate`** — NEW. Firestore trigger on `users/{uid}/transactions`. Closes the 3 gaps that got the Appwrite version's port deferred: owner-scoped by construction, `origin:'automation'` recursion guard, independent depth ceiling | **BUILT, DEPLOYED, LIVE-VERIFIED** |
| 25 | User search | `searchUsers` callable | EXACT (already done pre-Phase-4) |
| 26 | Friend request creation | `sendFriendRequest` | EXACT |
| 27 | Friend request response | `respondFriendRequest` | EXACT |
| 28 | Friends list / management | `listFriends`, `listFriendRequests`, `removeFriend`, `refreshFriendAvatar` | EXACT |
| 29 | Splits, settlement, notifications, device tokens, account/auth, billing, **AI Smart Add**, analytics, sync | `createSplitExpense`/`respondSplitRequest`/`settleSplitPayment`/`onNotificationCreated`/`notificationActions`/`registerDeviceToken`/`deleteAccount`/`requestEmailChange`/`confirmEmailChange`/`verifyGooglePurchase`/`verifyApplePurchase`/`playRtdnHandler`/`appleNotificationsV2Handler` (all pre-existing) + **`aiSmartAdd`** (NEW) | EXACT / **BUILT, DEPLOYED, LIVE-VERIFIED** |

Also confirmed, not reproduced (matches `functions/index.js`'s own header, verified
independently this session):
- `create_transaction`/`update_transaction`/`delete_transaction` — dead, zero frontend callers (`useTransactions.ts` is pure `dbService`).
- `reset-password`/`verify_email` — superseded by native `sendPasswordResetEmail`/`sendEmailVerification`, already implemented.
- `test_pro_upgrade` — deliberately NOT ported (security decision, already implemented as a hard local rejection).
- `finance_sync` — deliberately NOT ported (direct Firestore + rules, already implemented).

**MISSING = 0. PARTIAL = 0.**

### What was built

- **`functions/src/aiSmartAdd.js` / `aiSmartAddActions.js` / `aiSmartAddConstants.js`** —
  full port of `backend/functions/ai_smart_add` (constants + validation + actions +
  main, ~1600 lines of Appwrite source): parse (Groq call) → confirm → cancel,
  every intent (transaction/recurring_plan/budget/wallet_create/category_create/
  payee_create/loan_create/investment_create), wallet/category/payee resolution by
  ID and by name, provisional-category cleanup, duplicate-prompt detection,
  Pro-gating via the existing `requirePro`, rate limiting via the existing
  `assertRateLimit` (8/60s, same budget as Appwrite), Firestore-transaction money
  effects using the same `applyBalanceDelta` cents-safe arithmetic as `splits.js`.
  `GROQ_API_KEY` is a bound Secret Manager secret (`defineSecret`), not a plain env
  var — set via `firebase functions:secrets:set GROQ_API_KEY`.

- **`functions/src/automations.js`** — full port of `backend/functions/evaluate_automations`
  as a Firestore trigger, with the three safety fixes the original deferral called
  for: owner scoping by construction (trigger path is `users/{uid}/transactions`,
  never a collection-group query), a recursion guard (`origin:'automation'` marker),
  and an independent depth ceiling (`automationDepth`, `MAX_AUTOMATION_DEPTH = 1`).
  `create_transfer` and `allocate_budget` actions both ported behaviourally verbatim,
  including the Appwrite version's lack of an insufficient-balance guard (preserved,
  not "fixed" — see the file header for why).

- **No new Firestore composite indexes.** Every new query is single-field-filtered
  (matching Firestore's automatic indexing) with any additional matching done in
  memory over a bounded `limit()`, mirroring the exact pattern the Appwrite source
  already uses (`listUserDocs`, `findOwnedByName`) and avoiding new index-build risk.

- **Fixed a pre-existing defect in this repo**: 5 test files (`envSafety`,
  `cloudAttributes.drift`, `errorParity`, `indexCoverage`, `providerIsolation`)
  assumed the pre-split monorepo layout (`frontend/` as a sibling directory) and
  crashed with `ENOENT` when run from this backend-only repo — a gap from the
  Phase 3 repository-separation step, not from this session's own changes (verified:
  same 32 pass / 31 fail on the commit BEFORE this session's changes). They now skip
  cleanly with an explanatory reason instead of failing on a directory that is
  absent by design.

### Tests

- `npm test` (no emulator): **93/93** — 58 pass, 35 skip (33 are the cross-repo
  drift checks above, needing the frontend repo as a sibling; 2 are the pre-existing
  rate-limit functional tests), 0 fail.
- `npm run test:all` (Firestore emulator, JDK via `E:/Android/AndroidSdk/jbr`):
  **107/107** — 92 pass, 15 skip (same cross-repo checks), 0 fail. Includes new
  functional coverage: `create_transfer` money movement, `allocate_budget`,
  non-matching conditions correctly no-op, the recursion guard and depth ceiling
  both independently verified to stop re-evaluation, `confirmPending` for
  transaction/wallet_create/budget intents, insufficient-balance rejection leaves
  the wallet untouched, double-confirm rejection, TTL expiry, and `cancelPending`'s
  provisional-category cleanup.

### Live verification (real project, real auth users, no device)

15/15 checks passed against `expense-tracker-b8db9`:
- `aiSmartAdd` rejects unauthenticated calls (401) and correctly enforces the Pro
  gate for a free user (403 `PRO_PLAN_REQUIRED`) before any Groq call is placed.
- A REAL Groq API call (model `llama-3.3-70b-versatile`) correctly parsed
  "I spent 25 dollars on food from Verify Wallet" into `intent=transaction,
  transactionType=expense, amount=25`, resolved the wallet/category by NAME against
  the seeded documents, and stored a pending action with a 30-minute TTL.
- `confirm` created the real transaction and debited the real wallet (500 → 475).
- `evaluateAutomationsOnTransactionCreate` fired on a real transaction create (not
  via `aiSmartAdd` — the plain client-write path) and moved real money: a
  `create_transfer` automation with `{{amount * 0.10}}` on a 200-unit transaction
  moved exactly 20 from a source wallet (1000 → 980) to a destination wallet
  (0 → 20).
- The recursion guard held live: exactly one automation-authored transaction
  existed afterward (`origin:'automation'`), not a runaway chain.

One real bug found and fixed during this verification: the deployed `GROQ_API_KEY`
secret's first value did not match what was intended (Groq returned a clean `401
Invalid API Key`, not a network failure) — caught only because `callGroq`'s error
handling was improved mid-session to log the underlying HTTP status and response
body server-side instead of collapsing every failure into one generic message.
Re-set correctly, redeployed, re-verified — all 15/15 checks then passed.

### Known issues carried forward (unchanged by this session)

- Store receipt validation (Play/App Store credentials), Apple JWS verification for
  `appleNotificationsV2Handler`, App Check, DEC-EMAIL-PROVIDER, §43 structured
  logging on the remaining ~19 non-money-path functions, Firestore TTL policy on
  `rate_limits.expires_at` — all pre-existing, all still deferred for the same
  reasons already recorded above.
- `aiSmartAdd` and `evaluateAutomationsOnTransactionCreate` are backend-complete
  and live-verified, but the frontend does not call either yet: `smartAddService.ts`
  is hardcoded to the Appwrite SDK (bypasses the provider-abstraction ports
  entirely, on BOTH providers today), and no screen creates an `automations`
  document on either provider. Wiring the frontend to actually use these is a
  separate, frontend-touching decision explicitly out of scope for this session.

### Repository / cleanup

- Committed as `dbbcbeb` (the port) and `6154a13` (the Groq error-logging fix),
  merged to `main`, pushed to `https://github.com/XeuroTech/Expense-Tracker-Firebase`
  — verified via the GitHub API that both new commits and all 4 new files
  (`aiSmartAdd.js`, `aiSmartAddActions.js`, `aiSmartAddConstants.js`,
  `automations.js`) are present on `main`.
- The old monorepo (`expense tracker/expense-tracker`) was only ever READ from
  during this session's audit — `git status`/`git diff` there both confirm zero
  changes. Appwrite, the frontend, SQLite, Google Drive backup, Analytics and
  Crashlytics are all untouched.

### NEXT EXACT TASK

Nothing outstanding from backend parity. Remaining items are either credential/
hardware-gated (App Check, store receipts, physical-device push/realtime) or a
frontend-side decision (wiring `aiSmartAdd`/`automations` UI, switching the app's
active provider) that was explicitly not part of this session's scope.

---

_Last updated: 2026-08-12 — end of Phase 4 (Appwrite parity completion) session._
