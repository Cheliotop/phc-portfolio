#!/usr/bin/env node

/*
 * Deterministic, production-volume QA seed for a freshly reset LOCAL Supabase.
 *
 * Safety properties:
 * - refuses every non-loopback URL;
 * - requires the local publishable and secret keys via environment variables;
 * - refuses a non-empty database instead of trying to delete protected history;
 * - creates every login through GoTrue's Auth Admin API (never auth.users SQL).
 */

'use strict';

const LOCAL_URL = (process.env.PHC_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321').replace(/\/+$/, '');
const PUBLISHABLE_KEY = process.env.PHC_LOCAL_SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.PHC_LOCAL_SUPABASE_SECRET_KEY;

const ADMIN = {
  username: 'qa_admin',
  email: 'qa_admin@phc.local',
  password: 'PHC-Local-Admin-v2!',
  firstName: 'Admin',
  lastName: 'QA Local',
};

const OPERATOR_PASSWORD = 'PHC-Local-Operator-v2!';
const OPERATOR_COUNT = 10;
const PROJECT_COUNT = 30;

const expectedMinimums = {
  profiles: 11,
  projects: PROJECT_COUNT,
  materials: 30,
  catalog_materials: 30,
  catalog_variants: 60,
  project_materials: 144,
  shifts: 64,
  drilling_bars: 486,
  material_consumption: 288,
  pedidos: 100,
  pedido_items: 200,
  pedido_receipts: 60,
  completion_reports: 7,
  photos: 162,
};

function assertLocalTarget() {
  let parsed;
  try {
    parsed = new URL(LOCAL_URL);
  } catch {
    throw new Error(`PHC_LOCAL_SUPABASE_URL is not a valid URL: ${LOCAL_URL}`);
  }
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (parsed.protocol !== 'http:' || !isLoopback || parsed.port !== '54321') {
    throw new Error(
      `Refusing to seed ${LOCAL_URL}. This script only accepts http://127.0.0.1:54321 (or localhost/::1).`,
    );
  }
  // Two key formats are accepted because the local stack is mid-transition.
  // `supabase status` prints sb_publishable_/sb_secret_ keys, but the bundled
  // GoTrue only registers the ES256 EC key from GOTRUE_JWT_KEYS, so it rejects
  // the sb_ keys with `bad_jwt` on /auth/v1/admin/*. A JWT signed with that EC
  // key works against both the Admin API and PostgREST. See README for how to
  // mint one. The loopback guard above is what keeps this safe, not the key
  // prefix.
  const isJwt = (v) => typeof v === 'string' && v.split('.').length === 3;
  if (!PUBLISHABLE_KEY || !(PUBLISHABLE_KEY.startsWith('sb_publishable_') || isJwt(PUBLISHABLE_KEY))) {
    throw new Error(
      'Set PHC_LOCAL_SUPABASE_PUBLISHABLE_KEY to the LOCAL sb_publishable_ key or a local ES256 JWT.',
    );
  }
  if (!SECRET_KEY || !(SECRET_KEY.startsWith('sb_secret_') || isJwt(SECRET_KEY))) {
    throw new Error(
      'Set PHC_LOCAL_SUPABASE_SECRET_KEY to the LOCAL sb_secret_ key or a local service_role ES256 JWT.',
    );
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${LOCAL_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: options.apikey || SECRET_KEY,
      Authorization: `Bearer ${options.token || SECRET_KEY}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }
  if (!response.ok) {
    const details = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${details}`);
  }
  return { payload, headers: response.headers };
}

async function restInsert(table, rows) {
  const { payload } = await request(`/rest/v1/${table}?select=*`, {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'return=representation' },
  });
  return payload;
}

async function restPatch(table, filter, values) {
  const { payload } = await request(`/rest/v1/${table}?${filter}&select=*`, {
    method: 'PATCH',
    body: values,
    headers: { Prefer: 'return=representation' },
  });
  return payload;
}

