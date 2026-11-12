import { parseParaguayanNumber } from './paraguayNumber.ts';

// Typed correction values (audit WEB-8). Each field has one input kind; the value
// that reaches record_admin_correction is a real number, boolean, ISO date/time,
// JSON or text, never a string that only looks like one.
export type CorrectionEntity = 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports';
export type FieldKind = 'number' | 'integer' | 'date' | 'datetime' | 'boolean' | 'text' | 'json';

// Field lists follow the server allow-list of record_admin_correction. Key order is
// the order the form offers them; the first one is the default.
const FIELD_KINDS: Record<CorrectionEntity, Record<string, FieldKind>> = {
  drilling_bars: {
    depth_start: 'number', depth_end: 'number', length: 'number', diameter: 'text', soil_type: 'text',
    start_time: 'text', end_time: 'text', duration_minutes: 'number', water_level: 'number', notes: 'text',
  },
  shifts: { started_at: 'datetime', ended_at: 'datetime', end_type: 'text', notes: 'text' },
  material_consumption: { quantity_used: 'number', unit: 'text', date: 'date', notes: 'text', approximate: 'boolean' },
  water_samples: { sample_number: 'integer', depth_m: 'number', stage: 'text', notes: 'text', taken_at: 'datetime' },
  completion_reports: {
    static_level: 'number', dynamic_level: 'number', flow_rate: 'number', specific_flow_rate: 'number',
    maximum_flow_rate: 'number', pump_depth_m: 'number', exploration_depth_m: 'number', widening_depth_m: 'number',
    casing_total_m: 'number', casing_above_ground_m: 'number', blind_casing_m: 'number', filter_casing_m: 'number',
    sediment_trap_m: 'number', centralizer_count: 'integer', bottom_plug_details: 'text', bentonite_quantity: 'number',
    gravel_quantity: 'number', casing_layout: 'json', compressor_hours: 'number', pump_hours: 'number',
    water_quality: 'text', completion_notes: 'text',
  },
};

export const correctionFields = (entity: CorrectionEntity): string[] => Object.keys(FIELD_KINDS[entity]);

export const fieldKind = (entity: CorrectionEntity, field: string): FieldKind => FIELD_KINDS[entity][field] ?? 'text';

export const correctionPlaceholder = (kind: FieldKind): string => {
  switch (kind) {
    case 'number': return 'Ej: 2,5';
    case 'integer': return 'Ej: 3';
    case 'date': return 'Ej: 08/11/2026';
    case 'datetime': return 'Ej: 08/11/2026 14:00';
    case 'boolean': return 'Sí o No';
    case 'json': return 'JSON, ej: [{"tipo":"PVC"}]';
    default: return 'Texto';
  }
};

export type TypedCorrectionValue =
  | { ok: true; value: unknown; display: string }
  | { ok: false; error: string };

const ok = (value: unknown, display: string): TypedCorrectionValue => ({ ok: true, value, display });
const fail = (error: string): TypedCorrectionValue => ({ ok: false, error });

const pad = (value: number) => String(value).padStart(2, '0');

const isRealDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DATETIME_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/;

// Paraguay is UTC-3 all year (no daylight saving since 2024), so typed local times
// are stored with that fixed offset.
const ASUNCION_OFFSET = '-03:00';

const parseNumberKind = (kind: 'number' | 'integer', text: string): TypedCorrectionValue => {
  const parsed = parseParaguayanNumber(text);
  if (parsed.kind === 'ambiguous') {
    return fail(`«${text}» puede ser ${parsed.asThousands} o ${String(parsed.asDecimal).replace('.', ',')}. Escribilo con coma decimal (por ejemplo ${String(parsed.asDecimal).replace('.', ',')}) o sin separador de miles.`);
  }
  if (parsed.kind === 'invalid') return fail('Ingresá un número, por ejemplo 2,5.');
  if (kind === 'integer' && !Number.isInteger(parsed.value)) return fail('Ingresá un número entero.');
  return ok(parsed.value, String(parsed.value).replace('.', ','));
};

export const parseCorrectionValue = (entity: CorrectionEntity, field: string, raw: string): TypedCorrectionValue => {
  const kind = fieldKind(entity, field);
  const text = raw.trim();
  if (!text) return fail('Escribí el valor corregido.');
  if (kind === 'number' || kind === 'integer') return parseNumberKind(kind, text);
  if (kind === 'boolean') {
    const normalized = text.toLocaleLowerCase('es');
    if (normalized === 'sí' || normalized === 'si') return ok(true, 'Sí');
    if (normalized === 'no') return ok(false, 'No');
    return fail('Respondé Sí o No.');
  }
  if (kind === 'date') {
    const match = DATE_PATTERN.exec(text);
    if (!match) return fail('Ingresá la fecha como DD/MM/AAAA, por ejemplo 08/11/2026.');
    const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!isRealDate(year, month, day)) return fail('Esa fecha no existe. Revisá el día y el mes.');
    return ok(`${year}-${pad(month)}-${pad(day)}`, `${pad(day)}/${pad(month)}/${year}`);
  }
  if (kind === 'datetime') {
    const match = DATETIME_PATTERN.exec(text);
    if (!match) return fail('Ingresá fecha y hora como DD/MM/AAAA HH:MM, por ejemplo 08/11/2026 14:00.');
    const [day, month, year, hour, minute] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])];
    if (!isRealDate(year, month, day)) return fail('Esa fecha no existe. Revisá el día y el mes.');
    if (hour > 23 || minute > 59) return fail('La hora no es válida. Usá HH:MM entre 00:00 y 23:59.');
    const display = `${pad(day)}/${pad(month)}/${year} ${pad(hour)}:${pad(minute)}`;
    return ok(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${ASUNCION_OFFSET}`, display);
  }
  if (kind === 'json') {
    try {
      const parsed = JSON.parse(text) as unknown;
      return ok(parsed, JSON.stringify(parsed));
    } catch {
      return fail('Ese JSON no es válido. Revisá comas, comillas y corchetes.');
    }
  }
  return ok(text, text);
};
