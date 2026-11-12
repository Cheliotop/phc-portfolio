// Operación → "Cerrar turno": the admin states the real end time of a shift the
// operator could not close (decided 2026-11-09). The time is typed as local time in
// Paraguay (America/Asuncion, UTC-3 all year) and sent as an ISO instant.
export const MAX_FORCE_CLOSE_HOURS = 12;

const ASUNCION_OFFSET = '-03:00';
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const ASUNCION_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Asuncion',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// The value a <input type="datetime-local"> expects, for an instant, in Paraguay time.
export const asuncionLocalInput = (instant: Date): string => {
  const parts = ASUNCION_PARTS.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
};

export type ForceCloseEnd =
  | { ok: true; endedAtIso: string }
  | { ok: false; error: string };

export const validateForceCloseEnd = (startedAtIso: string, localValue: string, now: Date = new Date()): ForceCloseEnd => {
  const match = LOCAL_PATTERN.exec(localValue.trim());
  if (!match) return { ok: false, error: 'Indicá la hora real de fin.' };
  const endMs = Date.parse(`${localValue.trim()}:00${ASUNCION_OFFSET}`);
  const startMs = Date.parse(startedAtIso);
  if (!Number.isFinite(endMs)) return { ok: false, error: 'La hora de fin no es válida.' };
  if (!Number.isFinite(startMs)) return { ok: false, error: 'No se pudo leer la hora de inicio del turno.' };
  if (endMs < startMs) return { ok: false, error: 'La hora de fin no puede ser anterior al inicio del turno.' };
  if (endMs > now.getTime()) return { ok: false, error: 'La hora de fin no puede ser posterior a ahora.' };
  if (endMs - startMs > MAX_FORCE_CLOSE_HOURS * 36e5) {
    return { ok: false, error: `El turno no puede durar más de ${MAX_FORCE_CLOSE_HOURS} h. Revisá la hora de fin.` };
  }
  return { ok: true, endedAtIso: new Date(endMs).toISOString() };
};
