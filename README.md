# Unity Finance — Firebase Backend

This is the **Firebase backend only** for the Unity Finance / Expense Tracker app.
It is one of two independent, interchangeable backend providers the app supports —
**this repo is not the app**. The React Native/Expo frontend and the Appwrite backend
live in a separate repository and are unaffected by anything here.

## What's here

```
firebase.json              # Firebase project config (functions/firestore/storage wiring)
.firebaserc                # Default project: expense-tracker-b8db9
firestore.rules            # Firestore Security Rules
firestore.indexes.json     # Composite indexes (27, verified READY on the live project)
storage.rules              # Firebase Storage Security Rules
functions/
  index.js                 # Cloud Functions entry point (24 exported functions)
  src/                      # account, billing, common, friends, notifications, splits, users
  __tests__/                # 120 tests: unit, provider-isolation, index-coverage, error-parity,
                            # env-safety, structured-logging, rate-limiting (11 static + 4 live)
  package.json
```

**No frontend code, no SQLite, no React Native, no Appwrite code lives here by design.**
This repository is backend-only and independently deployable.

## Live status (as of this backend's initial push)

- **Project:** `expense-tracker-b8db9`
- **Firestore:** Native mode, region **`me-central1`** (permanent — cannot be changed
  without recreating the project)
- **Cloud Functions:** all 24 deployed and verified `ACTIVE`
  - 22 functions in `me-central1` (co-located with Firestore)
  - 2 functions (`onUserCreated`, `onUserDeleted`) in `us-central1` — these are
    Firebase Auth v1 triggers, and Cloud Functions v1 does not support `me-central1`
    at all (verified directly against the API: 23 supported regions, `me-central1`
    not among them). There is no v2 replacement with equivalent semantics — v2's
    `beforeUserCreated`/`beforeUserSignedIn` are *blocking* triggers that can reject
    the operation, a different contract than "react after creation, never block it".
- **Firebase Storage:** default bucket provisioned, rules deployed
- **End-to-end verified live** (real Firebase Auth users, real HTTP calls, no
  physical device involved): sign-up → Auth trigger → friend request → accept →
  mutual friendship → duplicate-request rejection → cross-user data isolation →
  rate limiting → notification delivery → Storage authorization → account deletion.

## Deploying this backend yourself

```bash
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..

firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
firebase deploy --only storage --project <your-project-id>
firebase deploy --only functions --project <your-project-id>
```

### Before your first deploy

1. **Firestore's region is a one-time, irreversible choice.** Create the database via
   Firebase Console → Firestore Database → Create database, before running any
   `firebase deploy`. Whatever you choose, set `FIREBASE_REGION` to match (see below)
   — Cloud Functions triggers should be co-located with Firestore, and Firestore
   trigger regions must be reachable from the function's own region.
2. **`onUserCreated`/`onUserDeleted` (v1) require a region from the *v1* API's shorter
   region list**, not Firestore's. If your Firestore region isn't one of those 23,
   pin these two functions to a separate v1-legal region (see the comment above
   `V1_TRIGGER_REGION` in `functions/src/users.js`) rather than your main region.
3. **`FIREBASE_REGION` cannot be set via `.env`** — Cloud Functions rejects any `.env`
   key with the `FIREBASE_` prefix as reserved. Edit the fallback constant directly in
   each `src/*.js` file instead (all six are grepped by `providerIsolation.test.js`,
   so a missed one fails CI).
4. **First-time project bootstrap needs Owner or `resourcemanager.projectIamAdmin`,
   not just Editor.** Editor cannot: initialize Firebase Storage's default bucket
   product-activation, grant the Eventarc/Pub-Sub service-agent IAM bindings Cloud
   Functions triggers need, or grant `artifactregistry.writer` / `logging.logWriter`
   / `storage.objectViewer` to the compute service account for Cloud Build. All of
   these are one-time; once granted they persist across future deploys.
5. **The Cloud Functions runtime identity needs its own grants**, separate from
   deploy-time build permissions: `roles/datastore.user`, `roles/firebaseauth.admin`,
   and `roles/firebasecloudmessaging.admin` on **both** service accounts your
   functions run as — `{project-number}-compute@developer.gserviceaccount.com` (v2)
   **and** `{project-id}@appspot.gserviceaccount.com` (v1, if you have any v1
   functions). These are commonly missed because deploy succeeds without them; the
   function only fails at invocation time with `PERMISSION_DENIED`.
6. Enable **Email/Password sign-in** under Firebase Authentication → Sign-in method —
   it is not on by default and callable-function auth will fail entirely without it.

## Testing

```bash
cd functions
npm test                 # static + unit tests, no emulator required
npm run test:all         # full suite incl. Firestore Rules, requires the emulator + JDK
```

## Architecture notes

Every file in `functions/src/` documents its own reasoning inline — money-path
arithmetic, idempotency guarantees, and the deliberate differences from the Appwrite
implementation are explained at the point of use, not in a separate spec. Start with
`functions/src/common.js` for the shared primitives (auth, logging, rate limiting,
the split-operation mutex) and `functions/index.js` for what is and isn't ported from
Appwrite, and why.

See `BACKEND_MIGRATION_PROGRESS.md` in this repo for the full history of how this
backend was built, deployed, and verified.
