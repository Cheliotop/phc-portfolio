/**
 * The 12-hour cutoff runs on the sync side (app foreground and before a drain),
 * not only when Turnos loads. It measures on the device clock, from
 * start_device_time, so a tablet whose clock is off closes the shift at the real
 * 12 hours. The end time is the server's started_at + 12 h, which is what the
 * server and the VERIFY step compare against. Real SQLite stands in for the DB.
 */
const { DatabaseSync } = require('node:sqlite');
import AsyncStorage from '@react-native-async-storage/async-storage';

let mockSqlite: any;

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) =>
    mockSqlite.prepare(sql).get(...params) ?? null;
  return {
    execute,
    query,
    queryFirst,
    openDb: async () => mockSqlite,
    runInTransaction: async (task: (transaction: any) => Promise<any>) => {
      mockSqlite.exec('BEGIN');
      try {
        const result = await task({ execute, query, queryFirst });
        mockSqlite.exec('COMMIT');
        return result;
      } catch (error) {
        mockSqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
});

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { expireOverdueShifts, isPastShiftCutoff, SHIFT_CUTOFF_MS } from '../src/sync/shiftCutoff';

const ANA = 'operator-ana';
const WELL = 7;

const addShift = (
  id: string,
  row: { status?: string; startedAt: string; startDevice: string | null },
) => mockSqlite.prepare(
  `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status,
                       started_at, start_device_time)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(id, id, `entry-${id}`, WELL, ANA, row.status ?? 'open', row.startedAt, row.startDevice);

const autoCloseRows = (shiftId: string) => mockSqlite.prepare(
  `SELECT entity, op, payload_json FROM sync_outbox WHERE entity = 'shift_auto_close' AND entity_id = ?`,
).all(shiftId);

const shiftRow = (id: string) => mockSqlite.prepare(
  `SELECT status, ended_at, end_type, device_time_flag FROM shifts WHERE id = ?`,
).get(id);

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Ana')`).run(ANA);
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (?, 'Pozo 7', ?)`).run(WELL, ANA);
});

afterEach(() => mockSqlite.close());

describe('the 12-hour cutoff on the sync side', () => {
  it('uses the device clock, so a fast tablet clock does not cut the shift early', async () => {
    // The tablet reads 30 minutes fast: its clock said 00:00 at the start, while
    // the server (true time) recorded 23:30 the night before. At 11 h 45 by the
    // tablet's own clock, the shift has run 11 h 45, not 12 h 15.
    await AsyncStorage.setItem('userId', ANA);
    addShift('s1', {
      startedAt: '2026-11-07T23:30:00.000Z',
      startDevice: '2026-11-08T00:00:00.000Z',
    });

    const expired = await expireOverdueShifts(Date.parse('2026-11-08T11:45:00.000Z'));

    expect(expired).toBe(0);
    expect(shiftRow('s1').status).toBe('open');
    expect(autoCloseRows('s1')).toHaveLength(0);
  });

  it('expires a shift at 12 h on the device clock and ends it at the server start + 12 h', async () => {
    await AsyncStorage.setItem('userId', ANA);
    addShift('s2', {
      startedAt: '2026-11-07T23:30:00.000Z',
      startDevice: '2026-11-08T00:00:00.000Z',
    });

    const expired = await expireOverdueShifts(Date.parse('2026-11-08T12:00:00.000Z'));

    expect(expired).toBe(1);
    const shift = shiftRow('s2');
    expect(shift).toMatchObject({ status: 'report_pending', end_type: 'auto', device_time_flag: 1 });
    expect(shift.ended_at).toBe('2026-11-08T11:30:00.000Z');
    const [row] = autoCloseRows('s2');
    expect(row.op).toBe('VERIFY');
    expect(JSON.parse(row.payload_json)).toMatchObject({
      shiftId: 's2',
      projectId: WELL,
      operatorId: ANA,
      endedAt: '2026-11-08T11:30:00.000Z',
    });
  });

  it('queues the verification once, however many times it runs', async () => {
    addShift('s3', { startedAt: '2026-11-08T00:00:00.000Z', startDevice: null });
    const later = Date.parse('2026-11-08T13:00:00.000Z');

    expect(await expireOverdueShifts(later)).toBe(1);
    expect(await expireOverdueShifts(later)).toBe(0);
    expect(autoCloseRows('s3')).toHaveLength(1);
  });

  it('leaves shifts that are already closed or waiting for a report alone', async () => {
    addShift('closed', { status: 'closed', startedAt: '2026-11-07T00:00:00.000Z', startDevice: null });
    addShift('waiting', { status: 'report_pending', startedAt: '2026-11-07T00:00:00.000Z', startDevice: null });

    expect(await expireOverdueShifts(Date.parse('2026-11-08T13:00:00.000Z'))).toBe(0);
    expect(shiftRow('closed').status).toBe('closed');
    expect(shiftRow('waiting').status).toBe('report_pending');
  });

  it('is exactly the 12-hour rule, measured from the device start', () => {
    const shift = { id: 'x', project_id: WELL, operator_id: ANA, status: 'open',
      started_at: '2026-11-08T00:00:00.000Z', start_device_time: '2026-11-08T00:00:00.000Z' };
    const start = Date.parse(shift.start_device_time);
    expect(SHIFT_CUTOFF_MS).toBe(12 * 60 * 60 * 1000);
    expect(isPastShiftCutoff(shift, start + SHIFT_CUTOFF_MS - 1)).toBe(false);
    expect(isPastShiftCutoff(shift, start + SHIFT_CUTOFF_MS)).toBe(true);
  });
});
