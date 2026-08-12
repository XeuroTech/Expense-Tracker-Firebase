/**
 * User identity, profile and search.
 *
 * Appwrite gives the user record for free — `account.create()` produces a searchable
 * account with prefs attached. Firebase Auth stores only credentials, so the profile
 * document and the searchable mirror have to be created explicitly. These four
 * functions are NEW; they fill a platform gap, not a product one.
 *
 * ── DEC-IDENTITY, AS IMPLEMENTED ────────────────────────────────────────────────
 * Phase 2 brief §9: "Do not change existing Appwrite IDs. Do not change existing Drive
 * backup ownership. Do not perform user migration in Phase 2."
 *
 * So a Firebase build uses Firebase-native UIDs and is a SEPARATE identity space. No
 * existing Appwrite user is touched, no Drive backup is re-keyed, and nothing here can
 * make an existing backup undecryptable — because nothing here runs for an existing
 * Appwrite user at all.
 *
 * The consequence, stated rather than discovered: an existing user who switches to a
 * Firebase build is a NEW user with an empty cloud. That is precisely why the
 * `last_synced_provider` guard exists — without it, `syncAll` would push nothing (the
 * rows are already marked synced), `hydrateFromCloud` would pull an empty cloud, and
 * the prune would hard-delete the local database.
 */

const functionsV1 = require('firebase-functions/v1');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall } = require('firebase-functions/v2/https');

const { db, auth, fail, requireAuth, stamps, touch, assertRateLimit } = require('./common');

// NOTE: process.env.FIREBASE_REGION can never actually be set via .env -- Cloud
// Functions rejects any .env key with the FIREBASE_ prefix as reserved. This
// fallback IS the real, only config. me-central1 matches the live Firestore
// database's location exactly -- do not change without recreating the project.
const REGION = process.env.FIREBASE_REGION || 'me-central1';

/**
 * ⚠️ onUserCreated/onUserDeleted CANNOT use REGION. ⚠️
 *
 * There is no v2 equivalent of "run after a user is created/deleted without being
 * able to block it" -- v2's identity functions (`beforeUserCreated`,
 * `beforeUserSignedIn`) are BLOCKING triggers with different semantics (they run
 * synchronously as part of the auth operation and can fail it), so these two stay on
 * `firebase-functions/v1`.
 *
 * Verified directly against the live APIs, not assumed: `cloudfunctions.googleapis.com
 * /v1/.../locations` lists 23 regions: asia-east1/2, asia-northeast1/2/3, asia-south1,
 * asia-southeast1/2, australia-southeast1, europe-central2, europe-west1/2/3/6,
 * northamerica-northeast1, southamerica-east1, us-central1, us-east1/4,
 * us-west1/2/3/4. `me-central1` is NOT among them -- it exists only in the v2 list (40
 * regions). A v1 function deployed to `me-central1` makes the ENTIRE codebase's source
 * upload fail with `403 Permission denied on 'locations/me-central1'`, because
 * firebase-tools requests ONE upload URL through the v1 API whenever ANY v1 function
 * is present, which then 403s before any function -- v1 or v2 -- gets uploaded.
 *
 * The fix is a second, v1-legal region for ONLY these two functions. They write a
 * `users`/`public_profiles` doc and call the Auth Admin API on account create/delete --
 * infrequent, not latency-sensitive, and not on any hot path -- so a small cross-region
 * hop to Firestore is an accepted, deliberate tradeoff, not an oversight. Every other
 * function (all 16 v2 ones) stays on `REGION` (`me-central1`), co-located with
 * Firestore as intended.
 */
const V1_TRIGGER_REGION = 'us-central1';

/** Only these fields are ever exposed by search. Mirrors `AppUserSummary`. */
const toPublicProfile = (uid, { name, email, avatarId }) => ({
    userId: uid,
    name: name || '',
    email: email || '',
    avatarId: avatarId || null,
    // Lower-cased for prefix search. Firestore has no case-insensitive operator, so
    // the normalised form has to be stored rather than computed at query time.
    name_lower: (name || '').toLowerCase(),
    email_lower: (email || '').toLowerCase(),
});

