// End-to-end closure audit against the seeded LOCAL Supabase stack.
//
// Run after `seed-local.js`. It deliberately completes one of the seeded
// closure_submitted projects, so reset + reseed before running it again.
// The hard-coded URL guard makes it impossible for this script to target the
// production project accidentally.
const { execFileSync } = require('child_process');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:54321';
const OPERATOR_PASSWORD = 'PHC-Local-Operator-v2!';
const ADMIN_EMAIL = 'qa_admin@phc.local';
const ADMIN_PASSWORD = 'PHC-Local-Admin-v2!';

if (new URL(URL_BASE).hostname !== '127.0.0.1') {
  throw new Error('Closure audit is LOCAL-only.');
}

const mintScript = path.join(__dirname, 'mint-local-jwt.js');
const mint = (role) => execFileSync(
  process.execPath,
  [mintScript, role, '--quiet'],
  { encoding: 'utf8' },
).trim();

const ANON = mint('anon');

async function login(email, password) {
  const response = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
  return { token: body.access_token, id: body.user.id };
}

const request = (token, route, options = {}) => fetch(`${URL_BASE}${route}`, {
  ...options,
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    ...(options.body && !(options.body instanceof Uint8Array)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(options.headers || {}),
  },
});

async function json(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.message || body?.error || text || `HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, body });
  }
  return body;
}

const rest = async (token, resource) => json(await request(token, `/rest/v1/${resource}`));
const rpc = async (token, name, args) => json(await request(token, `/rest/v1/rpc/${name}`, {
  method: 'POST',
  body: JSON.stringify(args),
}));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  <<< ${detail}`}`);
};

async function expectRejected(name, operation) {
  try {
    await operation();
    check(name, false, 'operation unexpectedly succeeded');
  } catch (error) {
    check(name, Number(error.status || 0) >= 400, `${error.status || 'no status'} ${error.message}`);
  }
}

(async () => {
  const runId = Date.now();
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const reports = await rest(
    admin.token,
    'completion_reports?select=id,project_id,operator_id,submission_payload,status&status=eq.submitted&order=id.asc&limit=1',
  );
  if (!reports.length) {
    throw new Error('No submitted completion report fixture. Reset and rerun seed-local.js first.');
  }

  const report = reports[0];
  const profiles = await rest(
    admin.token,
    `profiles?select=email&id=eq.${encodeURIComponent(report.operator_id)}`,
  );
  if (!profiles[0]?.email) {
    throw new Error(`Could not resolve operator email for report ${report.id}.`);
  }
  const operator = await login(profiles[0].email, OPERATOR_PASSWORD);

  const returned = await rpc(admin.token, 'return_completion_v2', {
    p_report_id: report.id,
    p_reason: 'Auditoría local: corregir y reconfirmar la Ficha',
  });
  check('admin returns unsigned Ficha with required reason', returned.status === 'returned', returned.status);

  const discrepancy = await rpc(operator.token, 'report_completion_discrepancy', {
    p_project_id: report.project_id,
    p_section: 'hidraulica',
    p_description: 'Discrepancia deliberada de la auditoría local',
    p_completion_report_id: report.id,
  });
  check('responsible operator records discrepancy', discrepancy?.status === 'open', discrepancy?.status);

  await expectRejected('open discrepancy blocks resubmission', () => rpc(operator.token, 'resubmit_completion_v2', {
    p_report_id: report.id,
    p_client_entry_id: `closure-audit-blocked-${report.id}-${runId}`,
    p_final_fields: report.submission_payload.final_fields,
    p_operator_signature: 'Operador QA reconfirmación bloqueada',
    p_completion_notes: 'Este intento debe fallar por discrepancia abierta',
    p_pdf_url: null,
  }));

  const resolved = await rpc(admin.token, 'resolve_completion_discrepancy', {
    p_discrepancy_id: discrepancy.id,
    p_resolution_note: 'Verificada y corregida durante la auditoría local',
  });
  check('admin resolves discrepancy with note', resolved?.status === 'resolved', resolved?.status);

  const resubmitted = await rpc(operator.token, 'resubmit_completion_v2', {
    p_report_id: report.id,
    p_client_entry_id: `closure-audit-resubmit-${report.id}-${runId}`,
    p_final_fields: report.submission_payload.final_fields,
    p_operator_signature: 'Operador QA reconfirmado',
    p_completion_notes: 'Ficha corregida y reconfirmada por auditoría local',
    p_pdf_url: null,
  });
  check('responsible operator reconfirms and resubmits', resubmitted?.status === 'submitted', resubmitted?.status);

  await expectRejected('operator cannot sign completion report', () => rpc(operator.token, 'sign_completion_report', {
    p_report_id: report.id,
    p_admin_signature: 'Firma no autorizada',
    p_complete_project: true,
    p_acknowledge_open_pedidos: true,
  }));

  await expectRejected('unreconciled materials block admin signature', () => rpc(admin.token, 'sign_completion_report', {
    p_report_id: report.id,
    p_admin_signature: 'Firma prematura no permitida',
    p_complete_project: true,
    p_acknowledge_open_pedidos: true,
  }));

  const projectMaterials = await rest(
    admin.token,
    `project_materials?select=id,current_quantity&project_id=eq.${report.project_id}&active=eq.true`,
  );
  for (const material of projectMaterials) {
    await rpc(admin.token, 'save_material_reconciliation', {
      p_project_id: report.project_id,
      p_project_material_id: material.id,
      p_returned_quantity: material.current_quantity,
      p_notes: 'Reconciliación exacta de la auditoría local',
    });
  }
  check('admin reconciles every active material', projectMaterials.length > 0, projectMaterials.length);

  const signed = await rpc(admin.token, 'sign_completion_report', {
    p_report_id: report.id,
    p_admin_signature: 'Admin QA cierre auditado',
    p_complete_project: true,
    p_acknowledge_open_pedidos: true,
  });
  check('admin signature approves report atomically', signed?.status === 'approved', signed?.status);

  const storagePath = `${report.project_id}/completion_closure_audit_${report.id}_signed.pdf`;
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
  const upload = await request(
    admin.token,
    `/storage/v1/object/phc-reports/${storagePath}`,
    { method: 'POST', body: pdf, headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' } },
  );
  check('admin uploads signed PDF to private Storage', upload.ok, `${upload.status} ${await upload.text()}`);

  const attached = await rpc(admin.token, 'attach_completion_pdf', {
    p_report_id: report.id,
    p_storage_path: storagePath,
  });
  check('signed PDF path attaches through RPC', attached?.pdf_url === storagePath, attached?.pdf_url);

  const directAnonymous = await fetch(`${URL_BASE}/storage/v1/object/phc-reports/${storagePath}`, {
    headers: { apikey: ANON },
  });
  check('private signed PDF rejects anonymous direct read', directAnonymous.status >= 400, directAnonymous.status);

  const signedUrlBody = await json(await request(
    admin.token,
    `/storage/v1/object/sign/phc-reports/${storagePath}`,
    { method: 'POST', body: JSON.stringify({ expiresIn: 60 }) },
  ));
  const signedPath = signedUrlBody.signedURL || signedUrlBody.signedUrl;
  const signedUrl = new URL(
    signedPath.startsWith('/storage/v1/') ? signedPath : `/storage/v1${signedPath}`,
    URL_BASE,
  );
  const signedRead = await fetch(signedUrl);
  check('authorized signed URL reads the PDF', signedRead.ok && (await signedRead.arrayBuffer()).byteLength > 0, signedRead.status);

  const finalRows = await rest(
    admin.token,
    `completion_reports?select=status,pdf_url,signed_pdf_attached_at,projects(status)&id=eq.${report.id}`,
  );
  const final = finalRows[0];
  check(
    'report, project, and PDF metadata converge',
    final?.status === 'approved'
      && final?.projects?.status === 'completed'
      && final?.pdf_url === storagePath
      && Boolean(final?.signed_pdf_attached_at),
    JSON.stringify(final),
  );

  await expectRejected('completed project remains immutable', async () => {
    const response = await request(admin.token, `/rest/v1/projects?id=eq.${report.project_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ target_depth: 9999 }),
    });
    return json(response);
  });
  await expectRejected('completion report cannot be signed twice', () => rpc(admin.token, 'sign_completion_report', {
    p_report_id: report.id,
    p_admin_signature: 'Segunda firma no permitida',
    p_complete_project: true,
    p_acknowledge_open_pedidos: true,
  }));

  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} FAILED`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error('AUDIT ERROR:', error.message);
  process.exit(1);
});
