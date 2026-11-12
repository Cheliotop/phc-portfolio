// Supabase free-tier projects pause after ~1 week without API traffic,
// which would take the whole PHC system down until someone finds the
// "Restore" button — unacceptable for a client who may not open the panel
// during a slow stretch. This endpoint makes one harmless authenticated-key
// request to Supabase; vercel.json schedules it daily (Hobby-plan crons are
// once per day, which is far inside the pause window).
//
// The request is a PostgREST read of the database (WEB-20): GoTrue's /auth/v1/settings
// answers without touching Postgres, which may not count as activity. When CRON_SECRET is
// set, Vercel sends it as `Authorization: Bearer <CRON_SECRET>` and any other caller is refused.
//
// It stays outside tsconfig's `include: ["src"]`, so the app's type-check
// doesn't see it; Vercel builds it independently as a serverless function.
export default async function handler(req: any, res: any) {
  // globalThis cast instead of `process.` — Vercel type-checks api/ functions
  // with its own tsconfig where Node globals aren't declared, and installing
  // @types/node in the project doesn't reach that checker.
  const env = (globalThis as any).process?.env ?? {};
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const cronSecret = env.CRON_SECRET;

  if (cronSecret && req?.headers?.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  if (!url || !key) {
    res.status(500).json({ ok: false, error: 'Supabase env vars missing' });
    return;
  }

  try {
    const r = await fetch(`${url}/rest/v1/settings?select=id&limit=1`, { headers: { apikey: key } });
    res.status(200).json({ ok: r.ok, supabase_status: r.status, at: new Date().toISOString() });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message || 'fetch failed' });
  }
}
