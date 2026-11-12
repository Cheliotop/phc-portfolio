import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrintableDossierHtml } from '../src/utils/printableDossier.ts';
import { buildDossierCrew } from '../src/domain/dossierCrew.ts';

// The dossier goes to the client (code read W2): no stored codes, no UUIDs, no
// private paths, and the client's own name.
const OPERATOR = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SHIFT = '16fd2706-8baf-433b-82eb-8c7fada847da';
const report = {
  id: 9, project_id: 21, operator_id: OPERATOR, status: 'approved',
  profiles: { full_name: 'Ana Benítez' }, projects: { name: 'Pozo Norte' },
} as any;
const dossier = {
  project: { id: 21, name: 'Pozo Norte', status: 'completed', client: 'Estancia La Paz', assigned_operator_id: OPERATOR },
  bars: [], photos: [{ id: 1, evidence_kind: 'field', shift_id: SHIFT, storage_path: '21/secret_path.jpg', original_name: 'a.jpg' }],
  shifts: [{ id: SHIFT, started_at: '2026-11-07T10:00:00Z', status: 'closed', end_type: 'admin' }],
  shift_handovers: [{ id: 2, shift_id: SHIFT, project_material_id: 31, status: 'flagged', photo_path: '21/h.jpg' }],
  materials: [{ id: 31, material_name: 'Bentonita', layer: 'presupuesto' }],
  consumption: [], samples: [], company_pedidos: [], corrections: [], discrepancies: [],
  completion: { id: 9, status: 'approved', pdf_url: '21/private.pdf' },
  attachments: [], reconciliations: [],
  audit: [{ id: 1, actor_id: OPERATOR, entity_type: 'shifts', action: 'shift.closed', metadata: { a: 1 } }],
} as any;

test('prints the client and words, not codes', () => {
  const html = buildPrintableDossierHtml(report, dossier, new Date('2026-11-08T12:00:00Z'));
  assert.ok(html.includes('Estancia La Paz'), 'client name');
  assert.ok(html.includes('Cerrado por el administrador'));
  assert.ok(html.includes('Completado'));
  assert.ok(html.includes('Diferencia'));
  assert.ok(html.includes('Bentonita'));
  assert.ok(html.includes('Ana Benítez'));
});

test('prints no UUIDs, private paths or raw JSON', () => {
  const html = buildPrintableDossierHtml(report, dossier, new Date('2026-11-08T12:00:00Z'));
  assert.ok(!html.includes(OPERATOR), 'operator UUID');
  assert.ok(!html.includes(SHIFT), 'shift UUID');
  assert.ok(!html.includes('secret_path') && !html.includes('private.pdf') && !html.includes('21/h.jpg'), 'paths');
  assert.ok(!/>admin<|>closed<|>flagged<|>field</.test(html), 'raw codes');
  assert.ok(!html.includes('{&quot;a&quot;:1}'), 'raw metadata');
});

// WEB-12 and the equipo: each row names who typed it, each shift lists its crew,
// late bars say so, and no truncated UUID or stored code reaches the client.
const PARTNER = 'b1f0c3d2-1111-4222-8333-944455556666';
const crew = buildDossierCrew(
  [
    { id: OPERATOR, full_name: 'Ana Benítez', username: 'ana' },
    { id: PARTNER, full_name: null, username: 'beto' },
  ],
  [
    { shift_id: SHIFT, operator_id: OPERATOR },
    { shift_id: SHIFT, operator_id: PARTNER },
  ],
);
const crewDossier = {
  ...dossier,
  bars: [{ id: 5, bar_number: 3, operator_id: PARTNER, arrived_late: true, start_time: '2026-11-08T03:30:00Z' }],
  shifts: [{ id: SHIFT, operator_id: OPERATOR, started_at: '2026-11-07T10:00:00Z', status: 'closed', end_type: 'admin' }],
  samples: [{ id: 7, sample_number: 1, operator_id: PARTNER, taken_at: '2026-11-07T11:00:00Z' }],
  consumption: [{ id: 8, operator_id: PARTNER, date: '2026-11-07', quantity_used: 2 }],
  audit: [{ id: 2, actor_id: PARTNER, entity_type: 'shifts', action: 'shift.force_closed', created_at: '2026-11-08T01:00:00Z' }],
} as any;

test('each row names who entered it, the shift lists its crew, late bars say so', () => {
  const html = buildPrintableDossierHtml(report, crewDossier, new Date('2026-11-08T12:00:00Z'), crew);
  assert.ok(html.includes('Ingresado por'), 'column header');
  assert.ok(html.includes('beto'), 'partner who typed the bar, sample and consumption');
  assert.ok(html.includes('Ana Benítez · beto'), 'both participants on the shift');
  assert.ok(html.includes('Llegó tarde'), 'arrived_late bar');
});

test('the audit names the partner and translates action codes', () => {
  const html = buildPrintableDossierHtml(report, crewDossier, new Date('2026-11-08T12:00:00Z'), crew);
  assert.ok(!html.includes('Usuario ' + PARTNER.slice(0, 8)), 'no truncated UUID');
  assert.ok(html.includes('Turno cerrado por el administrador'));
  assert.ok(!html.includes('shift.force_closed'));
  assert.ok(!html.includes(PARTNER), 'no UUID anywhere');
});

test('times print in Paraguay time, whatever zone the admin is in', () => {
  // 03:30 UTC is 00:30 in Asunción (UTC-3): the bar started on the 8th there too.
  const html = buildPrintableDossierHtml(report, crewDossier, new Date('2026-11-08T12:00:00Z'), crew);
  assert.ok(html.includes('08/11/2026, 12:30'), 'Asunción time (es-PY prints 12-hour)');
});

test('the footer no longer describes storage paths', () => {
  const html = buildPrintableDossierHtml(report, crewDossier, new Date('2026-11-08T12:00:00Z'), crew);
  assert.ok(!html.includes('ruta de almacenamiento'));
});
