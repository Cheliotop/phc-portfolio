/**
 * Pure time helpers for field-shift entry. Extracted from ProgresoTab in Pass 5
 * so the overnight-duration logic is unit-testable without rendering.
 */
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export const isValidTime = (value: string): boolean => TIME_RE.test((value || '').trim());

/**
 * Duration in minutes between two HH:MM times. Overnight shifts are valid: if
 * the end is not after the start, it's treated as the next day
 * (e.g. 22:00 -> 02:00 = 240). Equal start/end is invalid (returns null), as
 * are malformed times.
 */
export const calculateDuration = (startTime: string, endTime: string): number | null => {
  if (!isValidTime(startTime) || !isValidTime(endTime)) {
    return null;
  }
  const start = new Date(`2000-01-01T${startTime}:00`);
  const end = new Date(`2000-01-01T${endTime}:00`);
  let minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (minutes < 0) {
    minutes += 24 * 60; // crossed midnight
  }
  return minutes > 0 ? minutes : null;
};
