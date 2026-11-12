#!/usr/bin/env node

// Pre-flight checks for Android release builds.
//
// 2026-07-09 blocker-fix pass: this script previously hard-required
// EXPO_PUBLIC_API_URL (the retired Express backend URL, deleted from the
// codebase in the Supabase migration), which made `npm run build:android:release`
// fail unconditionally. It now validates the Supabase env the app actually
// uses — including that the anon key belongs to the live project, since a
// stale key from a defunct project shipped in the repo and broke all logins
// (see docs/PHC_CLIENT_READINESS_AUDIT_2026-07-09.md).
//
// 2026-07-10: also accepts the new sb_publishable_... key format (replaces
// the legacy JWT anon key). Publishable keys are opaque — no decodable
// ref/role payload like the old JWT — so instead of decoding, this does a
// live check against the configured project's auth endpoint to prove the
// key is actually valid for it.

const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

const fail = (message) => {
  console.error(`[release-check] ${message}`);
  process.exit(1);
};

const EXPECTED_PROJECT_REF = 'portfolio-project';

// Expo inlines EXPO_PUBLIC_* vars at bundle time, and it does NOT read only .env.
// It reads a precedence chain, and `.env.local` BEATS `.env`.
//
// This check used to parse `.env` alone. That made it blind in the worst possible
// way: it would read the production URL out of `.env`, pass, and then hand off to a
// bundler that baked in whatever `.env.local` said. On 2026-07-26 that produced a
// fully signed "release" APK — correct package, correct versionCode, correct
// signing certificate — pointed at `http://10.0.2.2:54321`, the emulator's alias
// for a developer laptop. Installed on a real phone in the field it would reach
// nothing at all, and nothing about the artifact would look wrong.
//
// A release gate has to read the same files the bundler reads, in the same order,
// or it is not a gate. Order below is lowest to highest precedence, so later
// assignments overwrite earlier ones — matching Expo's own resolution.
const ENV_FILES_LOWEST_PRECEDENCE_FIRST = ['.env', '.env.production', '.env.local', '.env.production.local'];

