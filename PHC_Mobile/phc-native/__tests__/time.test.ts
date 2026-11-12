import { isValidTime, calculateDuration } from '../src/utils/time';

describe('time utils', () => {
  describe('isValidTime', () => {
    it('accepts valid HH:MM', () => {
      expect(isValidTime('00:00')).toBe(true);
      expect(isValidTime('9:05')).toBe(true);
      expect(isValidTime('23:59')).toBe(true);
    });
    it('rejects invalid values', () => {
      expect(isValidTime('24:00')).toBe(false);
      expect(isValidTime('12:60')).toBe(false);
      expect(isValidTime('7')).toBe(false);
      expect(isValidTime('')).toBe(false);
      expect(isValidTime('ab:cd')).toBe(false);
    });
  });

  describe('calculateDuration', () => {
    it('computes same-day durations', () => {
      expect(calculateDuration('08:00', '12:00')).toBe(240);
      expect(calculateDuration('08:00', '08:30')).toBe(30);
    });
    it('treats end<=start as an overnight shift', () => {
      expect(calculateDuration('22:00', '02:00')).toBe(240); // the key field case
      expect(calculateDuration('23:30', '00:30')).toBe(60);
    });
    it('rejects equal start/end (zero-length)', () => {
      expect(calculateDuration('08:00', '08:00')).toBeNull();
    });
    it('rejects malformed times', () => {
      expect(calculateDuration('bad', '02:00')).toBeNull();
      expect(calculateDuration('22:00', '')).toBeNull();
    });
  });
});
