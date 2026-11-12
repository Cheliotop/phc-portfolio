// Browser-side CSV download — parity with the mobile admin Export button.
// Produces a UTF-8 BOM so Excel on Windows opens Spanish accents correctly.

export interface ExportColumn {
  key: string;
  label: string;
  format?: (value: any, row?: Record<string, any>) => string;
}

const escapeCell = (value: string): string => {
  // Excel and similar spreadsheet apps may execute user-controlled cells as
  // formulas. Preserve the visible text while forcing formula-like prefixes to
  // remain data (project names, locations, reasons, etc. are user input).
  const safeValue = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safeValue)) {
    return `"${safeValue.replace(/"/g, '""')}"`;
  }
  return safeValue;
};

const cell = (value: any, format?: (value: any, row?: Record<string, any>) => string, row?: Record<string, any>): string => {
  if (format) return escapeCell(String(format(value, row) ?? ''));
  if (value == null) return '';
  return escapeCell(String(value));
};

export const buildCsv = (
  data: Record<string, any>[],
  columns: ExportColumn[],
): string => {
  if (data.length === 0) {
    throw new Error('No hay datos para exportar');
  }
  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const rows = data.map((row) =>
    columns.map((col) => cell(row[col.key], col.format, row)).join(',')
  );
  return [header, ...rows].join('\n');
};

export const downloadCsv = (csvContent: string, filenameBase: string) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${filenameBase}_${timestamp}.csv`;
  // BOM helps Excel recognize UTF-8
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const formatDate = (v: any) => {
  if (!v) return '';
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) return String(v);
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
};

/**
 * Stored codes in words, for files that may reach the client (code read W4). Kept
 * here, without imports, because the node tests load this file directly.
 */
export const PROJECT_STATUS_ES: Record<string, string> = {
  planning: 'En planificación', active: 'Activo', closure_submitted: 'Cierre enviado',
  completed: 'Completado', paused: 'Pausado', cancelled: 'Cancelado',
};
export const ITEM_STATE_ES: Record<string, string> = {
  solicitado: 'Solicitado', aprobado: 'Aprobado', rechazado: 'Rechazado', parcial: 'Entrega parcial',
  recibido: 'Recibido', no_recibido: 'No recibido', cerrado: 'Cerrado',
};
export const PEDIDO_KIND_ES: Record<string, string> = { empresa: 'Empresa', personal: 'Personal' };
const inWords = (labels: Record<string, string>) => (value: unknown) =>
  (typeof value === 'string' && labels[value]) || (value == null ? '' : String(value));

// Projects carry no current depth, and the operator is only an id, so neither is
// exported; the client column is (code read W4).
export const exportProjectsCsv = (projects: any[]) => {
  const columns: ExportColumn[] = [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Nombre' },
    { key: 'well_name', label: 'Pozo' },
    { key: 'client', label: 'Cliente' },
    { key: 'location', label: 'Ubicación' },
    { key: 'status', label: 'Estado', format: inWords(PROJECT_STATUS_ES) },
    { key: 'progress_percentage', label: 'Progreso %', format: (v) => (v != null ? `${v}%` : '') },
    { key: 'target_depth', label: 'Profundidad objetivo' },
    { key: 'created_at', label: 'Creado', format: formatDate },
  ];
  downloadCsv(buildCsv(projects, columns), 'PHC_Proyectos');
};

/**
 * One row per item. A pedido's own "quantity" added up every item whatever its unit
 * (100 m and 20 bolsas made 120), and "material" named only the first item.
 */
export const pedidoItemRows = (pedidos: any[]) => pedidos.flatMap((pedido) => (pedido.pedido_items || []).map((item: any) => ({
  pedido: pedido.pedido_number || pedido.id,
  project_name: pedido.projects?.name || '',
  operator_name: pedido.profiles?.full_name || pedido.profiles?.username || '',
  kind: pedido.kind,
  priority: pedido.priority,
  material: item.material_name_snapshot,
  requested: item.requested_quantity,
  unit: item.unit_snapshot,
  approved: item.approved_quantity,
  received: item.received_quantity,
  state: item.state,
  justification: pedido.justification,
  created_at: pedido.created_at,
})));

export const exportPedidosCsv = (pedidos: any[]) => {
  const columns: ExportColumn[] = [
    { key: 'pedido', label: 'Pedido' },
    { key: 'project_name', label: 'Proyecto' },
    { key: 'operator_name', label: 'Operador' },
    { key: 'kind', label: 'Tipo', format: inWords(PEDIDO_KIND_ES) },
    { key: 'priority', label: 'Prioridad' },
    { key: 'material', label: 'Material' },
    { key: 'requested', label: 'Solicitado' },
    { key: 'unit', label: 'Unidad' },
    { key: 'approved', label: 'Aprobado' },
    { key: 'received', label: 'Recibido' },
    { key: 'state', label: 'Estado', format: inWords(ITEM_STATE_ES) },
    { key: 'justification', label: 'Justificación' },
    { key: 'created_at', label: 'Creado', format: formatDate },
  ];
  downloadCsv(buildCsv(pedidoItemRows(pedidos), columns), 'PHC_Pedidos');
};