async function rpc(name, body, token) {
  const { payload } = await request(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body,
    apikey: PUBLISHABLE_KEY,
    token,
  });
  return payload;
}

async function tableCount(table) {
  const { headers } = await request(`/rest/v1/${table}?select=id&limit=1`, {
    headers: { Prefer: 'count=exact', Range: '0-0' },
  });
  const contentRange = headers.get('content-range') || '';
  const total = Number(contentRange.split('/')[1]);
  if (!Number.isFinite(total)) throw new Error(`Could not read exact count for ${table}: ${contentRange}`);
  return total;
}

async function assertEmptyDatabase() {
  const checks = ['profiles', 'projects', 'catalog_materials', 'pedidos', 'drilling_bars'];
  const counts = Object.fromEntries(await Promise.all(checks.map(async (table) => [table, await tableCount(table)])));
  const populated = Object.entries(counts).filter(([, count]) => count !== 0);
  if (populated.length > 0) {
    throw new Error(
      `Local database is not empty (${populated.map(([table, count]) => `${table}=${count}`).join(', ')}). ` +
      'Run `supabase db reset`, then run this seed once.',
    );
  }
}

async function createAuthUser({ username, email, password, firstName, lastName }) {
  const { payload } = await request('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`,
        qa_seed: true,
      },
    },
  });
  if (!payload?.id) throw new Error(`Auth Admin API did not return an id for ${email}`);
  return { ...payload, username, email, password, firstName, lastName };
}

async function login(email, password) {
  const { payload } = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
    apikey: PUBLISHABLE_KEY,
    token: PUBLISHABLE_KEY,
  });
  if (!payload?.access_token) throw new Error(`Password login did not return an access token for ${email}`);
  return payload.access_token;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function isoDaysAgo(days, hour = 12) {
  // Relative to the actual current time, not a hardcoded calendar date — a
  // fixed anchor (e.g. 2026-07-20) silently ages past "today" as real
  // wall-clock time moves on, so "isoDaysAgo(0, ...)" (meant to seed a fresh,
  // still-open shift) eventually lands more than 12h in the past and the
  // seeded shift auto-closes into report_pending before any test can use it.
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, hour, 0, 0));
  return date.toISOString();
}

function dateDaysAgo(days) {
  return isoDaysAgo(days).slice(0, 10);
}