const parseEnvFile = (filePath, values, sources) => {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?(EXPO_PUBLIC_[A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (match) {
      values[match[1]] = match[2];
      sources[match[1]] = path.basename(filePath);
    }
  }
};

// Returns the resolved values plus, for each one, which file it actually came from —
// so a failure can name the file to fix instead of leaving the reader guessing.
const readDotEnv = () => {
  const values = {};
  const sources = {};
  for (const name of ENV_FILES_LOWEST_PRECEDENCE_FIRST) {
    parseEnvFile(path.resolve(__dirname, '..', name), values, sources);
  }
  return { values, sources };
};

(async () => {
  // Version (audit AUTH-7). Gradle falls back to versionCode 1 when PHC_VERSION_CODE
  // is unset, and such an APK can't install over the operators' app: the only way
  // round is an uninstall, which deletes the tablet's unsent field work. A release
  // must also sit above every QA build installed on a test device (vc66 for
  // the 2026-11-10 shared-tablet verification), or it can't replace it there.
  // Raise MIN_RELEASE_VERSION_CODE with each release. The name must match
  // app.json, which crash reports use.
  const MIN_RELEASE_VERSION_CODE = 67;
  const versionCodeText = String(process.env.PHC_VERSION_CODE || '').trim();
  if (!/^\d+$/.test(versionCodeText)) {
    fail(`PHC_VERSION_CODE must be set to a whole number (got "${versionCodeText}"). Without it Gradle builds versionCode 1, which can't install over the operators' app.`);
  }
  if (Number(versionCodeText) < MIN_RELEASE_VERSION_CODE) {
    fail(`PHC_VERSION_CODE ${versionCodeText} is below ${MIN_RELEASE_VERSION_CODE}, the lowest code above every build already installed. Use ${MIN_RELEASE_VERSION_CODE} or more.`);
  }
  const appJsonVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'app.json'), 'utf8')).expo.version;
  if (String(process.env.PHC_VERSION_NAME || '').trim() !== appJsonVersion) {
    fail(`PHC_VERSION_NAME ("${process.env.PHC_VERSION_NAME || ''}") must equal app.json expo.version ("${appJsonVersion}"), which crash reports use.`);
  }

  const { values: dotEnv, sources: envSource } = readDotEnv();
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || dotEnv.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || dotEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  // Name the file, not just the variable. The whole failure mode here is that the
  // offending value lives somewhere the developer forgot was still on disk.
  const from = (key) => (envSource[key] ? ` (from ${envSource[key]})` : ' (from the environment)');

  if (process.env.EXPO_PUBLIC_PHC_LOCAL_QA === 'true' || dotEnv.EXPO_PUBLIC_PHC_LOCAL_QA === 'true') {
    fail(`EXPO_PUBLIC_PHC_LOCAL_QA=true is forbidden for a production release${from('EXPO_PUBLIC_PHC_LOCAL_QA')}. Move that file aside, or use build:android:local-qa.`);
  }

  if (!supabaseUrl) {
    fail('EXPO_PUBLIC_SUPABASE_URL is missing (set it in .env or the environment).');
  }
  if (!anonKey) {
    fail('EXPO_PUBLIC_SUPABASE_ANON_KEY is missing (set it in .env or the environment).');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch (error) {
    fail(`EXPO_PUBLIC_SUPABASE_URL is not a valid URL: ${supabaseUrl}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    fail(`EXPO_PUBLIC_SUPABASE_URL must use HTTPS, got ${supabaseUrl}${from('EXPO_PUBLIC_SUPABASE_URL')}.`);
  }
  if (!parsedUrl.hostname.startsWith(`${EXPECTED_PROJECT_REF}.`)) {
    fail(`EXPO_PUBLIC_SUPABASE_URL host (${parsedUrl.hostname}) does not match the live project ref "${EXPECTED_PROJECT_REF}".`);
  }

  if (anonKey.split('.').length === 3) {
    // Legacy JWT format: the payload carries the project ref/role it was
    // minted for. A key from any other project is rejected by the API with
    // "Invalid API key" — catching it here saves a broken build.
    try {
      const payload = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64').toString('utf8'));
      if (payload.ref !== EXPECTED_PROJECT_REF) {
        fail(`EXPO_PUBLIC_SUPABASE_ANON_KEY belongs to project "${payload.ref}", not the live project "${EXPECTED_PROJECT_REF}". Copy the anon key from the Supabase dashboard (Project Settings -> API).`);
      }
      if (payload.role !== 'anon') {
        fail(`EXPO_PUBLIC_SUPABASE_ANON_KEY has role "${payload.role}" — only the public anon key may ship in the client. NEVER use the service_role key here.`);
      }
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.startsWith('[release-check]')) throw error;
      fail('EXPO_PUBLIC_SUPABASE_ANON_KEY does not look like a valid Supabase JWT anon key.');
    }
  } else if (anonKey.startsWith('sb_publishable_')) {
    // New key system: opaque token, can't be decoded locally. Verify it's
    // actually valid for the configured project with a live check instead —
    // a key from the wrong project gets rejected here just like the JWT
    // ref check above would have caught it.
    try {
      const settingsUrl = new URL('/auth/v1/settings', supabaseUrl).toString();
      const res = await fetch(settingsUrl, { headers: { apikey: anonKey } });
      if (!res.ok) {
        fail(`EXPO_PUBLIC_SUPABASE_ANON_KEY was rejected by ${parsedUrl.hostname} (HTTP ${res.status}). Copy the publishable key from the Supabase dashboard (Settings -> API Keys -> Publishable and secret API keys).`);
      }
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.startsWith('[release-check]')) throw error;
      fail(`Could not verify EXPO_PUBLIC_SUPABASE_ANON_KEY against ${parsedUrl.hostname}: ${error.message}`);
    }
  } else if (anonKey.startsWith('sb_secret_')) {
    fail('EXPO_PUBLIC_SUPABASE_ANON_KEY looks like a SECRET key (sb_secret_...) — only a PUBLISHABLE key (sb_publishable_...) or the legacy public anon key may ship in the client. NEVER put a secret key here.');
  } else {
    fail('EXPO_PUBLIC_SUPABASE_ANON_KEY does not look like a valid Supabase key (expected a legacy JWT anon key or an sb_publishable_... key).');
  }

  // A pre-bundled JS file in src/main/assets would be baked into the APK and
  // shadow-ship a stale app (this exact bug shipped the April pre-Supabase app
  // inside the 2026-07-09 QA APK). Release bundling is done by the gradle
  // react plugin; nothing should ever live here.
  const staleBundle = path.resolve(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'index.android.bundle');
  if (fs.existsSync(staleBundle)) {
    fail(`Stale pre-bundled JS found at ${staleBundle}. Delete it — release builds bundle fresh JS automatically.`);
  }

  const signingVars = [
    'PHC_UPLOAD_STORE_FILE',
    'PHC_UPLOAD_STORE_PASSWORD',
    'PHC_UPLOAD_KEY_ALIAS',
    'PHC_UPLOAD_KEY_PASSWORD',
  ];
  const missingSigningVars = signingVars.filter((name) => !process.env[name]);

  if (missingSigningVars.length > 0 && process.env.ALLOW_UNSIGNED_RELEASE !== 'true') {
    fail(`Missing Android signing variables: ${missingSigningVars.join(', ')}. Source secrets/android-signing.env first. Set ALLOW_UNSIGNED_RELEASE=true only to build an unsigned release candidate.`);
  }

  if (process.env.PHC_UPLOAD_STORE_FILE) {
    const storeFile = path.isAbsolute(process.env.PHC_UPLOAD_STORE_FILE)
      ? process.env.PHC_UPLOAD_STORE_FILE
      : path.resolve(__dirname, '..', 'android', process.env.PHC_UPLOAD_STORE_FILE);

    if (!fs.existsSync(storeFile)) {
      fail(`PHC_UPLOAD_STORE_FILE does not exist: ${storeFile}`);
    }
  }

  console.log('[release-check] Android release inputs look usable.');
})();
