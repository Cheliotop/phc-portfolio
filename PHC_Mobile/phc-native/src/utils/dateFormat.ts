/**
 * Dates are formatted by hand rather than through `toLocaleString('es-PY')`.
 *
 * That matters more than it looks. With no options argument, the locale
 * formatter falls back to `Date.prototype.toString()` when the engine lacks
 * the locale's patterns, which is English — the operator's shift card read
 * "Fri Jul 31 11:50:18 2026" on a real device, and three of the bare calls
 * were in the PDF generators, so client documents carried English dates. Node
 * formats all of them correctly, so nothing upstream of a handset catches it.
 *
 * Building the string from the matched parts needs no locale data at all, so
 * it cannot regress on a different engine or a device with unusual settings.
 */
const STORED_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

export const formatDisplayDate = (value?: string | null): string => {
  if (!value) {
    return '—';
  }

  const trimmed = value.trim();
  const match = trimmed.match(STORED_DATE_PATTERN);
  if (!match) {
    return '—';
  }

  // An instant with a zone is a moment, not a calendar day: show the local day it
  // fell on. Cut from the string it read tomorrow after about 21:00 in Paraguay
  // (code read O9). A bare date, or a time with no zone, is already local.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) && /[T ]\d{2}:/.test(trimmed)) {
    const instant = new Date(trimmed);
    if (!Number.isNaN(instant.getTime())) {
      const pad = (part: number) => String(part).padStart(2, '0');
      return `${pad(instant.getDate())}/${pad(instant.getMonth() + 1)}/${instant.getFullYear()}`;
    }
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isValidDate = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;

  return isValidDate ? `${match[3]}/${match[2]}/${match[1]}` : '—';
};

/**
 * `AAAA-MM-DD` for today, or a number of days from today — the storage format,
 * built from LOCAL date parts.
 *
 * Deliberately not `toISOString().slice(0, 10)`. That is UTC, and Paraguay is
 * UTC-3/-4: after 20:00 local it returns tomorrow's date, so an operator
 * ordering material in the evening would ask for it a day earlier than they
 * meant, every time, and only in the evening.
 */
export const storedDateFromToday = (daysAhead = 0): string => {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return storedDateOf(date);
};

/** `AAAA-MM-DD` of an instant, in LOCAL time (see storedDateFromToday). */
export const storedDateOf = (value: Date | string): string => {
  const date = typeof value === 'string' ? new Date(value) : value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const STORED_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/**
 * `31/07/2026 11:50` in local time, or the em dash when there is nothing
 * usable. Falls back to the date alone when the value carries no time.
 */
export const formatDisplayDateTime = (value?: string | null): string => {
  if (!value) {
    return '—';
  }

  const trimmed = value.trim();
  if (!STORED_DATE_TIME_PATTERN.test(trimmed)) {
    return formatDisplayDate(trimmed);
  }

  // Times are stored in UTC, so they have to be converted rather than sliced
  // out of the string: Paraguay is UTC-3/-4 and a shift that starts at 08:00
  // local is stored as 11:00 or 12:00.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return formatDisplayDate(trimmed);
  }

  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(parsed.getDate())}/${pad(parsed.getMonth() + 1)}/${parsed.getFullYear()}`
    + ` ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
};
