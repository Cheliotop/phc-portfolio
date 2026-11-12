import { errorMessage, operatorErrorText } from '../utils/errorMessage';

/**
 * Admin-screen error text.
 *
 * Every admin error goes through here before it reaches a sheet or a banner.
 * The shared `errorMessage` keeps the raw server text (English, SQLSTATE codes,
 * GoTrue wording) for diagnosis; the admin must read Spanish with vos forms.
 *
 * Known refusals get their own sentence. Anything else is shown only when it
 * already reads as Spanish. Raw English or an unknown technical message becomes
 * the generic fallback, so no SQLSTATE or English server text reaches the admin.
 */

export const ADMIN_GENERIC_ERROR = 'No se pudo completar la acción. Probá de nuevo.';

// Order matters: the most specific patterns first.
const KNOWN_REFUSALS: Array<[RegExp, string]> = [
  [
    /catalog_materials_normalized_name_uidx|normalized_name\)=\([^)]*\)\s+already exists/i,
    'Ya existe un material con ese nombre.',
  ],
  [
    /completed project core data is immutable/i,
    'Este pozo está completado: sus datos ya no se pueden modificar.',
  ],
  [
    /reconcile every flagged shift handover/i,
    'Revisá y resolvé las entregas de turno marcadas antes de firmar.',
  ],
  [
    /a user with this email address has already been registered/i,
    'Ya existe un operador con ese usuario.',
  ],
  [
    /database error saving new user/i,
    'No se pudo crear el operador: ese usuario ya está en uso.',
  ],
  [
    /tiene registros asociados/i,
    'Ese operador tiene registros asociados y no se puede eliminar. Revisá si es operador de cierre de algún pozo (Proyectos → Editar). Si ya trabajó, usá Desactivar.',
  ],
  [
    /duplicate key|unique constraint|\b23505\b/i,
    'Ya existe un registro igual. Revisá los datos y probá de nuevo.',
  ],
];

// Server sentences that are written with tú. Rewritten to vos here, because the
// server messages cannot change in this client-only pass.
const VOSEO: Array<[RegExp, string]> = [
  [/Completa o actualiza/g, 'Completá o actualizá'],
  [/Resolve las discrepancias/g, 'Resolvé las discrepancias'],
  [/ajusta el total/g, 'ajustá el total'],
];

const ENGLISH_HINT = /\b(violates|constraint|duplicate|already exists|not found|invalid|denied|permission|failed|the|every|must|cannot|null value)\b|key \(/i;

export const adminErrorText = (error: unknown, fallback: string = ADMIN_GENERIC_ERROR): string => {
  const raw = error == null ? '' : errorMessage(error);
  for (const [pattern, text] of KNOWN_REFUSALS) {
    if (pattern.test(raw)) return text;
  }
  const cleaned = operatorErrorText(raw).replace(/\s*\([0-9A-Z]{5}\)/g, '').trim();
  if (!cleaned) return fallback;
  if (cleaned === 'Sin conexión con el servidor.') return cleaned;
  let spanish = cleaned;
  for (const [pattern, replacement] of VOSEO) spanish = spanish.replace(pattern, replacement);
  if (ENGLISH_HINT.test(spanish)) return fallback;
  return spanish;
};
