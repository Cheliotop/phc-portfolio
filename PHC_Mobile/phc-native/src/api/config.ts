// The Node/Express backend has been retired — Supabase is now the sole
// backend (see docs/PHC_SUPABASE_MIGRATION_PLAN_2026-07-08.md). This file
// used to also export API_BASE_URL, resolved from EXPO_PUBLIC_API_URL with a
// hard `throw` if unset in production builds. That variable was never set in
// .env and nothing imports API_BASE_URL anymore (the old src/api/client.ts
// that used it has been deleted), so every production build was one
// `import './config'` away from crashing at startup with an error about a
// server that no longer exists. Removed entirely rather than left as dead
// code, since a `throw` at module scope is a landmine, not inert.

const PRODUCTION_SUPABASE_URL = 'https://portfolio-project.supabase.co';
const PRODUCTION_SUPABASE_ANON_KEY = 'sb_publishable_REPLACE_WITH_YOUR_PROJECT_KEY';
const LOCAL_QA_SUPABASE_URL = 'http://10.0.2.2:54321';
const localQaBuild = process.env.EXPO_PUBLIC_PHC_LOCAL_QA === 'true';
const configuredSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const configuredSupabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// A non-production endpoint is accepted only by the explicit local-QA build.
// This is also enforced before Gradle runs (validate-android-local-qa.js / the
// production release validator), but keeping the invariant here makes a
// misconfigured bundle fail loudly instead of silently talking to the wrong DB.
if (localQaBuild) {
  if (configuredSupabaseUrl !== LOCAL_QA_SUPABASE_URL || !configuredSupabaseKey) {
    throw new Error(
      `Local QA requires EXPO_PUBLIC_SUPABASE_URL=${LOCAL_QA_SUPABASE_URL} and an explicit local API key.`,
    );
  }
} else if (configuredSupabaseUrl && configuredSupabaseUrl !== PRODUCTION_SUPABASE_URL) {
  throw new Error('A non-production Supabase URL requires EXPO_PUBLIC_PHC_LOCAL_QA=true.');
}

export const SUPABASE_URL = localQaBuild
  ? configuredSupabaseUrl!
  : (configuredSupabaseUrl || PRODUCTION_SUPABASE_URL);
// Publishable key for project portfolio-project (public by design — RLS
// enforces access). Replaces the legacy JWT-based anon key on 2026-07-10;
// the exported name stays SUPABASE_ANON_KEY since that's what every caller
// already imports. Production defaults to an sb_publishable_ key; the bundled
// local GoTrue instead requires an ES256 anon JWT from its local signing key.
export const SUPABASE_ANON_KEY = localQaBuild
  ? configuredSupabaseKey!
  : (configuredSupabaseKey || PRODUCTION_SUPABASE_ANON_KEY);
