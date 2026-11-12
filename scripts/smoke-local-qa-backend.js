#!/usr/bin/env node

const baseUrl = (process.env.PHC_QA_API_URL || 'http://127.0.0.1:5051').replace(/\/+$/, '');

const request = async (method, path, body, token) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${text}`);
  }

  return data;
};

const unique = Date.now();

(async () => {
  const health = await request('GET', '/api/health');
  console.log('health:', health.status);

  const adminLogin = await request('POST', '/api/auth/login', {
    username: 'admin',
    password: 'admin123',
  });
  const adminToken = adminLogin.token;
  console.log('admin login: OK');

  const operator = await request('POST', '/api/auth/register', {
    username: `qa_operator_${unique}`,
    email: `qa_operator_${unique}@phc.local`,
    password: 'operator123',
    role: 'operator',
    first_name: 'QA',
    last_name: 'Operator',
  });
  const operatorId = operator.user.id;
  const operatorToken = operator.token;
  console.log('operator created:', operatorId);

  const project = await request('POST', '/api/projects', {
    name: `QA Pozo ${unique}`,
    well_name: `QA-${unique}`,
    client: 'QA Local',
    location: 'Local QA',
    coordinates: '-25.2637, -57.5759',
    assigned_operator: operatorId,
    target_depth: 30,
    default_bar_length: 3,
    default_bar_diameter: '6"',
    project_type: 'drilling',
    status: 'active',
  }, adminToken);
  const projectId = project.project_id || project.id || project.project?.id;
  console.log('project created:', projectId);

  const nextBar = await request('GET', `/api/drilling-bars/next?project_id=${projectId}`, null, operatorToken);
  console.log('next bar:', nextBar.data?.bar_number || nextBar.bar_number || 'OK');

  const bar = await request('POST', '/api/drilling-bars', {
    client_entry_id: `qa_bar_${unique}`,
    project_id: projectId,
    bar_number: 1,
    depth_start: 0,
    depth_end: 3,
    length: 3,
    diameter: '6"',
    soil_type: 'Arena',
    notes: 'Local QA smoke test',
    timestamp_local: new Date().toISOString(),
  }, operatorToken);
  console.log('bar saved:', bar.data?.id || bar.id || 'OK');

  const pedido = await request('POST', '/api/pedidos', {
    project_id: projectId,
    material: 'Tuberia PVC QA',
    quantity: 2,
    priority: 'Normal',
    reason: 'Local QA smoke test',
    needed_by: new Date().toISOString().slice(0, 10),
    pedido_type: 'materiales',
    notes: 'Local QA smoke test',
  }, operatorToken);
  console.log('pedido saved:', pedido.pedido?.id || 'OK');

  const completion = await request('POST', '/api/completion', {
    project_id: projectId,
    static_level: 12,
    dynamic_level: 18,
    flow_rate: 1500,
    required_flow: 1200,
    bucket_flow_rate: 1450,
    flow_unit: 'L/h',
    compressor_hours: 2,
    pump_hours: 1,
    water_quality: 'Clara',
    perforated_meters: 30,
    installed_meters: 27,
    materials_summary: 'PVC QA',
    completion_checklist: ['Pozo limpiado/desarrollado', 'Tuberia instalada'],
    operator_signature: 'QA Operator',
    client_signature: 'QA Client',
  }, operatorToken);
  const completionId = completion.data?.id;
  console.log('completion saved:', completionId);

  await request('PUT', `/api/completion/${completionId}/admin-signature`, {
    admin_signature: 'QA Admin',
  }, adminToken);
  console.log('admin signature: OK');

  console.log(`Smoke test passed for ${baseUrl}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
