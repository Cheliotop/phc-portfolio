// Adversarial RLS audit against the seeded LOCAL stack.
// Logs in as real users and tries to break isolation. Prints PASS/FAIL only.
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
  if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j).slice(0, 120)}`);
  return { token: j.access_token, id: j.user.id };
}

const rest = (token, path, opts = {}) =>
  fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '  <<< ' + detail}`);
};

(async () => {
  const admin = await login('qa_admin@phc.local', 'PHC-Local-Admin-v2!');
  const op1 = await login('qa_operator_01@phc.local', 'PHC-Local-Operator-v2!');
  const op2 = await login('qa_operator_02@phc.local', 'PHC-Local-Operator-v2!');

  // Ground truth via service role.
  const allProjects = await (await rest(SERVICE, 'projects?select=id,assigned_operator_id')).json();
  const op2Projects = allProjects.filter((p) => p.assigned_operator_id === op2.id).map((p) => p.id);
  const op1Projects = allProjects.filter((p) => p.assigned_operator_id === op1.id).map((p) => p.id);

  // 1. Admin sees all projects.
  const adminProjects = await (await rest(admin.token, 'projects?select=id')).json();
  check('admin sees all projects', adminProjects.length === allProjects.length,
    `admin ${adminProjects.length} vs total ${allProjects.length}`);

  // 2. Operator does NOT see every project.
  const op1Sees = await (await rest(op1.token, 'projects?select=id,assigned_operator_id')).json();
  check('operator does not see all projects', op1Sees.length < allProjects.length,
    `op1 sees ${op1Sees.length} of ${allProjects.length}`);

  // 3. Operator sees NO project assigned to another operator.
  const leaked = op1Sees.filter((p) => op2Projects.includes(p.id));
  check('operator cannot see another operator projects', leaked.length === 0,
    `leaked project ids: ${leaked.map((p) => p.id).join(',')}`);

  // 4. Operator cannot read another operator's PERSONAL pedidos.
  const op2Personal = await (await rest(SERVICE, `pedidos?select=id&kind=eq.personal&operator_id=eq.${op2.id}`)).json();
  const op1SeesPersonal = await (await rest(op1.token, `pedidos?select=id&kind=eq.personal&operator_id=eq.${op2.id}`)).json();
  check('personal pedido privacy holds',
    Array.isArray(op1SeesPersonal) && op1SeesPersonal.length === 0,
    `op2 has ${op2Personal.length} personal pedidos, op1 sees ${JSON.stringify(op1SeesPersonal).slice(0, 80)}`);

  // 5. Operator cannot escalate own role to admin.
  const esc = await rest(op1.token, `profiles?id=eq.${op1.id}`, {
    method: 'PATCH', body: JSON.stringify({ role: 'admin' }),
  });
  const roleNow = await (await rest(SERVICE, `profiles?select=role&id=eq.${op1.id}`)).json();
  check('operator cannot self-escalate to admin',
    esc.status >= 400 || roleNow[0]?.role === 'operator',
    `status ${esc.status}, role is now ${roleNow[0]?.role}`);

  // 6. Operator cannot deactivate another operator.
  const deact = await rest(op1.token, `profiles?id=eq.${op2.id}`, {
    method: 'PATCH', body: JSON.stringify({ is_active: false }),
  });
  const op2Active = await (await rest(SERVICE, `profiles?select=is_active&id=eq.${op2.id}`)).json();
  check('operator cannot deactivate another operator',
    deact.status >= 400 || op2Active[0]?.is_active === true,
    `status ${deact.status}, op2 is_active=${op2Active[0]?.is_active}`);

  // 7. Operator cannot write a drilling bar into another operator's project.
  if (op2Projects.length) {
    const ins = await rest(op1.token, 'drilling_bars', {
      method: 'POST',
      body: JSON.stringify({
        project_id: op2Projects[0], bar_number: 99999, depth_start: 0, depth_end: 3,
        length: 3, soil_type: 'arcilla', client_entry_id: `rls-audit-${Date.now()}`,
      }),
    });
    check('operator cannot insert bar into foreign project', ins.status >= 400,
      `status ${ins.status}`);
  }

  // 8. Operator cannot read the audit log.
  const audit = await rest(op1.token, 'audit_log?select=id&limit=1');
  const auditBody = await audit.json();
  check('operator cannot read audit_log',
    audit.status >= 400 || (Array.isArray(auditBody) && auditBody.length === 0),
    `status ${audit.status}, rows ${JSON.stringify(auditBody).slice(0, 60)}`);

  // 9. Anonymous (no login) cannot read projects.
  const anonRead = await fetch(`${URL_BASE}/rest/v1/projects?select=id&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  const anonBody = await anonRead.json();
  check('anonymous cannot read projects',
    anonRead.status >= 400 || (Array.isArray(anonBody) && anonBody.length === 0),
    `status ${anonRead.status}, rows ${JSON.stringify(anonBody).slice(0, 60)}`);

  // 10. Operator cannot call an admin-only RPC.
  const rpc = await rest(op1.token, 'rpc/approve_pedido', {
    method: 'POST', body: JSON.stringify({ p_pedido_id: 1, p_quantity_override: null, p_notes: 'rls audit' }),
  });
  check('operator cannot call approve_pedido', rpc.status >= 400, `status ${rpc.status}`);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} FAILED`);
  console.log(`context: op1 assigned ${op1Projects.length} projects, op2 assigned ${op2Projects.length}`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error('AUDIT ERROR:', e.message); process.exit(1); });