/**
 * Creates `users/{uid}` and `public_profiles/{uid}`.
 *
 * Firebase Auth has no background v2 create trigger, so this is a v1 auth trigger —
 * the two generations coexist in one codebase without issue.
 */
const onUserCreated = functionsV1
    .region(V1_TRIGGER_REGION)
    .runWith({ maxInstances: 10 })
    .auth.user()
    .onCreate(async (user) => {
        const profile = { name: user.displayName || '', email: user.email || '', avatarId: null };

        const batch = db.batch();

        batch.set(db.collection('users').doc(user.uid), {
            user_id: user.uid,
            email: profile.email,
            name: profile.name,
            // Entitlement starts FREE. Never trust anything client-supplied here —
            // this document is the input to the Pro gate.
            prefs: { plan: 'free', subscriptionStatus: 'active' },
            ...stamps(),
        });

        batch.set(
            db.collection('public_profiles').doc(user.uid),
            { ...toPublicProfile(user.uid, profile), ...stamps() }
        );

        await batch.commit();
    });

/**
 * Symmetric cleanup. The finance subcollections are removed recursively; shared rows
 * are handled by the `deleteAccount` callable, which has the user's consent context.
 */
const onUserDeleted = functionsV1
    .region(V1_TRIGGER_REGION)
    .runWith({ maxInstances: 10 })
    .auth.user()
    .onDelete(async (user) => {
        await db.recursiveDelete(db.collection('users').doc(user.uid));
        await db.collection('public_profiles').doc(user.uid).delete().catch(() => undefined);
    });

/**
 * Keeps the searchable mirror current when the profile changes.
 *
 * Guarded against write loops: it writes to `public_profiles`, never back to `users`,
 * so it cannot re-trigger itself. That guard is not decoration — the ported
 * `evaluate_automations` has exactly this defect and Firestore makes it worse, because
 * triggers fire on Admin SDK writes too.
 */
const syncPublicProfile = onDocumentWritten(
    { document: 'users/{uid}', region: REGION, maxInstances: 10 },
    async (event) => {
        const uid = event.params.uid;
        const after = event.data && event.data.after && event.data.after.data();

        if (!after) {
            await db.collection('public_profiles').doc(uid).delete().catch(() => undefined);
            return;
        }

        const before = event.data.before && event.data.before.data();
        const changed =
            !before
            || before.name !== after.name
            || before.email !== after.email
            || before.avatarId !== after.avatarId;

        if (!changed) return;

        await db.collection('public_profiles').doc(uid).set(
            {
                ...toPublicProfile(uid, {
                    name: after.name,
                    email: after.email,
                    avatarId: after.avatarId,
                }),
                ...touch(),
            },
            { merge: true }
        );
    }
);

/**
 * Explicit "make my profile match my current Auth record" sync.
 *
 * ── WHY THIS EXISTS — A CONFIRMED RACE, NOT A HYPOTHETICAL ONE ─────────────────
 * `onUserCreated` above reads `user.displayName` off the CREATE event's snapshot.
 * The client's own registration flow calls `createUserWithEmailAndPassword` and
 * THEN `updateProfile({ displayName })` a moment later — and there is no ordering
 * guarantee between that second client call landing and this trigger firing on
 * the first. Verified against live data: every `public_profiles` document had
 * `name` / `name_lower` as an empty string, which made name-based search
 * (`searchUsers` below) structurally unable to match anyone, ever.
 *
 * This callable is the fix, not a new trust boundary: it still never accepts a
 * client-supplied name string, only re-reads FROM Auth (`auth.getUser`). Firebase
 * Auth writes are strongly consistent, so by the time the client's own
 * `updateProfile` promise has resolved — which it has, because the client only
 * calls this immediately after that — this read is GUARANTEED to see it. Call
 * once, right after `updateProfile`, from the registration flow.
 *
 * The write goes to `users/{uid}` only; `syncPublicProfile`'s trigger propagates
 * it to `public_profiles/{uid}` from there, so there is exactly one writer of
 * the searchable mirror, matching the header note on that trigger.
 */
const syncMyProfile = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    const record = await auth.getUser(uid);
    await db.collection('users').doc(uid).set(
        { name: record.displayName || '', email: record.email || '', ...touch() },
        { merge: true }
    );
    return { success: true };
});

