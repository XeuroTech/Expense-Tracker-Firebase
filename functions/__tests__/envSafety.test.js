/**
 * ENVIRONMENT & CREDENTIAL SAFETY — brief §51, §64, §65.
 *
 * §64/§65: separate configuration per environment, and never accidentally point a
 *          development build at production data.
 * §51:     no server secret may ship to the client.
 *
 * Everything under `EXPO_PUBLIC_*` is inlined into the JS bundle by Expo at build
 * time, so it is readable by anyone who has the app. The Firebase Web API key is a
 * public project identifier and is fine there; an Admin service-account key is not,
 * and would be a total compromise of every user's data.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Credentials must not be committed
// ---------------------------------------------------------------------------

test('.env is gitignored', () => {
    const gitignore = read(path.join(ROOT, '.gitignore'));
    assert.match(gitignore, /^\.env$/m, '.env must be gitignored — it holds real configuration.');
});

test('.env.example exists and contains no real values', () => {
    const examplePath = path.join(FRONTEND, '.env.example');
    assert.ok(fs.existsSync(examplePath), 'frontend/.env.example must exist (§64).');

    const example = read(examplePath);

    // A populated Firebase API key looks like `AIza...` (39 chars). Any such literal
    // here means a real credential was pasted into a committed file.
    assert.ok(
        !/AIza[0-9A-Za-z_-]{20,}/.test(example),
        '.env.example contains what looks like a real Firebase API key.'
    );
    assert.ok(
        !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(example),
        '.env.example contains a private key.'
    );
    assert.ok(
        !/"type"\s*:\s*"service_account"/.test(example),
        '.env.example contains a service-account blob.'
    );
});

test('.env.example documents every Firebase variable the client reads', () => {
    const config = read(path.join(FRONTEND, 'src', 'backend', 'firebase', 'config.ts'));
    const example = read(path.join(FRONTEND, '.env.example'));

    const referenced = new Set(
        (config.match(/EXPO_PUBLIC_FIREBASE_[A-Z_]+/g) || []).filter(
            // The bare prefix appears in the error-message builder, not as a real var.
            (name) => name !== 'EXPO_PUBLIC_FIREBASE_'
        )
    );

    assert.ok(referenced.size >= 10, `Expected the full Firebase var set, found ${referenced.size}`);

    for (const name of referenced) {
        assert.ok(
            example.includes(name),
            `${name} is read by config.ts but undocumented in .env.example — a deployer ` +
                `cannot know to set it, and the app fails at startup (§64).`
        );
    }
});

// ---------------------------------------------------------------------------
// §51 — no Admin credential in the client bundle
// ---------------------------------------------------------------------------

test('the client never imports firebase-admin or an Appwrite API key', () => {
    const offenders = [];

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

            const source = fs.readFileSync(full, 'utf8');
            if (/from ['"]firebase-admin|require\(['"]firebase-admin/.test(source)) {
                offenders.push(`${path.relative(ROOT, full)} imports firebase-admin`);
            }
            if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(source)) {
                offenders.push(`${path.relative(ROOT, full)} embeds a private key`);
            }
            if (/"type"\s*:\s*"service_account"/.test(source)) {
                offenders.push(`${path.relative(ROOT, full)} embeds a service account`);
            }
            // Appwrite server key — `setKey` is server-SDK only.
            if (/\.setKey\(/.test(source)) {
                offenders.push(`${path.relative(ROOT, full)} calls setKey (server API key)`);
            }
        }
    };

    walk(path.join(FRONTEND, 'src'));
    walk(path.join(FRONTEND, 'app'));

    assert.deepStrictEqual(
        offenders,
        [],
        `Server credentials found in client code (§6, §51):\n  ${offenders.join('\n  ')}`
    );
});

// ---------------------------------------------------------------------------
// §65 — the emulator must be opt-in, and off by default
// ---------------------------------------------------------------------------

test('emulator mode is opt-in and defaults to off', () => {
    const config = read(path.join(FRONTEND, 'src', 'backend', 'firebase', 'config.ts'));

    // A build that silently pointed at a local emulator would appear to work while
    // persisting nothing.
    assert.match(
        config,
        /EXPO_PUBLIC_FIREBASE_USE_EMULATOR/,
        'Emulator use must be gated behind an explicit env var.'
    );
    assert.match(
        config,
        /===\s*'true'/,
        'Emulator mode must require the literal string "true", so any other value is off.'
    );

    const example = read(path.join(FRONTEND, '.env.example'));
    assert.match(
        example,
        /EXPO_PUBLIC_FIREBASE_USE_EMULATOR=false/,
        'The documented default must be false.'
    );
});

test('the rollback path is documented and the default provider is appwrite', () => {
    const example = read(path.join(FRONTEND, '.env.example'));
    assert.match(
        example,
        /EXPO_PUBLIC_BACKEND_PROVIDER=appwrite/,
        'The example must ship with the safe default (§66).'
    );
});
