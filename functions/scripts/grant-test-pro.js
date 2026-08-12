#!/usr/bin/env node
/**
 * LOCAL-ONLY dev tool. Flips a single test account's `prefs.plan` to 'pro' or
 * 'free' directly in Firestore, using YOUR OWN gcloud/firebase credentials on
 * YOUR OWN machine.
 *
 * This is deliberately NOT a Cloud Function and NEVER gets deployed anywhere.
 * There is no equivalent reachable by the app or by any other user - see
 * docs/BACKEND_MIGRATION_PROGRESS.md and functions/src/billing.js's header:
 * a user-invokable "grant free Pro" endpoint must never exist on the live
 * backend, gated or not. Running this script is the safe substitute.
 *
 * Usage:
 *   node functions/scripts/grant-test-pro.js <uid> pro
 *   node functions/scripts/grant-test-pro.js <uid> free
 *
 * Find your uid: Firebase Console -> Authentication -> Users -> your email.
 *
 * Requires Application Default Credentials for a principal with Firestore
 * write access on this project (the same account you ran `firebase login`
 * with usually works once you also run, one time only:
 *   gcloud auth application-default login
 * If `gcloud` isn't installed, download a service account key instead -
 * IAM & Admin -> Service Accounts -> Keys -> Add key - and run with:
 *   set GOOGLE_APPLICATION_CREDENTIALS=path\to\key.json  (Windows cmd)
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="path\to\key.json"  (PowerShell)
 * Never commit that key file - `.gitignore` now covers Console's default
 * download name (`*firebase-adminsdk*.json`) as well as the older
 * `*serviceAccount*.json` / `*service-account*.json` patterns.
 */

const admin = require('firebase-admin');

const PROJECT_ID = 'expense-tracker-b8db9';

const [, , uid, rawTarget] = process.argv;
const target = (rawTarget || '').toLowerCase();

if (!uid || (target !== 'pro' && target !== 'free')) {
    console.error('Usage: node functions/scripts/grant-test-pro.js <uid> <pro|free>');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: PROJECT_ID,
});

const sha256Like = (value) =>
    require('crypto').createHash('sha256').update(String(value)).digest('hex');

const run = async () => {
    const db = admin.firestore();
    const ref = db.collection('users').doc(uid);

    const snapshot = await ref.get();
    if (!snapshot.exists) {
        console.error(`No users/${uid} document found. Is that the right uid?`);
        process.exit(1);
    }

    const prefs =
        target === 'pro'
            ? {
                  plan: 'pro',
                  subscriptionStatus: 'active',
                  subscriptionProductId: 'unity_pro_monthly',
                  subscriptionPlatform: 'test',
                  subscriptionExpiresAt: null,
                  subscriptionEndDate: null,
                  billingCycle: 'monthly',
                  subscriptionVerificationHash: sha256Like(`local-test-grant:${uid}:${Date.now()}`),
              }
            : {
                  plan: 'free',
                  subscriptionStatus: 'active',
                  subscriptionProductId: null,
                  subscriptionPlatform: null,
                  subscriptionExpiresAt: null,
                  subscriptionEndDate: null,
                  billingCycle: null,
                  subscriptionVerificationHash: null,
              };

    await ref.set({ prefs }, { merge: true });
    console.log(`users/${uid}.prefs -> plan: ${target}. Fully close and reopen the app to see it.`);
};

run()
    .catch((error) => {
        console.error('Failed:', error.message);
        process.exit(1);
    })
    .finally(() => admin.app().delete());
