import type { PedidoV2 } from '../types/productV2';
import { escapeHtml } from './printableDossier.ts';
import { ITEM_STATE_ES, PEDIDO_KIND_ES, PROJECT_STATUS_ES } from './exportCsv.ts';


const date = (value: unknown) => {
  if (!value) return '—';
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('es-PY');
};

// The print button has no inline handler: the site CSP (script-src 'self') blocks it
// inside the about:blank window. write() attaches the click from the opener (WEB-13).
export const buildPrintableListHtml = (title: string, subtitle: string, headings: string[], rows: unknown[][]) => `<!doctype html>
<html lang="es-PY"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page{size:A4 landscape;margin:13mm}*{box-sizing:border-box}body{font:9pt/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;margin:0}header{border-bottom:3px solid #1e56a8;margin-bottom:16px;padding-bottom:10px}h1{font-size:20pt;margin:0}.meta{color:#536074}table{width:100%;border-collapse:collapse}thead{display:table-header-group}tr{break-inside:avoid}th,td{border:1px solid #cbd2dc;padding:5px;text-align:left;vertical-align:top}th{background:#edf3fb;color:#153f78}button{margin-bottom:12px}@media print{button{display:none}}
</style></head><body><button type="button" id="print-list-button">Imprimir / guardar PDF</button><header><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(subtitle)} · ${escapeHtml(new Date().toLocaleString('es-PY'))}</div></header><table><thead><tr>${headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;

export const writePrintableList = (target: Window, html: string) => {
  target.opener = null;
  target.document.open();
  target.document.write(html);
  target.document.close();
  target.document.getElementById('print-list-button')?.addEventListener('click', () => target.print());
  target.focus();
  window.setTimeout(() => target.print(), 250);
};

export const writeProjectsList = (target: Window, projects: Record<string, any>[]) => {
  writePrintableList(target, buildPrintableListHtml(
    'Listado de proyectos PHC',
    `${projects.length} proyecto(s)`,
    ['ID', 'Proyecto/pozo', 'Ubicación', 'Cliente', 'Estado', 'Progreso', 'Objetivo', 'Inicio', 'Fin'],
    projects.map((project) => [
      project.id,
      project.well_name || project.name,
      project.location || '—',
      project.client || '—',
      PROJECT_STATUS_ES[project.status] || project.status || '—',
      `${project.progress_percentage ?? 0}%`,
      project.target_depth ?? '—',
      date(project.start_date || project.created_at),
      date(project.end_date),
    ]),
  ));
};

export const writePedidosList = (target: Window, pedidos: PedidoV2[]) => {
  const rows = pedidos.flatMap((pedido) => (pedido.pedido_items || []).map((item) => [
    pedido.pedido_number || pedido.id,
    pedido.projects?.name || pedido.project_id,
    pedido.profiles?.full_name || pedido.profiles?.username || '—',
    PEDIDO_KIND_ES[pedido.kind] || pedido.kind,
    pedido.priority,
    item.material_name_snapshot,
    `${item.requested_quantity} ${item.unit_snapshot}`,
    item.approved_quantity ?? '—',
    item.received_quantity,
    ITEM_STATE_ES[item.state] || item.state,
    date(pedido.created_at),
  ]));
  writePrintableList(target, buildPrintableListHtml(
    'Listado de pedidos PHC',
    `${pedidos.length} pedido(s) · ${rows.length} ítem(s)`,
    ['Pedido', 'Proyecto', 'Operador', 'Tipo', 'Prioridad', 'Material', 'Solicitado', 'Aprobado', 'Recibido', 'Estado', 'Fecha'],
    rows,
  ));
};
