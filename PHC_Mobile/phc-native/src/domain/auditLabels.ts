/**
 * Spanish names for the things the audit trail talks about.
 *
 * The audit trigger writes `action` as `table_name || '.' || lower(TG_OP)` and
 * `entity_type` as the raw table name, so the history screen was rendering
 * "shifts · insert" and "completion_reports" to a Paraguayan administrator.
 * Splitting on underscores — which is all the old `humanize()` did — turns
 * `snake_case` into words but never into Spanish.
 *
 * Every lookup falls back to the humanised raw value rather than throwing or
 * rendering blank. A table added to the database later shows up as readable
 * English until it is named here, which is worse than Spanish and much better
 * than an empty row in an append-only record.
 */

/** Grammatical gender, so the verb agrees: "Foto creada", "Turno creado". */
interface EntityLabel {
  label: string;
  feminine?: boolean;
}

const ENTITY_LABELS: Record<string, EntityLabel> = {
  projects: { label: 'Proyecto' },
  project_closing_assignments: { label: 'Asignación de cierre', feminine: true },
  project_secondary_operators: { label: 'Operador 2 del equipo' },
  shifts: { label: 'Turno' },
  shift_handovers: { label: 'Entrega de turno', feminine: true },
  drilling_bars: { label: 'Barra de perforación', feminine: true },
  catalog_materials: { label: 'Material del catálogo' },
  catalog_variants: { label: 'Variante de material', feminine: true },
  project_materials: { label: 'Material del pozo' },
  material_consumption: { label: 'Consumo de material' },
  material_reconciliations: { label: 'Reconciliación de materiales', feminine: true },
  pedidos: { label: 'Pedido' },
  pedido_items: { label: 'Ítem de pedido' },
  pedido_receipts: { label: 'Recepción de pedido', feminine: true },
  completion_reports: { label: 'Ficha técnica', feminine: true },
  completion_discrepancies: { label: 'Discrepancia de cierre', feminine: true },
  water_samples: { label: 'Muestra de agua', feminine: true },
  project_attachments: { label: 'Adjunto del proyecto' },
  photos: { label: 'Foto', feminine: true },
  profiles: { label: 'Usuario' },
  client_errors: { label: 'Reporte de error' },
};

/** Past participles, masculine and feminine. */
const OPERATION_LABELS: Record<string, [string, string]> = {
  insert: ['creado', 'creada'],
  update: ['modificado', 'modificada'],
  delete: ['eliminado', 'eliminada'],
};

/** `snake.case` -> `snake case`, the readable-but-untranslated fallback. */
export const humanizeToken = (value: string): string =>
  value.split('.').join(' · ').split('_').join(' ');

/** "shifts" -> "Turno". Unknown tables degrade to their humanised name. */
export const entityLabel = (entityType?: string | null): string => {
  if (!entityType) return 'Registro';
  return ENTITY_LABELS[entityType]?.label ?? humanizeToken(entityType);
};

/**
 * "shifts.insert" -> "Turno creado"; "photos.delete" -> "Foto eliminada".
 *
 * Falls back progressively: an unknown operation on a known table still names
 * the table, and an entirely unknown action still reads as words.
 */
export const auditActionLabel = (action?: string | null): string => {
  if (!action) return 'Evento';
  if (action === 'shift.force_closed') return 'Turno cerrado por el administrador';

  const separator = action.lastIndexOf('.');
  if (separator === -1) return humanizeToken(action);

  const table = action.slice(0, separator);
  const operation = action.slice(separator + 1).toLowerCase();

  const entity = ENTITY_LABELS[table];
  const noun = entity?.label ?? humanizeToken(table);
  const verbs = OPERATION_LABELS[operation];
  if (!verbs) return `${noun} · ${humanizeToken(operation)}`;

  return `${noun} ${entity?.feminine ? verbs[1] : verbs[0]}`;
};

/**
 * Column names as an administrator would say them. Used by the correction
 * form, where picking the wrong field silently corrects the wrong number.
 */
const FIELD_LABELS: Record<string, string> = {
  depth_start: 'Profundidad inicial',
  depth_end: 'Profundidad final',
  length: 'Longitud',
  diameter: 'Diámetro',
  soil_type: 'Tipo de suelo',
  start_time: 'Hora de inicio',
  end_time: 'Hora de fin',
  duration_minutes: 'Duración (minutos)',
  water_level: 'Nivel de agua',
  notes: 'Notas',
  started_at: 'Inicio del turno',
  ended_at: 'Fin del turno',
  end_type: 'Tipo de cierre',
  quantity_used: 'Cantidad usada',
  unit: 'Unidad',
  date: 'Fecha',
  approximate: 'Aproximado',
  sample_number: 'Número de muestra',
  depth_m: 'Profundidad (m)',
  stage: 'Etapa',
  taken_at: 'Fecha de toma',
  static_level: 'Nivel estático',
  dynamic_level: 'Nivel dinámico',
  flow_rate: 'Caudal',
  specific_flow_rate: 'Caudal específico',
  maximum_flow_rate: 'Caudal máximo',
  pump_depth_m: 'Profundidad de bomba (m)',
  exploration_depth_m: 'Profundidad de exploración (m)',
  widening_depth_m: 'Profundidad de ensanche (m)',
  casing_total_m: 'Entubado total (m)',
  casing_layout: 'Distribución del entubado',
  water_quality: 'Calidad del agua',
  completion_notes: 'Notas de cierre',
};

/** "depth_start" -> "Profundidad inicial". */
export const fieldLabel = (field?: string | null): string => {
  if (!field) return '';
  return FIELD_LABELS[field] ?? humanizeToken(field);
};
