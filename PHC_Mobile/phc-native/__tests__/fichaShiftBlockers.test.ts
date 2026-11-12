/**
 * The Ficha pre-check and another operator's stale shift row, on real SQLite (OPB-8 with H5):
 *  - the phone checks every operator's unresolved shifts on the well before a
 *    Ficha is sent, because the server refuses the Ficha while any is open (OPB-8);
 *  - the well is marked closure_submitted only once the server has accepted the
 *    Ficha, and a shift whose queued rows were refused no longer reads "pending"
 *    forever (SYNC-10).
 */
const { DatabaseSync } = require('node:sqlite');

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
const mockGetClosedAmong = jest.fn();
jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: { getClosedAmong: (...args: any[]) => mockGetClosedAmong(...args) },
}));
jest.mock('../src/events/operatorDataEvents', () => ({ notifyOperatorDataChanged: jest.fn() }));
jest.mock('../src/api/supabase-drilling-bars', () => ({ drillingBarsApi: {} }));
jest.mock('../src/api/supabase-pedidos', () => ({ pedidosApi: {} }));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: {} }));
jest.mock('../src/api/supabase-photos', () => ({ photosApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: {} }));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { fichaShiftBlockers } from '../src/sync/fichaShiftBlockers';

const ANA = 'operator-ana';
const BEA = 'operator-bea';
const WELL = 7;
const OTHER_WELL = 8;

const addShift = (id: string, operator: string, status: string, project = WELL) =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-08T08:00:00.000Z')`,
  ).run(id, id, `entry-${id}`, project, operator, status);

beforeEach(() => {
  jest.clearAllMocks();
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Ana'), (?, 'Bea')`).run(ANA, BEA);
  mockSqlite.prepare(`INSERT INTO projects (id, name, status, assigned_operator_id) VALUES (?, 'Pozo 7', 'active', ?), (?, 'Pozo 8', 'active', ?)`)
    .run(WELL, ANA, OTHER_WELL, ANA);
});

afterEach(() => mockSqlite.close());

describe('another operator\'s row is checked with the server first (H5)', () => {
  it('a row the server already closed (force-close) does not block, and is closed locally', async () => {
    addShift('bea-stale', BEA, 'open');
    mockGetClosedAmong.mockResolvedValue([{
      id: 'bea-stale', ended_at: '2026-11-08T12:00:00.000Z', end_type: 'admin',
      usage_report_submitted: false, device_time_flag: false, notes: 'cierre forzado',
    }]);

    const result = await fichaShiftBlockers(WELL, ANA);

    expect(result).toEqual({ blockers: [], confirmed: true });
    expect(mockSqlite.prepare("SELECT status FROM shifts WHERE id = 'bea-stale'").get().status).toBe('closed');
  });

  it('a row the server still has open blocks, confirmed', async () => {
    addShift('bea-open', BEA, 'open');
    mockGetClosedAmong.mockResolvedValue([]);

    expect(await fichaShiftBlockers(WELL, ANA)).toEqual({
      blockers: [{ operator_id: BEA, name: 'Bea' }], confirmed: true,
    });
  });

  it('offline the local row stands, marked unconfirmed', async () => {
    addShift('bea-open', BEA, 'open');
    mockGetClosedAmong.mockRejectedValue(new Error('Network request failed'));

    expect(await fichaShiftBlockers(WELL, ANA)).toEqual({
      blockers: [{ operator_id: BEA, name: 'Bea' }], confirmed: false,
    });
  });

  it('only this operator\'s own shift: no server call', async () => {
    addShift('ana-open', ANA, 'open');

    expect(await fichaShiftBlockers(WELL, ANA)).toEqual({
      blockers: [{ operator_id: ANA, name: 'Ana' }], confirmed: true,
    });
    expect(mockGetClosedAmong).not.toHaveBeenCalled();
  });
});