async function main() {
  assertLocalTarget();
  await assertEmptyDatabase();
  console.log(`Seeding LOCAL Supabase at ${LOCAL_URL}`);

  console.log('1/10 Creating Auth users through the Auth Admin API...');
  const adminUser = await createAuthUser(ADMIN);
  const operators = [];
  for (let index = 1; index <= OPERATOR_COUNT; index += 1) {
    const suffix = String(index).padStart(2, '0');
    operators.push(await createAuthUser({
      username: `qa_operator_${suffix}`,
      email: `qa_operator_${suffix}@phc.local`,
      password: OPERATOR_PASSWORD,
      firstName: `Operador ${suffix}`,
      lastName: 'QA Local',
    }));
  }
  const promoted = await restPatch('profiles', `id=eq.${adminUser.id}`, {
    role: 'admin',
    is_active: true,
  });
  if (promoted?.[0]?.role !== 'admin') throw new Error('Local admin profile promotion did not persist.');

  const adminToken = await login(ADMIN.email, ADMIN.password);
  const operatorTokens = [];
  for (const operator of operators) operatorTokens.push(await login(operator.email, operator.password));

  console.log('2/10 Creating legacy inventory and permanent catalog...');
  const materialNames = [
    'Bentonita', 'Grava seleccionada', 'Cemento', 'Tubería PVC', 'Filtro ranurado',
    'Centralizador', 'Tapón de fondo', 'Cable sumergible', 'Bomba sumergible', 'Combustible diésel',
    'Lubricante', 'Broca tricónica', 'Broca PDC', 'Barra de perforación', 'Manguera de impulsión',
    'Válvula de retención', 'Abrazadera', 'Electrodo', 'Arena lavada', 'Hipoclorito',
    'Guantes de trabajo', 'Casco de seguridad', 'Agua potable', 'Alimento de cuadrilla', 'Lona impermeable',
    'Soga de seguridad', 'Kit de muestreo', 'Bidón graduado', 'Manómetro', 'Caudalímetro',
  ];
  const legacyMaterials = await restInsert('materials', materialNames.map((name, index) => ({
    name,
    type: index % 7 === 0 ? 'tool' : 'consumable',
    category: index % 5 === 0 ? 'Equipo' : 'Perforación',
    unit: index % 4 === 0 ? 'kg' : 'unidad',
    quantity: 500 + index * 10,
    min_quantity: 25,
    current_stock: 500 + index * 10,
    minimum_stock: 25,
    cost_per_unit: 10 + index * 2.5,
    supplier: `Proveedor QA ${String((index % 6) + 1).padStart(2, '0')}`,
    description: 'Inventario local de volumen para pruebas end-to-end',
  })));
  const catalogMaterials = await restInsert('catalog_materials', materialNames.map((name, index) => ({
    name,
    external_code: `MAT-QA-${String(index + 1).padStart(3, '0')}`,
    material_type: index % 7 === 0 ? 'tool' : (index % 9 === 0 ? 'fuel' : 'consumable'),
    unit: index % 4 === 0 ? 'kg' : 'unidad',
    measurement_method: index % 4 === 0 ? 'weight' : 'quantity',
    active: true,
    created_by: adminUser.id,
  })));
  const variantRows = [];
  for (let index = 0; index < catalogMaterials.length; index += 1) {
    for (let variant = 1; variant <= 2; variant += 1) {
      variantRows.push({
        material_id: catalogMaterials[index].id,
        display_name: variant === 1 ? 'Estándar' : 'Reforzado',
        external_code: `VAR-QA-${String(index + 1).padStart(3, '0')}-${variant}`,
        diameter: index % 3 === 0 ? (variant === 1 ? '6\"' : '8\"') : null,
        length_m: index % 3 === 0 ? (variant === 1 ? 3 : 6) : null,
        dimension_text: variant === 1 ? 'Configuración estándar' : 'Configuración reforzada',
        active: true,
        created_by: adminUser.id,
      });
    }
  }
  const catalogVariants = await restInsert('catalog_variants', variantRows);

  console.log('3/10 Creating 30 projects with varied lifecycle targets...');
  const targetStatuses = [
    ...Array(3).fill('planning'),
    ...Array(20).fill('active'),
    ...Array(4).fill('closure_submitted'),
    ...Array(3).fill('completed'),
  ];
  const projects = await restInsert('projects', targetStatuses.map((targetStatus, index) => {
    const operator = operators[index % operators.length];
    const projectNumber = String(index + 1).padStart(2, '0');
    return {
      name: `Pozo QA Chaco ${projectNumber}`,
      well_name: `PHC-QA-${projectNumber}`,
      location: ['Mariscal Estigarribia', 'Filadelfia', 'Loma Plata', 'Neuland'][index % 4],
      description: `Dataset local realista; objetivo final ${targetStatus}`,
      client: `Cliente QA ${(index % 8) + 1}`,
      type: 'drilling',
      project_type: index % 3 === 0 ? 'exploration' : 'water_well',
      target_depth: 90 + (index % 6) * 10,
      default_bar_length: 3,
      default_bar_diameter: index % 2 === 0 ? '6\"' : '8\"',
      coordinates: `${-22.2 - index * 0.03}, ${-60.1 - index * 0.02}`,
      status: targetStatus === 'planning' ? 'planning' : 'active',
      start_date: dateDaysAgo(45 - (index % 12)),
      estimated_completion: dateDaysAgo(-20 - (index % 12)),
      progress_percentage: targetStatus === 'planning' ? 0 : 65 + (index % 31),
      assigned_operator_id: operator.id,
      created_by: adminUser.id,
      created_at: isoDaysAgo(60 - (index % 15)),
    };
  }));

  console.log('4/10 Assigning both project-material layers at volume...');
  const materialProjectIndexes = Array.from({ length: 24 }, (_, offset) => offset + 3);
  const projectMaterialRows = [];
  for (const projectIndex of materialProjectIndexes) {
    for (let slot = 0; slot < 6; slot += 1) {
      const variant = catalogVariants[(projectIndex * 5 + slot) % catalogVariants.length];
      const legacy = legacyMaterials[(projectIndex * 5 + slot) % legacyMaterials.length];
      projectMaterialRows.push({
        project_id: projects[projectIndex].id,
        material_id: legacy.id,
        material_name: `${legacy.name} · QA`,
        quantity_allocated: 200,
        initial_quantity: 200,
        current_quantity: 197.5,
        unit: legacy.unit,
        notes: 'Asignación de carga QA local',
        layer: slot % 2 === 0 ? 'presupuesto' : 'extras',
        catalog_variant_id: variant.id,
        active: true,
      });
    }
  }
  const projectMaterials = await restInsert('project_materials', projectMaterialRows);
  const assignmentsByProject = new Map();
  for (const assignment of projectMaterials) {
    const list = assignmentsByProject.get(assignment.project_id) || [];
    list.push(assignment);
    assignmentsByProject.set(assignment.project_id, list);
  }

  console.log('5/10 Creating closed and open shifts plus continuous drilling history...');
  const closedShiftRows = [];
  for (let projectIndex = 3; projectIndex < projects.length; projectIndex += 1) {
    const project = projects[projectIndex];
    const operator = operators[projectIndex % operators.length];
    for (let shiftNumber = 0; shiftNumber < 2; shiftNumber += 1) {
      const started = isoDaysAgo(18 - (projectIndex % 8) + shiftNumber, 7);
      const ended = new Date(new Date(started).getTime() + 9 * 60 * 60 * 1000).toISOString();
      closedShiftRows.push({
        client_entry_id: `qa-shift-closed-${projectIndex}-${shiftNumber}`,
        project_id: project.id,
        operator_id: operator.id,
        status: 'closed',
        started_at: started,
        ended_at: ended,
        start_device_time: started,
        end_device_time: ended,
        end_type: shiftNumber % 3 === 0 ? 'auto' : 'manual',
        usage_report_submitted: true,
        handover_confirmed: true,
        device_time_flag: shiftNumber % 7 === 0,
        notes: 'Turno histórico QA local',
      });
    }
  }
  const closedShifts = await restInsert('shifts', closedShiftRows);
  const closedShiftsByProject = new Map();
  for (const shift of closedShifts) {
    const list = closedShiftsByProject.get(shift.project_id) || [];
    list.push(shift);
    closedShiftsByProject.set(shift.project_id, list);
  }
  const openShifts = await restInsert('shifts', Array.from({ length: 10 }, (_, offset) => {
    const projectIndex = offset + 3;
    const operator = operators[projectIndex % operators.length];
    return {
      client_entry_id: `qa-shift-open-${projectIndex}`,
      project_id: projects[projectIndex].id,
      operator_id: operator.id,
      status: 'open',
      // A few hours before now, not "today at 07:00 UTC": seeded between 00:00 and 07:00 UTC
      // (evenings in Asunción) that was in the future, and closing it broke shifts_check.
      started_at: isoHoursAgo(2 + (offset % 3)),
      start_device_time: isoHoursAgo(2 + (offset % 3)),
      usage_report_submitted: false,
      handover_confirmed: offset % 2 === 0,
      device_time_flag: false,
      notes: 'Turno abierto para pruebas de reanudación',
    };
  }));
  if (openShifts.length !== 10) throw new Error('Expected ten open shifts.');

  const barRows = [];
  const photoRows = [];
  for (let projectIndex = 3; projectIndex < projects.length; projectIndex += 1) {
    const project = projects[projectIndex];
    const operator = operators[projectIndex % operators.length];
    const shift = closedShiftsByProject.get(project.id)[1];
    for (let barNumber = 1; barNumber <= 18; barNumber += 1) {
      const depthStart = (barNumber - 1) * 3;
      barRows.push({
        client_entry_id: `qa-bar-${projectIndex}-${barNumber}`,
        project_id: project.id,
        operator_id: operator.id,
        bar_number: barNumber,
        depth_start: depthStart,
        depth_end: depthStart + 3,
        length: 3,
        diameter: project.default_bar_diameter,
        soil_type: ['Arena fina', 'Arcilla compacta', 'Caliza', 'Grava húmeda'][barNumber % 4],
        start_time: '07:30',
        end_time: '08:05',
        duration_minutes: 30 + (barNumber % 11),
        water_level: barNumber >= 12 ? 34 + (barNumber % 4) : null,
        notes: 'Continuidad de profundidad validable en QA',
        timestamp_local: isoDaysAgo(15 - (barNumber % 10), 8),
        shift_id: shift.id,
      });
    }
    for (let photoNumber = 1; photoNumber <= 6; photoNumber += 1) {
      photoRows.push({
        project_id: project.id,
        storage_path: `${project.id}/qa/photo-${photoNumber}.jpg`,
        filename: `photo-${photoNumber}.jpg`,
        original_name: `evidencia-pozo-${projectIndex}-${photoNumber}.jpg`,
        file_size: 180000 + photoNumber * 15000,
        mime_type: 'image/jpeg',
        caption: photoNumber % 3 === 0 ? 'Muestra de agua y avance' : 'Avance de perforación',
        uploaded_by: operator.id,
        shift_id: shift.id,
        evidence_kind: photoNumber % 3 === 0 ? 'water_sample' : 'field',
      });
    }
  }
  await restInsert('drilling_bars', barRows);
  await restInsert('photos', photoRows);

  console.log('6/10 Creating material-consumption history...');
  const consumptionRows = [];
  for (const projectIndex of materialProjectIndexes) {
    const project = projects[projectIndex];
    const operator = operators[projectIndex % operators.length];
    const assignments = assignmentsByProject.get(project.id);
    const shift = closedShiftsByProject.get(project.id)[0];
    for (let eventNumber = 0; eventNumber < 12; eventNumber += 1) {
      const assignment = assignments[eventNumber % assignments.length];
      consumptionRows.push({
        client_entry_id: `qa-consumption-${projectIndex}-${eventNumber}`,
        project_id: project.id,
        operator_id: operator.id,
        project_material_id: assignment.id,
        material_id: assignment.material_id,
        material_name: assignment.material_name,
        quantity_used: 1.25,
        unit: assignment.unit,
        date: dateDaysAgo(12 - (eventNumber % 8)),
        notes: 'Consumo histórico QA local',
        shift_id: shift.id,
        approximate: eventNumber % 7 === 0,
        anomaly_flag: eventNumber % 11 === 0,
      });
    }
  }
  await restInsert('material_consumption', consumptionRows);

  // Water samples are seeded through the operator RPC so the immutability
  // guarantee has a fixture. Without rows here, the water_samples check in
  // integrity-audit.js has nothing to act on and the guarantee goes untested -
  // production carries protect_water_samples_immutable and
  // protect_water_samples_after_project_finalization, and both should be
  // exercised.
  console.log('6b/10 Registering water samples through the operator RPC...');
  for (const projectIndex of materialProjectIndexes) {
    const project = projects[projectIndex];
    const operatorIndex = projectIndex % operators.length;
    for (let sampleNumber = 1; sampleNumber <= 2; sampleNumber += 1) {
      await rpc('register_water_sample', {
        p_project_id: project.id,
        p_client_entry_id: `qa-water-${projectIndex}-${sampleNumber}`,
        p_taken_at: new Date(Date.now() - sampleNumber * 86400000).toISOString(),
        p_depth_m: 18.5 + sampleNumber * 4,
        p_stage: sampleNumber === 1 ? 'perforacion' : 'finalizacion',
        p_notes: `Muestra de agua QA local ${sampleNumber}`,
        p_sample_number: sampleNumber,
      }, operatorTokens[operatorIndex]);
    }
  }

  console.log('7/10 Creating 100 pedidos through the operator RPC...');
  const pedidoResults = [];
  for (let projectIndex = 3; projectIndex < 23; projectIndex += 1) {
    const operatorIndex = projectIndex % operators.length;
    for (let pedidoNumber = 0; pedidoNumber < 5; pedidoNumber += 1) {
      const kind = (projectIndex + pedidoNumber) % 2 === 0 ? 'empresa' : 'personal';
      const variantA = catalogVariants[(projectIndex * 3 + pedidoNumber) % catalogVariants.length];
      const variantB = catalogVariants[(projectIndex * 3 + pedidoNumber + 17) % catalogVariants.length];
      const result = await rpc('create_pedido_v2', {
        p_project_id: projects[projectIndex].id,
        p_kind: kind,
        p_items: [
          {
            client_entry_id: `qa-pedido-item-${projectIndex}-${pedidoNumber}-a`,
            catalog_variant_id: variantA.id,
            requested_quantity: 4 + (pedidoNumber % 3),
            layer: pedidoNumber % 2 === 0 ? 'presupuesto' : 'extras',
          },
          {
            client_entry_id: `qa-pedido-item-${projectIndex}-${pedidoNumber}-b`,
            catalog_variant_id: variantB.id,
            requested_quantity: 2 + (projectIndex % 4),
            layer: pedidoNumber % 2 === 0 ? 'extras' : 'presupuesto',
          },
        ],
        p_client_entry_id: `qa-pedido-${projectIndex}-${pedidoNumber}`,
        p_justification: kind === 'empresa' ? 'Reposición necesaria para continuidad de obra' : null,
        p_priority: ['Baja', 'Normal', 'Alta'][pedidoNumber % 3],
        p_needed_by: dateDaysAgo(-(pedidoNumber + 2)),
        p_notes: `Pedido QA modo ${pedidoNumber}`,
      }, operatorTokens[operatorIndex]);
      pedidoResults.push({ ...result, mode: pedidoNumber, operatorIndex, projectIndex });
    }
  }

  console.log('8/10 Advancing pedido decisions and receipts through their RPCs...');
  for (const result of pedidoResults) {
    if (result.mode === 0) continue;
    for (const item of result.items) {
      if (result.mode === 2) {
        await rpc('decide_pedido_item', {
          p_item_id: item.id,
          p_decision: 'rechazado',
          p_approved_quantity: null,
          p_reason: 'Rechazo deliberado del escenario QA',
          p_layer: item.layer,
        }, adminToken);
      } else {
        await rpc('decide_pedido_item', {
          p_item_id: item.id,
          p_decision: 'aprobado',
          p_approved_quantity: item.requested_quantity,
          p_reason: 'Aprobación de escenario QA',
          p_layer: item.layer,
        }, adminToken);
      }
    }
    if (result.mode === 3) {
      for (const item of result.items) {
        await rpc('confirm_pedido_item_receipt', {
          p_item_id: item.id,
          p_client_entry_id: `qa-receipt-full-${item.id}`,
          p_outcome: 'recibido',
          p_quantity_received: item.requested_quantity,
          p_incident_note: null,
        }, operatorTokens[result.operatorIndex]);
      }
    }
    if (result.mode === 4) {
      const item = result.items[0];
      await rpc('confirm_pedido_item_receipt', {
        p_item_id: item.id,
        p_client_entry_id: `qa-receipt-partial-${item.id}`,
        p_outcome: 'parcial',
        p_quantity_received: item.requested_quantity / 2,
        p_incident_note: 'Entrega parcial deliberada para QA',
      }, operatorTokens[result.operatorIndex]);
    }
  }

  console.log('9/10 Submitting seven Fichas v2 and signing three to completion...');
  const closureProjectIndexes = Array.from({ length: 7 }, (_, offset) => offset + 23);
  await restInsert('project_closing_assignments', closureProjectIndexes.map((projectIndex) => ({
    project_id: projects[projectIndex].id,
    operator_id: operators[projectIndex % operators.length].id,
    assigned_by: adminUser.id,
  })));
  const completionReports = [];
  for (const projectIndex of closureProjectIndexes) {
    const report = await rpc('submit_completion_v2', {
      p_project_id: projects[projectIndex].id,
      p_client_entry_id: `qa-completion-v2-${projectIndex}`,
      p_final_fields: {
        static_level: 12,
        dynamic_level: 18,
        flow_rate: 1500,
        maximum_flow_rate: 1800,
        pump_depth_m: 70,
        exploration_depth_m: 90,
        widening_depth_m: 82,
        casing_total_m: 80,
        casing_above_ground_m: 0.5,
        blind_casing_m: 35,
        filter_casing_m: 40,
        sediment_trap_m: 5,
        centralizer_count: 12,
        bottom_plug_details: 'Tapón cementado y verificado',
        bentonite_quantity: 18,
        gravel_quantity: 42,
        casing_layout: [
          { order: 1, type: 'ciego', meters: 35 },
          { order: 2, type: 'filtro', meters: 40 },
          // 'deposito' is the sediment-trap segment. Valid casing types are
          // constrained to ciego|filtro|deposito|otro by
          // 20260712204006_phc_adversarial_integrity_hardening.sql.
          { order: 3, type: 'deposito', meters: 5 },
        ],
        compressor_hours: 8,
        pump_hours: 12,
        water_quality: 'Clara, sin olor',
        installed_meters: 80,
        perforated_meters: 90,
      },
      p_operator_signature: `Operador QA ${String((projectIndex % 10) + 1).padStart(2, '0')}`,
      p_completion_notes: 'Ficha v2 generada por el seeder local reproducible',
      p_pdf_url: null,
    }, operatorTokens[projectIndex % operators.length]);
    completionReports.push({ projectIndex, report });
  }
  for (const { projectIndex, report } of completionReports.filter(({ projectIndex }) => projectIndex >= 27)) {
    await rpc('sign_completion_report', {
      p_report_id: report.id,
      p_admin_signature: 'Admin QA Local',
      p_complete_project: true,
      p_acknowledge_open_pedidos: false,
    }, adminToken);
  }

  console.log('10/10 Verifying exact counts, lifecycle distribution, and password logins...');
  const counts = {};
  for (const table of Object.keys(expectedMinimums)) counts[table] = await tableCount(table);
  for (const [table, minimum] of Object.entries(expectedMinimums)) {
    if (counts[table] < minimum) throw new Error(`${table}: expected at least ${minimum}, found ${counts[table]}`);
  }
  const { payload: statusRows } = await request('/rest/v1/projects?select=status');
  const statusCounts = statusRows.reduce((accumulator, row) => {
    accumulator[row.status] = (accumulator[row.status] || 0) + 1;
    return accumulator;
  }, {});
  const expectedStatuses = { planning: 3, active: 20, closure_submitted: 4, completed: 3 };
  for (const [status, expected] of Object.entries(expectedStatuses)) {
    if (statusCounts[status] !== expected) {
      throw new Error(`Project status ${status}: expected ${expected}, found ${statusCounts[status] || 0}`);
    }
  }
  await login(ADMIN.email, ADMIN.password);
  await login(operators[0].email, OPERATOR_PASSWORD);

  console.log('\nLOCAL QA seed completed successfully.');
  console.log(JSON.stringify({ counts, project_statuses: statusCounts }, null, 2));
  console.log(`Admin: ${ADMIN.email} / ${ADMIN.password}`);
  console.log(`Operators: qa_operator_01@phc.local ... qa_operator_10@phc.local / ${OPERATOR_PASSWORD}`);
}

main().catch((error) => {
  console.error(`\nLOCAL QA seed FAILED: ${error.message}`);
  process.exitCode = 1;
});
