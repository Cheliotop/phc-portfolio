import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/keepalive.ts';

// Runs the cron handler with a fake fetch and response; restores the environment afterwards.
const run = async (env: Record<string, string | undefined>, headers: Record<string, string>) => {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: any }> = [];
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    await handler({ headers }, res);
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(env)) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
  return { res, calls };
};

const BASE = { VITE_SUPABASE_URL: 'https://portfolio-project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_REPLACE_WITH_YOUR_PROJECT_KEY' };

test('keepalive reads the settings table through PostgREST, not GoTrue', async () => {
  const { res, calls } = await run({ ...BASE, CRON_SECRET: undefined }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://portfolio-project.supabase.co/rest/v1/settings?select=id&limit=1');
  assert.equal(calls[0].init.headers.apikey, 'sb_publishable_REPLACE_WITH_YOUR_PROJECT_KEY');
  assert.equal(res.statusCode, 200);
});

test('with CRON_SECRET set, a caller without the bearer secret is refused and Supabase is not touched', async () => {
  const { res, calls } = await run({ ...BASE, CRON_SECRET: 'cron-secret-value' }, {});
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
  const wrong = await run({ ...BASE, CRON_SECRET: 'cron-secret-value' }, { authorization: 'Bearer otro' });
  assert.equal(wrong.res.statusCode, 401);
  assert.equal(wrong.calls.length, 0);
});

test('with CRON_SECRET set, the Vercel cron bearer runs the keepalive', async () => {
  const { res, calls } = await run({ ...BASE, CRON_SECRET: 'cron-secret-value' }, { authorization: 'Bearer cron-secret-value' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
});

test('without CRON_SECRET the keepalive still runs as before', async () => {
  const { res, calls } = await run({ ...BASE, CRON_SECRET: undefined }, {});
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
});