/**
 * User search.
 *
 * Runs with the Admin SDK inside a callable because `public_profiles` is
 * `allow read: if false` for clients. That is the whole point: a direct client query
 * would let any authenticated user enumerate the entire user base including every
 * email address — an exposure Appwrite does not have, since its search runs
 * server-side behind an API key and returns curated fields.
 *
 * Matching mirrors `search_app_user`: exact email, or case-insensitive name prefix.
 */
const searchUsers = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
    const uid = requireAuth(request);
    // §16 — this is the one callable that reads across the whole user base; without a
    // limit it is a scraping/enumeration vector, not just a cost concern.
    await assertRateLimit(uid, 'searchUsers', { max: 30, windowMs: 10 * 60 * 1000 });
    const raw = String((request.data && request.data.query) || '').trim();

    if (raw.length < 2) return { success: true, users: [] };

    const needle = raw.toLowerCase();
    const results = new Map();

    const byEmail = await db
        .collection('public_profiles')
        .where('email_lower', '==', needle)
        .limit(10)
        .get();

    for (const doc of byEmail.docs) results.set(doc.id, doc.data());

    // Prefix match. The upper bound below is `needle` followed by U+F8FF, which
    // lives in a private-use block and therefore sorts above every character that
    // occurs in a real name — so the range covers exactly the strings beginning
    // with `needle`. This is the standard Firestore prefix-query idiom; the SDK
    // has no startsWith operator.
    const byName = await db
        .collection('public_profiles')
        .where('name_lower', '>=', needle)
        .where('name_lower', '<', `${needle}`)
        .limit(20)
        .get();

    for (const doc of byName.docs) results.set(doc.id, doc.data());

    results.delete(uid); // never return yourself

    const candidates = Array.from(results.values());
    if (candidates.length === 0) return { success: true, users: [] };

    const relationships = await resolveRelationships(uid, candidates.map((c) => c.userId));

    return {
        success: true,
        users: candidates.map((candidate) => ({
            userId: candidate.userId,
            name: candidate.name,
            email: candidate.email,
            avatarId: candidate.avatarId || null,
            relationship: relationships.get(candidate.userId) || { status: 'none' },
        })),
    };
});

/**
 * Resolves the caller's relationship to each candidate, so the UI can render
 * "Add" / "Pending" / "Friends" without a second round trip. Same shape as
 * `AppUserSearchResult.relationship`.
 */
const resolveRelationships = async (uid, otherUids) => {
    const map = new Map();
    if (otherUids.length === 0) return map;

    const { pairKeyFor } = require('./common');
    const pairKeys = otherUids.map((other) => pairKeyFor(uid, other));

    // Firestore caps `in` at 30 values, so chunk. Silently truncating instead would
    // report "not friends" for real friends beyond the cap.
    const chunks = [];
    for (let i = 0; i < pairKeys.length; i += 30) chunks.push(pairKeys.slice(i, i + 30));

    for (const chunk of chunks) {
        const [friends, requests] = await Promise.all([
            db.collection('friends')
                .where('pair_key', 'in', chunk)
                .where('participantIds', 'array-contains', uid)
                .get(),
            db.collection('friend_requests')
                .where('pair_key', 'in', chunk)
                .where('status', '==', 'pending')
                .get(),
        ]);

        for (const doc of friends.docs) {
            const data = doc.data();
            if (data.status !== 'accepted') continue;
            map.set(data.friend_user_id, { status: 'accepted', friendshipId: doc.id });
        }

        for (const doc of requests.docs) {
            const data = doc.data();
            const other = data.requester_user_id === uid
                ? data.recipient_user_id
                : data.requester_user_id;
            if (map.has(other)) continue;

            map.set(other, {
                status: 'pending',
                requestId: doc.id,
                direction: data.requester_user_id === uid ? 'outgoing' : 'incoming',
            });
        }
    }

    return map;
};

module.exports = {
    onUserCreated,
    onUserDeleted,
    syncPublicProfile,
    syncMyProfile,
    searchUsers,
    toPublicProfile,
    resolveRelationships,
    REGION,
    fail,
    auth,
};
