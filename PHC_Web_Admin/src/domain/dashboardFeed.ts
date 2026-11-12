// Dashboard well badges and feed labels (WEB-17). Kept free of imports so the node tests load it directly.

// A closed shift is resolved: its auto-close or missing report no longer needs action.
export const unresolvedLateShifts = <T extends { status?: string | null; end_type?: string | null }>(shifts: T[]): T[] =>
  shifts
    .filter((shift) => shift.status !== 'closed')
    .filter((shift) => shift.status === 'report_pending' || shift.end_type === 'auto');

// Pedido statuses in words; an unknown status still prints as itself.
export const PEDIDO_STATUS_ES: Record<string, string> = {
  submitted: 'Enviado', pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado',
  received: 'Recibido', cancelled: 'Cancelado', closed: 'Cerrado',
};
export const pedidoStatusLabel = (status: unknown): string => {
  if (status == null || status === '') return '—';
  return PEDIDO_STATUS_ES[String(status)] || String(status);
};

// A returned Ficha reads "Devuelta", not "Pendiente de firma" (WEB-17).
export const cierreFeedLabel = (completion: { status?: string | null; admin_signature?: unknown }): string => {
  if (completion.admin_signature) return 'Firmado';
  if (completion.status === 'returned') return 'Devuelta al operador';
  return 'Pendiente de firma';
};
