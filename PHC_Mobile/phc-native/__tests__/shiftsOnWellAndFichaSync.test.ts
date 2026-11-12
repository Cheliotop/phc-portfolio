/**
 * Two things about the Ficha and a well's shifts, on real SQLite:
 *  - the phone checks every operator's unresolved shifts on the well before a
 *    Ficha is sent, because the server refuses the Ficha while any is open (OPB-8);
 *  - the well is marked closure_submitted only once the server has accepted the
 *    Ficha, and a shift whose queued rows were refused no longer reads "pending"
 *    forever (SYNC-10).
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockSubmitV2 = jest.fn();

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
jest.mock('../src/api/supabase-shifts', () => ({ shiftsApi: {} }));
jest.mock('../src/api/supabase-drilling-bars', () => ({ drillingBarsApi: {} }));
jest.mock('../src/api/supabase-pedidos', () => ({ pedidosApi: {} }));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: {} }));
jest.mock('../src/api/supabase-photos', () => ({ photosApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({
  completionApi: { submitV2: (...args: any[]) => mockSubmitV2(...args) },
}));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { unresolvedShiftOperatorsOnWell } from '../src/db/repositories/shifts';
import { getShiftSyncState, syncPendingCompletionsV2 } from '../src/sync/productV2Sync';

const ANA = 'operator-ana';
const BEA = 'operator-bea';
const WELL = 7;
const OTHER_WELL = 8;

const addShift = (id: string, operator: string, status: string, project = WELL) =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-08T08:00:00.000Z')`,
  ).run(id, id, `entry-${id}`, project, operator, status);

const queue = (
  id: string,
  entity: string,
  entityId: string,
  payload: Record<string, unknown>,
  state = 'pending',
) => mockSqlite.prepare(
  `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, author_id, retries, state, created_at, updated_at)
   VALUES (?, ?, ?, 'UPSERT', ?, ?, 0, ?, '2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z')`,
).run(id, entity, entityId, JSON.stringify(payload), ANA, state);

const projectStatus = (id: number) =>
  mockSqlite.prepare('SELECT status FROM projects WHERE id = ?').get(id)?.status;

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

describe('the Ficha pre-check looks at every operator on the well (OPB-8)', () => {
  it('names an open shift of the other operator on the same well', async () => {
    addShift('bea-open', BEA, 'open');

    const blockers = await unresolvedShiftOperatorsOnWell(WELL);

    expect(blockers).toEqual([{ operator_id: BEA, name: 'Bea' }]);
  });

  it('counts a shift closed on the phone whose end has not reached the server', async () => {
    addShift('bea-closed-queued', BEA, 'closed');
    queue('q-end', 'shift_end', 'bea-closed-queued', { shiftId: 'bea-closed-queued' });

    expect(await unresolvedShiftOperatorsOnWell(WELL)).toEqual([{ operator_id: BEA, name: 'Bea' }]);
  });

  it('ignores a refused close, and shifts that are closed and synced', async () => {
    addShift('bea-refused', BEA, 'closed');
    queue('q-refused', 'shift_end', 'bea-refused', { shiftId: 'bea-refused' }, 'quarantined');
    addShift('ana-done', ANA, 'closed');
    addShift('bea-other-well', BEA, 'open', OTHER_WELL);

    expect(await unresolvedShiftOperatorsOnWell(WELL)).toEqual([]);
  });
});

describe('the well is marked closure_submitted only after the server accepts the Ficha (OPB-8)', () => {
  const queueFicha = () => {
    mockSqlite.prepare(
      `INSERT INTO completion_reports_local (id, client_entry_id, project_id, operator_id, status, sync_status, created_at, updated_at)
       VALUES ('entry-ficha', 'entry-ficha', ?, ?, 'submitted', 'pending', '2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z')`,
    ).run(WELL, ANA);
    queue('q-ficha', 'completion_v2', 'entry-ficha', { projectId: WELL, clientEntryId: 'entry-ficha', finalFields: {} });
  };

  it('keeps the well open while the server is refusing the Ficha', async () => {
    queueFicha();
    mockSubmitV2.mockRejectedValue({ code: '55000', message: 'Hay turnos sin cerrar' });

    await syncPendingCompletionsV2();

    expect(projectStatus(WELL)).toBe('active');
  });

  it('marks the well closure_submitted once the server has the Ficha', async () => {
    queueFicha();
    mockSubmitV2.mockResolvedValue({ data: { id: 99, status: 'submitted', submitted_at: '2026-11-08T11:00:00.000Z' } });

    await syncPendingCompletionsV2();

    expect(projectStatus(WELL)).toBe('closure_submitted');
    expect(projectStatus(OTHER_WELL)).toBe('active');
  });
});

describe('a refused shift row does not keep its shift "pending" forever (SYNC-10)', () => {
  it('reports synced when the only queued row for the shift was refused', async () => {
    addShift('s-refused', ANA, 'closed');
    queue('q1', 'shift_end', 's-refused', { shiftId: 's-refused' }, 'quarantined');

    expect(await getShiftSyncState('s-refused')).toBe('synced');
  });

  it('still reports pending while a row is waiting to be sent', async () => {
    addShift('s-waiting', ANA, 'closed');
    queue('q2', 'shift_end', 's-waiting', { shiftId: 's-waiting' }, 'pending');

    expect(await getShiftSyncState('s-waiting')).toBe('pending');
  });
});
