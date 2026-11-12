import { statusLabel } from '../domain/projectStatus';
import { formatDisplayDate } from './dateFormat';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

export interface ExportColumn {
  key: string;
  label: string;
  format?: (value: any) => string;
}

const escapeCsvCell = (value: unknown): string => {
  const text = String(value ?? '');
  const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safeText)
    ? `"${safeText.replace(/"/g, '""')}"`
    : safeText;
};

export const buildCsv = (
  data: Record<string, any>[],
  columns: ExportColumn[],
): string => {
  if (data.length === 0) {
    throw new Error('No data to export');
  }

  const headerRow = columns.map((column) => escapeCsvCell(column.label)).join(',');
  const rows = data.map((row) => columns.map((column) => {
    const raw = row[column.key];
    return escapeCsvCell(column.format ? column.format(raw) : raw);
  }).join(','));

  // UTF-8 BOM lets Excel on Windows recognize Spanish accents reliably.
  return `\uFEFF${[headerRow, ...rows].join('\n')}`;
};

export const exportToCsv = async (
  data: Record<string, any>[],
  columns: ExportColumn[],
  filename: string
): Promise<string> => {
  const csvContent = buildCsv(data, columns);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fullFilename = `${filename}_${timestamp}.csv`;
  const fileUri = `${FileSystem.documentDirectory}${fullFilename}`;

  await FileSystem.writeAsStringAsync(fileUri, csvContent);

  return fileUri;
};

export const shareCsvFile = async (fileUri: string): Promise<void> => {
  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Sharing not available on this device');
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'text/csv',
    dialogTitle: 'Compartir exportación',
  });
};

export const exportAndShare = async (
  data: Record<string, any>[],
  columns: ExportColumn[],
  filename: string
): Promise<void> => {
  const fileUri = await exportToCsv(data, columns, filename);
  await shareCsvFile(fileUri);
};

// ============================================
// Predefined Export Functions
// ============================================

const day = (v: any) => formatDisplayDate(v ? String(v) : null);

// Spanish headers, the server's progress column, and the status in words. The
// progress came out as "undefined%" on every row, and the operator column was
// always empty (code read A7).
export const exportProjectsToCsv = async (projects: any[]): Promise<string> => {
  const columns: ExportColumn[] = [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Nombre' },
    { key: 'well_name', label: 'Pozo' },
    { key: 'client', label: 'Cliente' },
    { key: 'location', label: 'Ubicación' },
    { key: 'status', label: 'Estado', format: (v) => statusLabel(v) },
    { key: 'progress_percentage', label: 'Progreso %', format: (v) => `${v ?? 0}%` },
    { key: 'target_depth', label: 'Profundidad objetivo' },
    { key: 'created_at', label: 'Creado', format: day },
  ];
  return exportToCsv(projects, columns, 'PHC_Proyectos');
};

const ITEM_STATE_ES: Record<string, string> = {
  solicitado: 'Solicitado', aprobado: 'Aprobado', rechazado: 'Rechazado', parcial: 'Entrega parcial',
  recibido: 'Recibido', no_recibido: 'No recibido', cerrado: 'Cerrado',
};

/** One row per item, with its own unit; a pedido's quantity summed items across units. */
export const exportSupplyRequestsToCsv = async (requests: any[]): Promise<string> => {
  const rows = requests.flatMap((pedido) => (pedido.pedido_items || []).map((item: any) => ({
    pedido: pedido.pedido_number || pedido.id,
    project_name: pedido.projects?.name || '',
    operator_name: pedido.profiles?.full_name || pedido.profiles?.username || '',
    kind: pedido.kind === 'personal' ? 'Personal' : 'Empresa',
    priority: pedido.priority,
    material: item.material_name_snapshot,
    requested: item.requested_quantity,
    unit: item.unit_snapshot,
    approved: item.approved_quantity,
    received: item.received_quantity,
    state: ITEM_STATE_ES[item.state] || item.state,
    created_at: pedido.created_at,
  })));
  const columns: ExportColumn[] = [
    { key: 'pedido', label: 'Pedido' },
    { key: 'project_name', label: 'Proyecto' },
    { key: 'operator_name', label: 'Operador' },
    { key: 'kind', label: 'Tipo' },
    { key: 'priority', label: 'Prioridad' },
    { key: 'material', label: 'Material' },
    { key: 'requested', label: 'Solicitado' },
    { key: 'unit', label: 'Unidad' },
    { key: 'approved', label: 'Aprobado' },
    { key: 'received', label: 'Recibido' },
    { key: 'state', label: 'Estado' },
    { key: 'created_at', label: 'Creado', format: day },
  ];
  return exportToCsv(rows, columns, 'PHC_Pedidos');
};
