import * as fs from 'fs';
import * as path from 'path';

import { formatDisplayDate, formatDisplayDateTime, storedDateFromToday } from '../src/utils/dateFormat';

describe('formatDisplayDate', () => {
  it('formats valid ISO and SQLite timestamps', () => {
    expect(formatDisplayDate('2026-07-26T12:34:56.000Z')).toBe('26/07/2026');
    expect(formatDisplayDate('2026-07-26 12:34:56')).toBe('26/07/2026');
  });

  it('uses a placeholder for null', () => {
    expect(formatDisplayDate(null)).toBe('—');
  });

  it('uses a placeholder for undefined', () => {
    expect(formatDisplayDate(undefined)).toBe('—');
  });

  it('uses a placeholder for malformed values', () => {
    expect(formatDisplayDate('not-a-date')).toBe('—');
    expect(formatDisplayDate('2026-02-31')).toBe('—');
    expect(formatDisplayDate('2026-07-26Tnot-a-time')).toBe('—');
  });
});

describe('formatDisplayDateTime', () => {
  it('formats a stored timestamp the way Paraguay writes it', () => {
    // The failure mode was "Fri Jul 31 11:50:18 2026" on the operator's shift
    // card, from toLocaleString('es-PY') with no options.
    const formatted = formatDisplayDateTime('2026-07-31T11:50:18.000Z');
    expect(formatted).toMatch(/^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
    expect(formatted).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jul/);
  });

  it('falls back to the date alone when there is no time', () => {
    expect(formatDisplayDateTime('2026-07-31')).toBe('31/07/2026');
  });

  it('uses a placeholder for missing or malformed values', () => {
    expect(formatDisplayDateTime(null)).toBe('—');
    expect(formatDisplayDateTime('not-a-date')).toBe('—');
  });
});

describe('locale formatting is never used directly', () => {
  it('has no bare toLocale call outside the date utility', () => {
    // Without an options argument these fall back to English on this engine.
    // Node formats them correctly, so only a rule like this catches it.
    const src = path.join(__dirname, '..', 'src');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return /\.tsx?$/.test(e.name) && e.name !== 'dateFormat.ts' ? [full] : [];
      });
    const hits: string[] = [];
    for (const file of walk(src)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\.toLocale(String|DateString|TimeString)\(\s*['"][^'"]*['"]\s*\)/.test(code)) {
          hits.push(`  ${path.relative(src, file)}:${i + 1}  use formatDisplayDate/DateTime`);
        }
      });
    }
    expect(hits.length === 0 ? '' : `\n${hits.join('\n')}\n`).toBe('');
  });
});

describe('storedDateFromToday', () => {
  /**
   * The pedido form offers "Hoy / Mañana / En 3 días" instead of asking an
   * operator to type AAAA-MM-DD on a phone. Those buttons resolve through here.
   */
  it('returns todays LOCAL date in storage format', () => {
    const now = new Date();
    const pad = (part: number) => String(part).padStart(2, '0');
    const expected = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(storedDateFromToday()).toBe(expected);
    expect(storedDateFromToday(0)).toBe(expected);
  });

  it('is not UTC — Paraguay evenings would otherwise land on tomorrow', () => {
    // toISOString().slice(0,10) is the obvious implementation and is wrong
    // here: Paraguay is UTC-3/-4, so after 20:00 local it returns the next
    // day. An operator ordering material in the evening would ask for it a day
    // early, every evening, and never in the morning.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-31T23:30:00-03:00'));
    try {
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-08-01');
      expect(storedDateFromToday()).toBe('2026-07-31');
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts days forward and crosses a month boundary', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-30T09:00:00-03:00'));
    try {
      expect(storedDateFromToday(1)).toBe('2026-07-31');
      expect(storedDateFromToday(3)).toBe('2026-08-02');
      expect(storedDateFromToday(7)).toBe('2026-08-06');
    } finally {
      jest.useRealTimers();
    }
  });

  it('produces a value formatDisplayDate can render back', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-30T09:00:00-03:00'));
    try {
      expect(formatDisplayDate(storedDateFromToday(3))).toBe('02/08/2026');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the day an instant fell on, in Paraguay (code read O9)', () => {
  it('shows the local day for a UTC instant after 21:00 local', () => {
    // 01:30 UTC on the 8th is 22:30 on the 7th in Asunción.
    expect(formatDisplayDate('2026-11-08T01:30:00.000Z')).toBe('07/11/2026');
    expect(formatDisplayDate('2026-11-08T01:30:00+00:00')).toBe('07/11/2026');
  });

  it('leaves a bare stored date on its own day', () => {
    expect(formatDisplayDate('2026-11-08')).toBe('08/11/2026');
  });
});
