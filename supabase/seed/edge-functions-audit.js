// End-to-end Edge Function audit against the seeded LOCAL Supabase stack.
// It creates one disposable operator and one disposable attachment. Run only
// after seed-local.js; the fixed loopback guard prevents production use.
const { execFileSync } = require('child_process');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:54321';
const ADMIN_EMAIL = 'qa_admin@phc.local';
const ADMIN_PASSWORD = 'PHC-Local-Admin-v2!';
const OPERATOR_EMAIL = 'qa_operator_01@phc.local';
const OPERATOR_PASSWORD = 'PHC-Local-Operator-v2!';

if (new URL(URL_BASE).hostname !== '127.0.0.1') throw new Error('Edge audit is LOCAL-only.');

const mintScript = path.join(__dirname, 'mint-local-jwt.js');
const ANON = execFileSync(process.execPath, [mintScript, 'anon', '--quiet'], { encoding: 'utf8' }).trim();

async function login(email, password) {
  const response = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Login failed: ${response.status}`);
  return { token: body.access_token, id: body.user.id };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  <<< ${detail}`}`);
};

async function api(token, route, options = {}) {
  const response = await fetch(`${URL_BASE}${route}`, {
    ...options,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      ...(options.body && !(options.body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

const invoke = (token, name, body) => api(token, `/functions/v1/${name}`, {
  method: 'POST', body: JSON.stringify(body),
});

(async () => {
  const runId = Date.now();
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const operator = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);

  const unauthorizedCreate = await invoke(operator.token, 'admin-create-operator', {
    username: `edge_forbidden_${runId}`, password: 'NotCreated-v2!',
  });
  check('operator cannot create another operator', unauthorizedCreate.response.status === 403, unauthorizedCreate.response.status);

  const username = `edge_audit_${runId}`;
  const firstPassword = 'Edge-Audit-v2!';
  const secondPassword = 'Edge-Reset-v2!';
  const created = await invoke(admin.token, 'admin-create-operator', {
    username, password: firstPassword, first_name: 'Edge', last_name: 'Audit',
  });
  const createdId = created.body?.user?.id;
  check(
    'admin creates an operator without replacing the caller session',
    created.response.ok && created.body?.user?.role === 'operator' && Boolean(createdId),
    `${created.response.status} ${JSON.stringify(created.body)}`,
  );

  const resetByOperator = await invoke(operator.token, 'admin-reset-operator-password', {
    operator_id: createdId, new_password: secondPassword,
  });
  check('operator cannot reset another password', resetByOperator.response.status === 403, resetByOperator.response.status);

  const resetAdmin = await invoke(admin.token, 'admin-reset-operator-password', {
    operator_id: admin.id, new_password: secondPassword,
  });
  check('password reset refuses an admin target', resetAdmin.response.status === 403, resetAdmin.response.status);

  const reset = await invoke(admin.token, 'admin-reset-operator-password', {
    operator_id: createdId, new_password: secondPassword,
  });
  check('admin resets an operator password', reset.response.ok && reset.body?.ok === true, `${reset.response.status} ${JSON.stringify(reset.body)}`);
  const relogin = await login(`${username}@phc.local`, secondPassword);
  check('operator can authenticate with the reset password', relogin.id === createdId, relogin.id);

  const pedido = await api(
    operator.token,
    `/rest/v1/pedidos?select=id&operator_id=eq.${operator.id}&order=id.asc&limit=1`,
  );
  const notified = await invoke(operator.token, 'notify-email', {
    type: 'pedido_created', entity_id: pedido.body?.[0]?.id,
  });
  check(
    'authorized notification derives content and fails safe when email is unconfigured',
    notified.response.ok && notified.body?.sent === false && notified.body?.reason === 'not_configured',
    `${notified.response.status} ${JSON.stringify(notified.body)}`,
  );

  // The partner can create pedidos too. Notification authorization must use the
  // same crew model, rather than checking only assigned_operator_id.
  const partner = await login('qa_operator_02@phc.local', OPERATOR_PASSWORD);
  const crewProject = await api(admin.token, '/rest/v1/projects', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: `Edge crew ${runId}`, status: 'active', assigned_operator_id: operator.id }),
  });
  const crewProjectId = crewProject.body?.[0]?.id;
  if (!crewProject.response.ok || !crewProjectId) throw new Error('Could not prepare crew notification project');
  const crew = await api(admin.token, '/rest/v1/rpc/set_project_equipo', {
    method: 'POST', body: JSON.stringify({ p_project_id: crewProjectId, p_operator_id: operator.id, p_partner_id: partner.id }),
  });
  if (!crew.response.ok) throw new Error('Could not assign the second crew operator');
  const crewPedido = await api(partner.token, '/rest/v1/rpc/create_pedido_v2', {
    method: 'POST', body: JSON.stringify({
      p_project_id: crewProjectId, p_kind: 'empresa', p_client_entry_id: `edge-crew-${runId}`,
      p_justification: 'Prueba de notificacion del equipo',
      p_items: [{ material_name: 'Material QA', requested_quantity: 1, unit: 'u', layer: 'extras' }],
    }),
  });
  const crewPedidoId = crewPedido.body?.pedido?.id;
  if (!crewPedido.response.ok || !crewPedidoId) throw new Error('Could not prepare partner pedido');
  const partnerNotice = await invoke(partner.token, 'notify-email', { type: 'pedido_created', entity_id: crewPedidoId });
  check('the second crew operator can notify their pedido',
    partnerNotice.response.ok && partnerNotice.body?.sent === false && partnerNotice.body?.reason === 'not_configured',
    `${partnerNotice.response.status} ${JSON.stringify(partnerNotice.body)}`);
  const otherAuthorNotice = await invoke(operator.token, 'notify-email', { type: 'pedido_created', entity_id: crewPedidoId });
  check('crew membership does not allow notifying another operator pedido', otherAuthorNotice.response.status === 403, otherAuthorNotice.response.status);
  const outsiderNotice = await invoke(relogin.token, 'notify-email', { type: 'pedido_created', entity_id: crewPedidoId });
  check('an operator outside the crew cannot notify its pedido', outsiderNotice.response.status === 404, outsiderNotice.response.status);

  const project = await api(admin.token, '/rest/v1/projects?select=id&status=eq.active&order=id.asc&limit=1');
  const projectId = project.body?.[0]?.id;
  const storagePath = `${projectId}/attachments/edge_audit_${runId}.pdf`;
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
  const uploaded = await api(admin.token, `/storage/v1/object/phc-reports/${storagePath}`, {
    method: 'POST', body: pdf, headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
  });
  check('admin uploads a constrained project attachment', uploaded.response.ok, `${uploaded.response.status} ${JSON.stringify(uploaded.body)}`);

  const registered = await api(admin.token, '/rest/v1/rpc/register_project_attachment', {
    method: 'POST',
    body: JSON.stringify({
      p_project_id: projectId,
      p_kind: 'otro',
      p_storage_path: storagePath,
      p_filename: 'edge-audit.pdf',
      p_mime_type: 'application/pdf',
      p_notes: 'Adjunto temporal de auditoria',
      p_water_sample_id: null,
    }),
  });
  const attachmentId = registered.body?.id;
  check('attachment registration verifies the stored object', registered.response.ok && Boolean(attachmentId), `${registered.response.status} ${JSON.stringify(registered.body)}`);

  const forbiddenDelete = await invoke(operator.token, 'admin-delete-project-attachment', {
    attachment_id: attachmentId, reason: 'Intento no autorizado',
  });
  check('operator cannot delete an attachment', forbiddenDelete.response.status === 403, forbiddenDelete.response.status);

  const deleted = await invoke(admin.token, 'admin-delete-project-attachment', {
    attachment_id: attachmentId, reason: 'Limpieza de auditoria local',
  });
  check('admin deletion removes Storage before metadata finalization', deleted.response.ok && deleted.body?.deleted === true, `${deleted.response.status} ${JSON.stringify(deleted.body)}`);

  const replay = await invoke(admin.token, 'admin-delete-project-attachment', {
    attachment_id: attachmentId, reason: 'Reintento idempotente',
  });
  check('attachment deletion replay is idempotent', replay.response.ok && replay.body?.idempotent_replay === true, `${replay.response.status} ${JSON.stringify(replay.body)}`);

  const remaining = await api(admin.token, `/rest/v1/project_attachments?select=id&id=eq.${attachmentId}`);
  const stored = await api(admin.token, `/storage/v1/object/authenticated/phc-reports/${storagePath}`);
  check('attachment metadata and physical object are both gone', remaining.body?.length === 0 && stored.response.status === 400, `${remaining.body?.length}/${stored.response.status}`);

  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} FAILED`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error('AUDIT ERROR:', error.message);
  process.exit(1);
});
