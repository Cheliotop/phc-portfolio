/**
 * How refused field work reads in the admin review list. Keep this in step with
 * PHC_Web_Admin/src/domain/rejectedWork.ts.
 */
const LABELS: Record<string, string> = {
  drilling_bar: 'Barra de perforación',
  water_sample: 'Muestra de agua',
  shift_start: 'Inicio de turno',
  shift_handover: 'Traspaso de turno',
  shift_end: 'Cierre de turno',
  shift_auto_close: 'Cierre automático de turno',
  pedido_v2: 'Pedido',
  pedido_receipt: 'Recepción de pedido',
  completion_v2: 'Ficha técnica',
  completion_v2_resubmit: 'Ficha técnica corregida',
  completion_discrepancy: 'Discrepancia de Ficha',
};

export const rejectedWorkLabel = (entity: string): string => LABELS[entity] || entity;

/** The kinds the server can add to the record when accepted. See decide_rejected_work. */
export const addsToRecord = (entity: string): boolean =>
  entity === 'drilling_bar' || entity === 'water_sample';

/**
 * A refusal's reason, in words the admin can act on (code read W7). The phone stores
 * the server's message with its SQLSTATE, often in English. Known refusals are
 * translated; anything else loses its code and any stack trace but stays as sent.
 */
const KNOWN_REASONS: Array<[RegExp, string]> = [
  [/Access denied to this project/i, 'El operador ya no estaba asignado a este pozo.'],
  [/active authenticated user required/i, 'La cuenta estaba desactivada o sin sesión válida.'],
  [/handover-confirmed shift .*required|Confirm the shift handover/i, 'El turno no tenía el traspaso confirmado.'],
  [/Shift cannot be closed from status closed|closed shifts are immutable/i, 'El turno ya estaba cerrado.'],
  [/outside the shift evidence window/i, 'La hora del registro queda fuera de su turno.'],
  [/SHIFT_REQUIRED/i, 'La app necesitaba un turno iniciado.'],
  [/Idempotency key payload mismatch|idempotency replay does not match/i, 'Ya se había recibido un registro distinto con la misma clave.'],
  [/Project is not active/i, 'El pozo no estaba activo.'],
  [/must have its usage report before offline evidence|necesita su informe de consumo antes de reenviar barras/i, 'El turno ya estaba cerrado sin informe.'],
  [/cannot be added after Ficha submission|barras sin conexión después de enviar la Ficha/i, 'La Ficha del pozo ya se había enviado.'],
  [/new row violates row-level security/i, 'El servidor no permitió el registro para esta cuenta.'],
];

export const rejectionReasonText = (raw: string | null | undefined): string => {
  if (!raw || !raw.trim()) return 'No indicado';
  for (const [pattern, text] of KNOWN_REASONS) {
    if (pattern.test(raw)) return text;
  }
  return raw
    .split(/\n\s*at\s/)[0]
    .replace(/^[A-Za-z]*Error:\s+/, '')
    .replace(/\s*\((?:[0-9A-Z]{5}|PGRST\d+)\)\s*$/, '')
    .trim() || 'No indicado';
};

/** `2026-11-07T13:05:00.000Z` as `07/11/2026 10:05`, local time; other text as is. */
const localDateTime = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const present = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

/** The few facts an admin needs to recognise the work, in plain words. */
export const rejectedWorkDetails = (payload: any): string[] => {
  if (!payload || typeof payload !== 'object') return [];
  const details = [
    present(payload.soil_type) ? `Suelo: ${payload.soil_type}` : null,
    present(payload.length) ? `Longitud: ${payload.length} m` : null,
    present(payload.start_time) ? `Horario: ${payload.start_time} a ${payload.end_time ?? '—'}` : null,
    present(payload.water_level) ? `Nivel de agua: ${payload.water_level} m` : null,
    present(payload.depthM) ? `Profundidad: ${payload.depthM} m` : null,
    present(payload.stage) ? `Etapa: ${payload.stage}` : null,
    present(payload.startedAt) ? `Inicio: ${localDateTime(payload.startedAt)}` : null,
    Array.isArray(payload.items) ? `Ítems: ${payload.items.length}` : null,
    Array.isArray(payload.usage) ? `Materiales informados: ${payload.usage.length}` : null,
    present(payload.notes) ? `Notas: ${payload.notes}` : null,
    present(payload.justification) ? `Justificación: ${payload.justification}` : null,
  ];
  return details.filter((detail): detail is string => detail !== null);
};

/** Shown when the reporting phone later got the work through (code read S8). */
export const SENT_LATER_TEXT =
  'Llegó al servidor después, cuando el dispositivo lo reintentó. No hace falta cargarlo a mano: aceptalo con una nota.';
