import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import type { PedidoV2 } from '../types/productV2';
import { formatDisplayDate, formatDisplayDateTime } from './dateFormat';
import { escapeHtml } from './escapeHtml';
import { statusLabel } from '../domain/projectStatus';

const date = (value: unknown) => (value ? formatDisplayDate(String(value)) : '—');

const page = (title: string, subtitle: string, headings: string[], rows: unknown[][]) => `<!doctype html>
<html lang="es-PY"><head><meta charset="utf-8"><style>
@page{size:A4 landscape;margin:13mm}*{box-sizing:border-box}body{font:9pt/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;margin:0}header{border-bottom:3px solid #1e56a8;margin-bottom:16px;padding-bottom:10px}h1{font-size:20pt;margin:0}.meta{color:#536074}table{width:100%;border-collapse:collapse}thead{display:table-header-group}tr{break-inside:avoid}th,td{border:1px solid #cbd2dc;padding:5px;text-align:left;vertical-align:top}th{background:#edf3fb;color:#153f78}
</style></head><body><header><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(subtitle)} · ${escapeHtml(formatDisplayDateTime(new Date().toISOString()))}</div></header><table><thead><tr>${headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;

const print = async (html: string) => {
  const result = await Print.printToFileAsync({ html, base64: false });
  return result.uri;
};

export const exportProjectsListPdf = (projects: Record<string, any>[]) => print(page(
  'Listado de proyectos PHC',
  `${projects.length} proyecto(s)`,
  ['ID', 'Proyecto/pozo', 'Ubicación', 'Cliente', 'Estado', 'Progreso', 'Objetivo', 'Inicio', 'Fin'],
  projects.map((project) => [
    project.id,
    project.well_name || project.name,
    project.location || '—',
    project.client || '—',
    statusLabel(project.status),
    `${project.progress_percentage ?? project.progress ?? 0}%`,
    project.target_depth ?? '—',
    date(project.start_date || project.created_at),
    date(project.end_date),
  ]),
));

export const exportPedidosListPdf = (pedidos: PedidoV2[]) => {
  const rows = pedidos.flatMap((pedido) => (pedido.pedido_items || []).map((item) => [
    pedido.pedido_number || pedido.id,
    pedido.projects?.name || pedido.project_id,
    pedido.profiles?.full_name || pedido.profiles?.username || '—',
    pedido.kind === 'personal' ? 'Personal' : 'Empresa',
    pedido.priority,
    item.material_name_snapshot,
    `${item.requested_quantity} ${item.unit_snapshot}`,
    item.approved_quantity ?? '—',
    item.received_quantity,
    ({ solicitado: 'Solicitado', aprobado: 'Aprobado', rechazado: 'Rechazado', parcial: 'Entrega parcial', recibido: 'Recibido', no_recibido: 'No recibido', cerrado: 'Cerrado' } as Record<string, string>)[item.state] || item.state,
    date(pedido.created_at),
  ]));
  return print(page(
    'Listado de pedidos PHC',
    `${pedidos.length} pedido(s) · ${rows.length} ítem(s)`,
    ['Pedido', 'Proyecto', 'Operador', 'Tipo', 'Prioridad', 'Material', 'Solicitado', 'Aprobado', 'Recibido', 'Estado', 'Fecha'],
    rows,
  ));
};

export const sharePdfFile = async (fileUri: string) => {
  if (!await Sharing.isAvailableAsync()) {
    throw new Error('Sharing not available on this device');
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/pdf',
    dialogTitle: 'Exportar PDF',
  });
};
