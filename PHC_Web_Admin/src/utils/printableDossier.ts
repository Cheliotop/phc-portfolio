import type {
  CompletionReport,
  JsonRecord,
  ProjectDossier,
} from '../types/completionReview';
import {
  arrivedLateLabel,
  EMPTY_DOSSIER_CREW,
  enteredByLabel,
  shiftCrewLabel,
  type DossierCrew,
} from '../domain/dossierCrew.ts';

export const escapeHtml = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const dateTime = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // The client document reads in Paraguay time, whatever zone the admin's computer is in (WEB-15).
    timeZone: 'America/Asuncion',
  });
};

const valueText = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[dato no serializable]';
    }
  }
  return String(value);
};

/**
 * The dossier goes to the client, so every stored code reads as words (code read W2).
 * An unknown code still prints as itself rather than disappearing.
 */
const words = (labels: Record<string, string>) => (value: unknown): unknown =>
  typeof value === 'string' && labels[value] ? labels[value] : value;

const projectStatusText = words({
  planning: 'En planificación', active: 'Activo', closure_submitted: 'Cierre enviado',
  completed: 'Completado', paused: 'Pausado', cancelled: 'Cancelado',
});
const fichaStatusText = words({ submitted: 'Enviada', returned: 'Devuelta al operador', approved: 'Firmada' });
const shiftStatusText = words({
  open: 'Abierto', report_pending: 'Informe pendiente', closed: 'Cerrado', rejected: 'Rechazado',
});
// Audit action codes, in words for the client (WEB-12). Unknown codes print as they are.
const auditActionText = words({
  'shift.closed': 'Turno cerrado',
  'shift.force_closed': 'Turno cerrado por el administrador',
  'shift.handover_confirmed': 'Entrega de turno confirmada',
  'bars_registered': 'Barras registradas',
  'sample.registered': 'Muestra registrada',
  'pedido_created': 'Pedido creado',
  'pedido_item.received': 'Ítem de pedido recibido',
  'completion_signed': 'Ficha firmada',
  'record.corrected': 'Registro corregido',
});
const endTypeText = words({
  manual: 'Cerrado por el operador', auto: 'Cierre automático (12 h)', admin: 'Cerrado por el administrador',
});
const handoverStatusText = words({ confirmed: 'Coincide', flagged: 'Diferencia' });
const evidenceKindText = words({ field: 'Campo', water_sample: 'Muestra de agua' });
const layerText = words({ presupuesto: 'Presupuesto', extras: 'Extras' });
const itemStateText = words({
  solicitado: 'Solicitado', aprobado: 'Aprobado', rechazado: 'Rechazado', parcial: 'Entrega parcial',
  recibido: 'Recibido', no_recibido: 'No recibido', cerrado: 'Cerrado',
});
const outcomeText = itemStateText;
const discrepancyStatusText = words({ open: 'Abierta', resolved: 'Resuelta' });
const entityText = words({
  shifts: 'Turno', drilling_bars: 'Barra', completion_reports: 'Ficha', material_consumption: 'Consumo',
  water_samples: 'Muestra de agua', projects: 'Proyecto', pedidos: 'Pedido', pedido_items: 'Ítem de pedido',
  photos: 'Foto', project_materials: 'Material', shift_handovers: 'Entrega de turno',
});

const cell = (value: unknown): string => `<td>${escapeHtml(valueText(value))}</td>`;

interface Column {
  label: string;
  value: (row: JsonRecord) => unknown;
}

