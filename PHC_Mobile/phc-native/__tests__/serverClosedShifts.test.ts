/**
 * The phone must catch up when the server closes a shift without it (audit H4), and
 * another operator's stale row must not block a Ficha (audit H5). These run the real
 * SQL against a real SQLite with the app's real schema. Only the network is fake.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockGetClosedAmong = jest.fn();
const mockEnd = jest.fn();

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
jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: {
    getClosedAmong: (...args: any[]) => mockGetClosedAmong(...args),
    end: (...args: any[]) => mockEnd(...args),
  },
}));
jest.mock('../src/api/supabase-pedidos', () => ({ pedidosApi: {} }));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: {} }));
jest.mock('../src/api/supabase-photos', () => ({ photosApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: {} }));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { countOwnUnresolvedShifts } from '../src/db/repositories/shifts';
import { subscribeToOperatorDataChanges } from '../src/events/operatorDataEvents';
import { syncPendingShiftEnds, syncProductV2PreWork } from '../src/sync/productV2Sync';
import { reconcileServerClosedShifts } from '../src/sync/serverClosedShifts';

const ANA = 'operator-ana';
const BETO = 'operator-beto';
const PROJECT = 7;

const one = (sql: string, ...params: any[]) => mockSqlite.prepare(sql).get(...params);

const addLocalShift = (id: string, serverId: string | null, status = 'open', operator = ANA) =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-07T09:00:00.000Z')`,
  ).run(id, serverId, `entry-${id}`, PROJECT, operator, status);

const forceClosed = (id: string) => ({
  id,
  ended_at: '2026-11-07T13:00:00.000Z',
  end_type: 'admin',
  usage_report_submitted: false,
  device_time_flag: false,
  notes: 'Perdió el teléfono',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Ana'), (?, 'Beto')`).run(ANA, BETO);
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (?, 'Pozo 7', ?)`).run(PROJECT, ANA);
});

afterEach(() => mockSqlite.close());

describe('reconcileServerClosedShifts', () => {
  it('closes a shift the admin force-closed, with what the server recorded', async () => {
    addLocalShift('s1', 's1');
    mockGetClosedAmong.mockResolvedValue([forceClosed('s1')]);

    expect(await reconcileServerClosedShifts()).toBe(1);

    expect(one(`SELECT status, ended_at, end_type, usage_report_submitted, notes FROM shifts WHERE id = 's1'`)).toEqual({
      status: 'closed',
      ended_at: '2026-11-07T13:00:00.000Z',
      end_type: 'admin',
      usage_report_submitted: 0,
      notes: 'Perdió el teléfono',
    });
  });

  it('also catches a shift auto-closed locally while waiting for its report', async () => {
    addLocalShift('s1', 's1', 'report_pending');
    mockGetClosedAmong.mockResolvedValue([forceClosed('s1')]);

    await reconcileServerClosedShifts();

    expect(one(`SELECT status FROM shifts WHERE id = 's1'`).status).toBe('closed');
  });

  it('leaves a shift alone while the server still has it open', async () => {
    addLocalShift('s1', 's1');
    mockGetClosedAmong.mockResolvedValue([]);

    expect(await reconcileServerClosedShifts()).toBe(0);

    expect(one(`SELECT status FROM shifts WHERE id = 's1'`).status).toBe('open');
  });

  it('only asks about shifts the server knows and the phone holds open', async () => {
    // The phone holds one unresolved shift per operator, so the queued one is Beto's.
    addLocalShift('queued', null, 'open', BETO);
    addLocalShift('done', 'done', 'closed');
    addLocalShift('refused', 'refused', 'rejected');
    addLocalShift('s1', 's1');
    mockGetClosedAmong.mockResolvedValue([]);

    await reconcileServerClosedShifts();

    expect(mockGetClosedAmong).toHaveBeenCalledWith(['s1']);
  });

  it('does not ask at all with nothing open', async () => {
    addLocalShift('done', 'done', 'closed');

    expect(await reconcileServerClosedShifts()).toBe(0);

    expect(mockGetClosedAmong).not.toHaveBeenCalled();
  });

  it('tells the visible screen once, not on every drain', async () => {
    addLocalShift('s1', 's1');
    mockGetClosedAmong.mockResolvedValue([forceClosed('s1')]);
    const onChange = jest.fn();
    const unsubscribe = subscribeToOperatorDataChanges(onChange);

    await reconcileServerClosedShifts();
    await reconcileServerClosedShifts();

    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does not stop the drain when the server cannot be reached', async () => {
    addLocalShift('s1', 's1');
    mockGetClosedAmong.mockRejectedValue(new TypeError('Network request failed'));

    await expect(syncProductV2PreWork()).resolves.toEqual({ synced: 0, failed: 0 });

    expect(one(`SELECT status FROM shifts WHERE id = 's1'`).status).toBe('open');
  });

  it('sends a close the phone had queued to review, keeping the usage figures', async () => {
    addLocalShift('s1', 's1');
    const payload = { shiftId: 's1', usage: [{ project_material_id: 3, quantity_used: 2 }], endType: 'manual' };
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
       VALUES ('q1', 'shift_end', 's1', 'UPSERT', ?, 0, '2026-11-07T10:00:00.000Z', '2026-11-07T10:00:00.000Z')`,
    ).run(JSON.stringify(payload));
    mockGetClosedAmong.mockResolvedValue([forceClosed('s1')]);
    mockEnd.mockRejectedValue(Object.assign(new Error('Shift cannot be closed from status closed'), { code: '22023' }));

    await syncProductV2PreWork();
    await syncPendingShiftEnds();

    const row = one(`SELECT state, payload_json FROM sync_outbox WHERE id = 'q1'`);
    expect(row.state).toBe('quarantined');
    expect(JSON.parse(row.payload_json).usage[0].quantity_used).toBe(2);
    expect(one(`SELECT status, end_type FROM shifts WHERE id = 's1'`)).toEqual({ status: 'closed', end_type: 'admin' });
  });
});

describe('countOwnUnresolvedShifts', () => {
  it('ignores another operator\'s stale shift on this phone (H5)', async () => {
    addLocalShift('beto-stale', 'beto-stale', 'open', BETO);

    expect(await countOwnUnresolvedShifts(PROJECT, ANA)).toBe(0);
  });

  it('counts the operator\'s own open and report-pending shifts', async () => {
    addLocalShift('a1', 'a1', 'open');
    expect(await countOwnUnresolvedShifts(PROJECT, ANA)).toBe(1);

    mockSqlite.exec(`UPDATE shifts SET status = 'report_pending' WHERE id = 'a1'`);
    expect(await countOwnUnresolvedShifts(PROJECT, ANA)).toBe(1);
  });

  it('does not count closed or refused shifts', async () => {
    addLocalShift('a1', 'a1', 'closed');
    addLocalShift('a2', 'a2', 'rejected');

    expect(await countOwnUnresolvedShifts(PROJECT, ANA)).toBe(0);
  });

  it('only looks at this well', async () => {
    mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (8, 'Pozo 8', ?)`).run(ANA);
    addLocalShift('a1', 'a1', 'open');

    expect(await countOwnUnresolvedShifts(8, ANA)).toBe(0);
  });
});
