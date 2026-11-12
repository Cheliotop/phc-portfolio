// Which Supabase keys the PHC edge functions use (audit SEC-2, 2026-11-08).
//
// Production has had its legacy API keys (the anon and service_role JWTs) DISABLED
// since 2026-07-28, yet the platform still injects SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY into every function. Trying those first made the admin
// functions (create operator, reset password, delete attachment) fail on production.
// So: always prefer the new keys, and fall back to the legacy variables only where
// the new ones are absent, i.e. a local `supabase functions serve`, which cannot
// supply SUPABASE_SECRET_KEYS.

const fromJsonEnv = (name: string, ...entries: string[]): string | null => {
  try {
    const parsed = JSON.parse(Deno.env.get(name) || '{}') as Record<string, unknown>;
    for (const entry of entries) {
      const value = parsed[entry];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // Malformed JSON: treat as absent and fall back.
  }
  return null;
};

/** Server-side key with full access. Production: the `admin_create_operator` secret key. */
export const serviceKey = (): string | null =>
  fromJsonEnv('SUPABASE_SECRET_KEYS', 'admin_create_operator', 'default') ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ||
  null;

/** Client key used together with the caller's JWT, only to check who is calling. */
export const publishableKey = (): string | null =>
  Deno.env.get('PHC_PUBLISHABLE_KEY')?.trim() ||
  fromJsonEnv('SUPABASE_PUBLISHABLE_KEYS', 'default') ||
  Deno.env.get('SUPABASE_ANON_KEY')?.trim() ||
  null;
