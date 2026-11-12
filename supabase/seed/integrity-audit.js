// Data-integrity audit against the seeded LOCAL stack.
// Attempts to violate the guarantees the client's records depend on.
// Runs as the ADMIN app user - the most privileged non-service role.
const crypto = require('crypto');
const URL_BASE = 'http://127.0.0.1:54321';

const jwk = require('./local-signing-key.js');
const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(role) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'ES256', typ: 'JWT', kid: jwk.kid });
  const p = b64({ role, iss: `${URL_BASE}/auth/v1`, aud: 'authenticated', iat: now, exp: now + 3600 });
  const s = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${s}`;
}
const ANON = mint('anon');
const SERVICE = mint('service_role');

async function login(email, password) {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed: ${JSON.stringify(j).slice(0, 120)}`);
  return { token: j.access_token, id: j.user.id };
}
const rest = (token, path, opts = {}) =>
  fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '  <<< ' + detail}`);
};

(async () => {
  const admin = await login('qa_admin@phc.local', 'PHC-Local-Admin-v2!');

  // 1. NaN rejected by the finite CHECK constraints (service role - constraint, not RLS).
  const nanIns = await rest(SERVICE, 'materials', {
    method: 'POST',
    body: JSON.stringify({ name: `integrity-nan-${Date.now()}`, category: 'test', unit: 'u', quantity: 'NaN' }),
  });
  check('NaN rejected by finite CHECK', nanIns.status >= 400, `status ${nanIns.status}`);

  // 2. Infinity rejected too.
  const infIns = await rest(SERVICE, 'materials', {
    method: 'POST',
    body: JSON.stringify({ name: `integrity-inf-${Date.now()}`, category: 'test', unit: 'u', quantity: 'Infinity' }),
  });
  check('Infinity rejected by finite CHECK', infIns.status >= 400, `status ${infIns.status}`);

  // 3. Duplicate client_entry_id rejected - the offline-sync idempotency guarantee.
  const bars = await (await rest(SERVICE, 'drilling_bars?select=client_entry_id,project_id&client_entry_id=not.is.null&limit=1')).json();
  if (bars.length) {
    const dup = await rest(SERVICE, 'drilling_bars', {
      method: 'POST',
      body: JSON.stringify({
        project_id: bars[0].project_id, bar_number: 88888, depth_start: 0, depth_end: 1,
        length: 1, soil_type: 'arcilla', client_entry_id: bars[0].client_entry_id,
      }),
    });
    check('duplicate client_entry_id rejected', dup.status >= 400, `status ${dup.status}`);
  } else {
    check('duplicate client_entry_id rejected', false, 'no seeded bar with client_entry_id');
  }

  // 4. audit_log is append-only: admin cannot UPDATE.
  const auditRow = await (await rest(SERVICE, 'audit_log?select=id&limit=1')).json();
  if (auditRow.length) {
    const upd = await rest(SERVICE, `audit_log?id=eq.${auditRow[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ action: 'TAMPERED' }),
    });
    check('audit_log cannot be updated', upd.status >= 400, `status ${upd.status}`);
    const del = await rest(SERVICE, `audit_log?id=eq.${auditRow[0].id}`, { method: 'DELETE' });
    check('audit_log cannot be deleted', del.status >= 400, `status ${del.status}`);
  } else {
    check('audit_log cannot be updated', false, 'no audit rows seeded');
    check('audit_log cannot be deleted', false, 'no audit rows seeded');
  }

  // 5. Completed projects are protected from mutation.
  const done = await (await rest(SERVICE, 'projects?select=id&status=eq.completed&limit=1')).json();
  if (done.length) {
    const mut = await rest(admin.token, `projects?id=eq.${done[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ target_depth: 999 }),
    });
    check('completed project cannot be mutated', mut.status >= 400, `status ${mut.status}`);
  } else {
    check('completed project cannot be mutated', false, 'no completed project seeded');
  }

  // Project geometry is protected at the table boundary as well as in forms.
  const active = await (await rest(SERVICE, 'projects?select=id&status=eq.active&limit=1')).json();
  if (active.length) {
    const negativeDepth = await rest(admin.token, `projects?id=eq.${active[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ target_depth: -1 }),
    });
    check('negative project target depth rejected', negativeDepth.status >= 400, `status ${negativeDepth.status}`);
    const zeroBar = await rest(admin.token, `projects?id=eq.${active[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ default_bar_length: 0 }),
    });
    check('nonpositive default bar length rejected', zeroBar.status >= 400, `status ${zeroBar.status}`);
  } else {
    check('negative project target depth rejected', false, 'no active project found');
    check('nonpositive default bar length rejected', false, 'no active project found');
  }

  // 6. Drilling bars in a completed project are frozen.
  if (done.length) {
    const frozenBar = await (await rest(SERVICE, `drilling_bars?select=id&project_id=eq.${done[0].id}&limit=1`)).json();
    if (frozenBar.length) {
      const mut = await rest(SERVICE, `drilling_bars?id=eq.${frozenBar[0].id}`, {
        method: 'PATCH', body: JSON.stringify({ depth_end: 12345 }),
      });
      check('bars in completed project are frozen', mut.status >= 400, `status ${mut.status}`);
    } else {
      check('bars in completed project are frozen', false, 'no bars in completed project');
    }
  }

  // 7. Water samples immutable.
  const ws = await (await rest(SERVICE, 'water_samples?select=id&limit=1')).json();
  if (ws.length) {
    const mut = await rest(SERVICE, `water_samples?id=eq.${ws[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ notes: 'tampered' }),
    });
    check('water_samples immutable', mut.status >= 400, `status ${mut.status}`);
  } else {
    // Never let a missing fixture silently remove a check. An untested
    // guarantee must look like a failure, not like a pass.
    check('water_samples immutable', false, 'NO FIXTURE: seeder creates 0 water_samples - guarantee is UNTESTED');
  }

  // 8. Closed shifts protected.
  const closed = await (await rest(SERVICE, 'shifts?select=id&ended_at=not.is.null&limit=1')).json();
  if (closed.length) {
    const mut = await rest(SERVICE, `shifts?id=eq.${closed[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ notes: 'tampered after close' }),
    });
    check('closed shifts protected', mut.status >= 400, `status ${mut.status}`);
  } else {
    check('closed shifts protected', false, 'no closed shift found');
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} FAILED`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error('AUDIT ERROR:', e.message); process.exit(1); });