const table = (rows: JsonRecord[], columns: Column[], empty = 'Sin registros.'): string => {
  if (!rows.length) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `
    <table>
      <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${columns.map((column) => cell(column.value(row))).join('')}</tr>`).join('')}</tbody>
    </table>`;
};

const detailGrid = (record: JsonRecord | null, labels: Record<string, string>): string => {
  if (!record) return '<p class="empty">Sin datos.</p>';
  const entries = Object.entries(labels).filter(([key]) => record[key] !== undefined);
  if (!entries.length) return '<p class="empty">Sin datos.</p>';
  return `<dl class="details">${entries.map(([key, label]) => `
    <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(valueText(record[key]))}</dd></div>`).join('')}</dl>`;
};

const section = (title: string, body: string): string => `
  <section>
    <h2>${escapeHtml(title)}</h2>
    ${body}
  </section>`;

const projectLabels: Record<string, string> = {
  id: 'ID del proyecto',
  name: 'Proyecto',
  well_name: 'Pozo',
  location: 'Ubicación',
  description: 'Descripción',
  status: 'Estado',
  client: 'Cliente',
  start_date: 'Inicio',
  end_date: 'Finalización',
  target_depth: 'Profundidad objetivo',
};

const completionLabels: Record<string, string> = {
  id: 'ID de Ficha',
  format_version: 'Versión de formato',
  status: 'Estado',
  submitted_at: 'Enviada',
  finalized_at: 'Finalizada',
  static_level: 'Nivel estático',
  dynamic_level: 'Nivel dinámico',
  flow_rate: 'Caudal bombeado',
  specific_flow_rate: 'Caudal específico',
  maximum_flow_rate: 'Caudal máximo',
  pump_depth_m: 'Profundidad de bomba (m)',
  specific_flow_overridden: 'Caudal específico reemplazado',
  hydraulic_mismatch: 'Diferencia hidráulica observada',
  exploration_depth_m: 'Profundidad de exploración (m)',
  widening_depth_m: 'Profundidad de ensanche (m)',
  casing_total_m: 'Entubado total (m)',
  casing_above_ground_m: 'Entubado sobre terreno (m)',
  blind_casing_m: 'Entubado ciego (m)',
  filter_casing_m: 'Entubado filtro (m)',
  sediment_trap_m: 'Trampa de sedimentos (m)',
  centralizer_count: 'Centralizadores',
  bottom_plug_details: 'Tapón de fondo',
  bentonite_quantity: 'Bentonita',
  gravel_quantity: 'Grava',
  compressor_hours: 'Horas de compresor',
  pump_hours: 'Horas de bomba',
  water_quality: 'Calidad del agua',
  installed_meters: 'Metros instalados',
  perforated_meters: 'Metros perforados',
  completion_notes: 'Notas finales',
};

export const buildPrintableDossierHtml = (
  report: CompletionReport,
  dossier: ProjectDossier,
  generatedAt = new Date(),
  crew: DossierCrew = EMPTY_DOSSIER_CREW,
): string => {
  const project = dossier.project;
  const completion = (dossier.completion || report) as JsonRecord;
  const correctionMap = new Map<string, JsonRecord>();
  [...dossier.corrections]
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')))
    .forEach((correction) => correctionMap.set(
      `${correction.entity_type}:${correction.entity_id}:${correction.field_name}`,
      correction,
    ));
  const correctionFor = (entity: string, row: JsonRecord, field: string) =>
    correctionMap.get(`${entity}:${row.id}:${field}`);
  const corrected = (entity: string, row: JsonRecord, field: string): unknown => {
    const correction = correctionFor(entity, row, field);
    if (!correction) return row[field];
    return `${valueText(correction.corrected_value)} · CORREGIDO (${valueText(correction.reason)})`;
  };
  const correctedDate = (entity: string, row: JsonRecord, field: string): string => {
    const correction = correctionFor(entity, row, field);
    if (!correction) return dateTime(row[field]);
    return `${dateTime(correction.corrected_value)} · CORREGIDO (${valueText(correction.reason)})`;
  };
  const effectiveCompletion: JsonRecord = { ...completion };
  Object.keys(completionLabels).forEach((field) => {
    effectiveCompletion[field] = corrected('completion_reports', completion, field);
  });
  effectiveCompletion.status = fichaStatusText(effectiveCompletion.status);
  const projectName = valueText(project?.well_name || project?.name || report.projects?.well_name || report.projects?.name || `Proyecto #${report.project_id}`);
  const operatorName = valueText(report.profiles?.full_name || report.profiles?.username || 'Operador');
  const materialNames = new Map(dossier.materials.map((row) => [String(row.id), row.material_name]));
  const materialName = (id: unknown) => (id === null || id === undefined ? null : materialNames.get(String(id)) ?? `Material #${valueText(id)}`);
  const shiftStarts = new Map(dossier.shifts.map((row) => [String(row.id), row.started_at]));
  const shiftText = (id: unknown) => (id ? `Turno del ${dateTime(shiftStarts.get(String(id)))}` : '—');
  const shown = (value: unknown) => (value ? 'Sí' : '—');
  const printedProject: JsonRecord | null = project
    ? { ...project, status: projectStatusText(project.status) }
    : null;
  const correctedCasing = correctionMap.get(`completion_reports:${completion.id}:casing_layout`)
    ?.corrected_value ?? completion.casing_layout;
  const casing = Array.isArray(correctedCasing)
    ? correctedCasing.filter((row): row is JsonRecord => Boolean(row) && typeof row === 'object')
    : [];
  const pedidoItems = dossier.company_pedidos.flatMap((pedido) => {
    const items = Array.isArray(pedido.items) ? pedido.items : [];
    return items.map((item) => ({
      pedido: pedido.pedido_number || `#${pedido.id}`,
      pedido_status: pedido.status,
      justification: pedido.justification,
      ...item,
    }));
  });
  const pedidoReceipts = dossier.company_pedidos.flatMap((pedido) => (
    pedido.items || []
  ).flatMap((item) => (
    item.receipts || []
  ).map((receipt) => ({
    pedido: pedido.pedido_number || `#${pedido.id}`,
    material: item.material_name_snapshot,
    unit: item.unit_snapshot,
    ...receipt,
  }))));

  const blocks = [
    section('Proyecto', detailGrid(printedProject, projectLabels)),
    section('Resumen de trazabilidad', `
      <dl class="details summary">
        <div><dt>Barras</dt><dd>${dossier.bars.length}</dd></div>
        <div><dt>Turnos</dt><dd>${dossier.shifts.length}</dd></div>
        <div><dt>Entregas</dt><dd>${dossier.shift_handovers.length}</dd></div>
        <div><dt>Fotos</dt><dd>${dossier.photos.length}</dd></div>
        <div><dt>Materiales</dt><dd>${dossier.materials.length}</dd></div>
        <div><dt>Consumos</dt><dd>${dossier.consumption.length}</dd></div>
        <div><dt>Muestras</dt><dd>${dossier.samples.length}</dd></div>
        <div><dt>Pedidos empresa</dt><dd>${dossier.company_pedidos.length}</dd></div>
        <div><dt>Correcciones</dt><dd>${dossier.corrections.length}</dd></div>
        <div><dt>Discrepancias</dt><dd>${dossier.discrepancies.length}</dd></div>
      </dl>`),
    section('Perforación — barras', table(dossier.bars, [
      { label: 'Barra', value: (row) => row.bar_number },
      { label: 'Ingresado por', value: (row) => enteredByLabel(row.operator_id, crew) },
      { label: 'Llegada', value: (row) => arrivedLateLabel(row) },
      { label: 'Inicio', value: (row) => correctedDate('drilling_bars', row, 'start_time') },
      { label: 'Fin', value: (row) => correctedDate('drilling_bars', row, 'end_time') },
      { label: 'Duración (min)', value: (row) => corrected('drilling_bars', row, 'duration_minutes') },
      { label: 'Prof. inicio', value: (row) => corrected('drilling_bars', row, 'depth_start') },
      { label: 'Prof. fin', value: (row) => corrected('drilling_bars', row, 'depth_end') },
      { label: 'Notas', value: (row) => corrected('drilling_bars', row, 'notes') },
    ])),
    section('Turnos', table(dossier.shifts, [
      { label: 'Inicio', value: (row) => correctedDate('shifts', row, 'started_at') },
      { label: 'Fin', value: (row) => correctedDate('shifts', row, 'ended_at') },
      { label: 'Ingresado por', value: (row) => enteredByLabel(row.operator_id, crew) },
      { label: 'Participantes', value: (row) => shiftCrewLabel(row, crew) },
      { label: 'Estado', value: (row) => shiftStatusText(row.status) },
      { label: 'Tipo de cierre', value: (row) => (correctionFor('shifts', row, 'end_type')
        ? corrected('shifts', row, 'end_type')
        : endTypeText(row.end_type)) },
      { label: 'Entrega', value: (row) => row.handover_confirmed },
      { label: 'Informe de uso', value: (row) => row.usage_report_submitted },
      { label: 'Notas', value: (row) => corrected('shifts', row, 'notes') },
    ])),
    section('Entregas de turno', table(dossier.shift_handovers, [
      { label: 'Fecha', value: (row) => dateTime(row.created_at) },
      { label: 'Turno', value: (row) => shiftText(row.shift_id) },
      { label: 'Material', value: (row) => materialName(row.project_material_id) },
      { label: 'Estado', value: (row) => handoverStatusText(row.status) },
      { label: 'Esperado', value: (row) => row.expected_quantity },
      { label: 'Observado', value: (row) => row.observed_quantity },
      { label: 'Nota', value: (row) => row.note },
      { label: 'Foto', value: (row) => shown(row.photo_path) },
    ])),
    section('Fotos de campo', table(dossier.photos, [
      { label: 'Fecha', value: (row) => dateTime(row.created_at) },
      { label: 'Tipo', value: (row) => evidenceKindText(row.evidence_kind) },
      { label: 'Turno', value: (row) => shiftText(row.shift_id) },
      { label: 'Archivo', value: (row) => row.original_name || row.filename },
      { label: 'Descripción', value: (row) => row.caption },
    ])),
    section('Materiales asignados', table(dossier.materials, [
      { label: 'Material', value: (row) => row.material_name },
      { label: 'Capa', value: (row) => layerText(row.layer) },
      { label: 'Inicial', value: (row) => row.initial_quantity },
      { label: 'Actual', value: (row) => row.current_quantity },
      { label: 'Unidad', value: (row) => row.unit },
      { label: 'Activo', value: (row) => row.active },
      { label: 'Notas', value: (row) => row.notes },
    ])),
    section('Consumo de materiales', table(dossier.consumption, [
      { label: 'Fecha', value: (row) => correctedDate('material_consumption', row, 'date') },
      { label: 'Ingresado por', value: (row) => enteredByLabel(row.operator_id, crew) },
      { label: 'Material', value: (row) => materialName(row.project_material_id || row.material_id) },
      { label: 'Cantidad', value: (row) => corrected('material_consumption', row, 'quantity_used') },
      { label: 'Aproximado', value: (row) => corrected('material_consumption', row, 'approximate') },
      { label: 'Anomalía', value: (row) => row.anomaly_flag ?? row.anomaly },
      { label: 'Notas', value: (row) => corrected('material_consumption', row, 'notes') },
    ])),
    section('Reconciliación de materiales', table(dossier.reconciliations, [
      { label: 'Material', value: (row) => materialName(row.project_material_id) },
      { label: 'Enviado', value: (row) => row.sent_quantity },
      { label: 'Consumido', value: (row) => row.consumed_quantity },
      { label: 'Devuelto', value: (row) => row.returned_quantity },
      { label: 'Faltante', value: (row) => row.missing_quantity },
      { label: 'Notas', value: (row) => row.notes },
    ])),
    section('Muestras de agua', table(dossier.samples, [
      { label: 'Muestra', value: (row) => row.sample_number },
      { label: 'Ingresado por', value: (row) => enteredByLabel(row.operator_id, crew) },
      { label: 'Fecha', value: (row) => correctedDate('water_samples', row, 'taken_at') },
      { label: 'Profundidad (m)', value: (row) => corrected('water_samples', row, 'depth_m') },
      { label: 'Etapa', value: (row) => corrected('water_samples', row, 'stage') },
      { label: 'Foto', value: (row) => shown(row.bottle_photo_path) },
      { label: 'Notas', value: (row) => corrected('water_samples', row, 'notes') },
    ])),
    section('Pedidos de empresa', table(dossier.company_pedidos, [
      { label: 'Pedido', value: (row) => row.pedido_number || `#${valueText(row.id)}` },
      { label: 'Fecha', value: (row) => dateTime(row.created_at) },
      { label: 'Estado', value: (row) => row.status },
      { label: 'Justificación', value: (row) => row.justification },
      { label: 'Cierre manual', value: (row) => row.closed_manually },
    ])),
    section('Ítems de pedidos de empresa', table(pedidoItems, [
      { label: 'Pedido', value: (row) => row.pedido },
      { label: 'Material', value: (row) => row.material_name_snapshot },
      { label: 'Solicitado', value: (row) => row.requested_quantity },
      { label: 'Aprobado', value: (row) => row.approved_quantity },
      { label: 'Recibido', value: (row) => row.received_quantity },
      { label: 'Unidad', value: (row) => row.unit_snapshot },
      { label: 'Estado', value: (row) => itemStateText(row.state) },
      { label: 'Incidente/decisión', value: (row) => row.incident_note || row.decision_reason },
    ])),
    section('Recepciones de pedidos de empresa', table(pedidoReceipts, [
      { label: 'Pedido', value: (row) => row.pedido },
      { label: 'Material', value: (row) => row.material },
      { label: 'Resultado', value: (row) => outcomeText(row.outcome) },
      { label: 'Cantidad', value: (row) => row.quantity_received },
      { label: 'Unidad', value: (row) => row.unit },
      { label: 'Incidente / nota', value: (row) => row.incident_note },
      { label: 'Confirmada', value: (row) => dateTime(row.created_at) },
    ])),
    section('Correcciones administrativas', table(dossier.corrections, [
      { label: 'Fecha', value: (row) => dateTime(row.created_at) },
      { label: 'Registro', value: (row) => entityText(row.entity_type) },
      { label: 'Campo', value: (row) => row.field_name },
      { label: 'Valor original', value: (row) => row.original_value },
      { label: 'Valor corregido', value: (row) => row.corrected_value },
      { label: 'Motivo', value: (row) => row.reason },
    ])),
    section('Discrepancias de la Ficha', table(dossier.discrepancies, [
      { label: 'Fecha', value: (row) => dateTime(row.created_at) },
      { label: 'Sección', value: (row) => row.section },
      { label: 'Descripción', value: (row) => row.description },
      { label: 'Estado', value: (row) => discrepancyStatusText(row.status) },
      { label: 'Resolución', value: (row) => row.resolution_note },
      { label: 'Resuelta', value: (row) => dateTime(row.resolved_at) },
    ])),
    section('Adjuntos', table(dossier.attachments, [
      { label: 'Fecha', value: (row) => dateTime(row.uploaded_at) },
      { label: 'Tipo', value: (row) => row.kind },
      { label: 'Archivo', value: (row) => row.filename },
      { label: 'Notas', value: (row) => row.notes },
    ])),
    section('Ficha técnica final', detailGrid(effectiveCompletion, completionLabels)),
    section('Esquema de entubado', table(casing, [
      { label: 'Orden', value: (row) => row.order },
      { label: 'Tipo', value: (row) => row.type },
      { label: 'Metros', value: (row) => row.meters },
      { label: 'Diámetro', value: (row) => row.diameter },
      { label: 'Notas', value: (row) => row.notes },
    ])),
    section('Firmas', `
      <dl class="details signatures">
        <div><dt>Operador</dt><dd>${escapeHtml(valueText(completion.operator_signature || report.operator_signature))}</dd></div>
        <div><dt>Cliente</dt><dd>${escapeHtml(valueText(completion.client_signature || report.client_signature))}</dd></div>
        <div><dt>Administración</dt><dd>${escapeHtml(valueText(completion.admin_signature || report.admin_signature))}</dd></div>
        <div><dt>Fecha de firma administrativa</dt><dd>${escapeHtml(dateTime(completion.finalized_at || report.finalized_at))}</dd></div>
      </dl>`),
    section('Historial auditable', table(dossier.audit, [
      { label: 'Fecha', value: (row) => dateTime(row.created_at) },
      { label: 'Acción', value: (row) => auditActionText(row.action) },
      { label: 'Registro', value: (row) => entityText(row.entity_type) },
      { label: 'Usuario', value: (row) => (row.actor_id
        ? (crew.names.get(String(row.actor_id)) ?? (row.actor_id === report.operator_id ? operatorName : 'Operador desconocido'))
        : 'Sistema') },
      { label: 'Motivo', value: (row) => row.reason },
    ])),
  ].join('');

  return `<!doctype html>
<html lang="es-PY">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dossier ${escapeHtml(projectName)}</title>
  <style>
    @page { size: A4; margin: 15mm; }
    * { box-sizing: border-box; }
    body { color: #172033; font: 10.5pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
    header { border-bottom: 3px solid #1e56a8; margin-bottom: 18px; padding-bottom: 12px; }
    h1 { font-size: 22pt; margin: 0 0 4px; }
    h2 { color: #153f78; font-size: 14pt; margin: 0 0 9px; }
    .meta, .empty { color: #536074; }
    section { break-inside: auto; margin: 0 0 20px; }
    table { border-collapse: collapse; font-size: 8.6pt; width: 100%; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th, td { border: 1px solid #cbd2dc; padding: 5px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #edf3fb; color: #153f78; }
    .details { display: grid; gap: 1px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; }
    .details > div { border: 1px solid #d8dee8; break-inside: avoid; padding: 7px; }
    .details dt { color: #536074; font-size: 8pt; font-weight: 700; text-transform: uppercase; }
    .details dd { margin: 2px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .summary dd { font-size: 15pt; font-weight: 800; }
    .signatures dd { min-height: 24px; }
    footer { border-top: 1px solid #cbd2dc; color: #697386; font-size: 8pt; margin-top: 24px; padding-top: 8px; }
    @media print { button { display: none !important; } }
  </style>
</head>
<body>
  <header>
    <h1>Dossier técnico del pozo</h1>
    <div><strong>${escapeHtml(projectName)}</strong></div>
    <div class="meta">Ficha #${escapeHtml(report.id)} · Operador: ${escapeHtml(operatorName)} · Generado: ${escapeHtml(dateTime(generatedAt.toISOString()))}</div>
  </header>
  ${blocks}
  <footer>Documento compilado desde el historial operativo auditable de PHC. Los archivos privados requieren autorización para abrirse.</footer>
</body>
</html>`;
};

export const printDossier = (
  report: CompletionReport,
  dossier: ProjectDossier,
  crew: DossierCrew = EMPTY_DOSSIER_CREW,
): boolean => {
  const printWindow = window.open('about:blank', '_blank');
  if (!printWindow) return false;
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(buildPrintableDossierHtml(report, dossier, new Date(), crew));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 250);
  return true;
};
