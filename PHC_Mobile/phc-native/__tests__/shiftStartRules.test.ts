/**
 * Starting a shift needs the server, and a start the server refused must not hold
 * anything hostage (audit B2). These run the real SQL against a real SQLite with
 * the app's real schema, because a mocked database would accept SQL that the phone
 * rejects. Only the network is fake.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockShiftStart = jest.fn();
const mockConfirmHandover = jest.fn();

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
    start: (...args: any[]) => mockShiftStart(...args),
    confirmHandover: (...args: any[]) => mockConfirmHandover(...args),
  },
}));
jest.mock('../src/api/supabase-pedidos', () => ({ pedidosApi: {} }));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: {} }));
// The operator is signed in: a 42501 is then a real refusal, not a lapsed session.
jest.mock('../src/sync/sessionValidity', () => ({ hasUsableSession: async () => true }));
jest.mock('../src/api/supabase-photos', () => ({ photosApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: {} }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { subscribeToOperatorDataChanges } from '../src/events/operatorDataEvents';
import { resetOutboxForManualRetry, selectDrainableOutboxRows } from '../src/db/operations';
import { claimOutbox, countUnsentOutboxRows } from '../src/sync/outboxOwner';
import { syncProductV2PreWork } from '../src/sync/productV2Sync';
import { releaseWorkBehindRejectedStarts } from '../src/sync/rejectedStart';
import { startShiftOnServer } from '../src/sync/startShift';

const OPERATOR = 'operator-beto';
const PROJECT = 7;
const OVERLAP = 'Todavía no podés iniciar: el turno de Ana en este pozo sigue sin cerrar.';

const all = (sql: string, ...params: any[]) => mockSqlite.prepare(sql).all(...params);
const one = (sql: string, ...params: any[]) => mockSqlite.prepare(sql).get(...params);

const serverShift = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  client_entry_id: `entry-${id}`,
  project_id: PROJECT,
  operator_id: OPERATOR,
  status: 'open',
  started_at: '2026-11-06T12:00:00.000Z',
  start_device_time: '2026-11-06T11:30:00.000Z',
  usage_report_submitted: false,
  handover_confirmed: false,
  device_time_flag: true,
  ...overrides,
});

const queue = (id: string, entity: string, entityId: string, payload: object, state = 'pending') =>
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
     VALUES (?, ?, ?, 'UPSERT', ?, 0, ?, ?, '2026-11-06T10:00:00.000Z', '2026-11-06T10:00:00.000Z')`,
  ).run(id, entity, entityId, JSON.stringify(payload), state, state === 'quarantined' ? 'Access denied to this project (42501)' : null);

const addLocalShift = (id: string, serverId: string | null = null, status = 'open') =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-06T09:00:00.000Z')`,
  ).run(id, serverId, `entry-${id}`, PROJECT, OPERATOR, status);

let nextBarNumber = 1;
const addBar = (id: string, shiftId: string) =>
  mockSqlite.prepare(
    `INSERT INTO drilling_bar_entries (id, project_id, operator_id, shift_id, bar_number, depth_start, depth_end, length, soil_type, timestamp_local, sync_status)
     VALUES (?, ?, ?, ?, ?, 0, 3, 3, 'arcilla', '2026-11-06T09:30:00.000Z', 'pending')`,
  ).run(id, PROJECT, OPERATOR, shiftId, nextBarNumber++);

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Beto')`).run(OPERATOR);
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (?, 'Pozo 7', ?)`).run(PROJECT, OPERATOR);
});

afterEach(() => mockSqlite.close());

describe('startShiftOnServer', () => {
  const start = () => startShiftOnServer({ projectId: PROJECT, operatorId: OPERATOR, operatorName: 'Beto' });

  it('leaves the start time to the server and sends only the phone clock', async () => {
    mockShiftStart.mockImplementation(async (input: any) => serverShift(input.shiftId));
    await start();
    const input = mockShiftStart.mock.calls[0][0];
    expect(input.startedAt).toBeUndefined();
    expect(input.deviceStartedAt).toEqual(expect.any(String));
  });

  it('stores the shift as the server has it, ready for its bars', async () => {
    mockShiftStart.mockImplementation(async (input: any) => serverShift(input.shiftId));
    expect(await start()).toEqual({ kind: 'started' });
    const shift = one('SELECT * FROM shifts');
    expect(shift.server_id).toBe(shift.id);
    expect(shift.status).toBe('open');
    expect(shift.started_at).toBe('2026-11-06T12:00:00.000Z');
    expect(shift.start_device_time).toBe('2026-11-06T11:30:00.000Z');
    expect(shift.device_time_flag).toBe(1);
    expect(all('SELECT * FROM sync_outbox')).toEqual([]);
  });

  it('picks up the shift the server already has, as after a lost response', async () => {
    mockShiftStart.mockResolvedValue(serverShift('already-open'));
    expect(await start()).toEqual({ kind: 'resumed' });
    expect(one('SELECT id FROM shifts').id).toBe('already-open');
    expect(all('SELECT * FROM shifts')).toHaveLength(1);
  });

  it('saves nothing without a connection', async () => {
    mockShiftStart.mockRejectedValue({ message: 'TypeError: Network request failed', code: '' });
    expect(await start()).toEqual({ kind: 'no_connection' });
    expect(all('SELECT * FROM shifts')).toEqual([]);
    expect(all('SELECT * FROM sync_outbox')).toEqual([]);
  });

  it('shows the server message when another operator holds the well, and saves nothing', async () => {
    mockShiftStart.mockRejectedValue({ message: OVERLAP, code: '55000' });
    expect(await start()).toEqual({ kind: 'refused', message: OVERLAP });
    expect(all('SELECT * FROM shifts')).toEqual([]);
  });

  it.each([
    ['42501', 'Access denied to this project', 'Este pozo ya no está asignado a vos. Hablá con el administrador.'],
    ['55000', 'Project is not open for a new shift', 'Este pozo no está abierto para iniciar un turno. Hablá con el administrador.'],
    ['22023', 'shift_id and client_entry_id are required', 'El servidor no aceptó el inicio del turno. Intentá de nuevo o avisale al administrador.'],
  ])('never shows raw server text for %s', async (code, message, expected) => {
    mockShiftStart.mockRejectedValue({ message, code });
    expect(await start()).toEqual({ kind: 'refused', message: expected });
  });
});

describe('work behind a refused start', () => {
  const stuckPhone = () => {
    addLocalShift('refused');
    addBar('bar-1', 'refused');
    addBar('bar-2', 'refused');
    queue('start', 'shift_start', 'refused', { shiftId: 'refused', projectId: PROJECT }, 'quarantined');
    queue('handover', 'shift_handover', 'refused', { shiftId: 'refused', items: [] });
    queue('close', 'shift_end', 'refused', { shiftId: 'refused' });
    queue('auto', 'shift_auto_close', 'refused', { shiftId: 'refused' });
    queue('out-bar-1', 'drilling_bar', 'bar-1', { shift_id: 'refused' });
    queue('out-bar-2', 'drilling_bar', 'bar-2', { shift_id: 'refused' });
  };
  const states = () => Object.fromEntries(
    all('SELECT id, state FROM sync_outbox').map((row: any) => [row.id, row.state]),
  );

  it('sends the whole shift to review instead of leaving it waiting', async () => {
    stuckPhone();
    expect(await releaseWorkBehindRejectedStarts()).toBe(1);
    expect(states()).toEqual({
      start: 'quarantined',
      handover: 'quarantined',
      close: 'quarantined',
      auto: 'quarantined',
      'out-bar-1': 'quarantined',
      'out-bar-2': 'quarantined',
    });
    expect(one(`SELECT last_error FROM sync_outbox WHERE id = 'out-bar-1'`).last_error)
      .toContain('Access denied to this project (42501)');
    expect(one(`SELECT sync_status, last_error FROM drilling_bar_entries WHERE id = 'bar-1'`).sync_status).toBe('failed');
  });

  it('tells the visible screen once, not on every drain', async () => {
    stuckPhone();
    const onChange = jest.fn();
    const unsubscribe = subscribeToOperatorDataChanges(onChange);

    expect(await releaseWorkBehindRejectedStarts()).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(await releaseWorkBehindRejectedStarts()).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('leaves work from other shifts alone', async () => {
    stuckPhone();
    addLocalShift('other-shift', 'other-server-id', 'closed');
    addBar('bar-other', 'other-shift');
    queue('out-other', 'drilling_bar', 'bar-other', { shift_id: 'other-server-id' });
    queue('out-sample', 'water_sample', 'sample-1', { projectId: PROJECT });
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
       VALUES ('out-broken', 'drilling_bar', 'bar-x', 'UPSERT', 'not json', 0, '2026-11-06T10:00:00.000Z', '2026-11-06T10:00:00.000Z')`,
    ).run();

    await releaseWorkBehindRejectedStarts();

    const after = states();
    expect(after['out-other']).toBe('pending');
    expect(after['out-sample']).toBe('pending');
    expect(after['out-broken']).toBe('pending');
    expect((await selectDrainableOutboxRows('drilling_bar')).map((row: any) => row.id).sort())
      .toEqual(['out-broken', 'out-other']);
  });

  it('frees the operator to start another shift', async () => {
    stuckPhone();
    mockShiftStart.mockImplementation(async (input: any) => serverShift(input.shiftId));
    await releaseWorkBehindRejectedStarts();

    expect(one(`SELECT status FROM shifts WHERE id = 'refused'`).status).toBe('rejected');
    expect(all(`SELECT id FROM shifts WHERE status IN ('open', 'report_pending')`)).toEqual([]);
    expect(await startShiftOnServer({ projectId: PROJECT, operatorId: OPERATOR, operatorName: 'Beto' }))
      .toEqual({ kind: 'started' });
  });

  it('allows the next operator in without archiving or deleting the first operator\'s work', async () => {
    stuckPhone();
    await AsyncStorage.setItem('phc.outboxOwnerId', OPERATOR);
    expect((await claimOutbox('operator-ana')).ok).toBe(true);
    expect(await countUnsentOutboxRows()).toBeGreaterThan(0);
    expect(all('SELECT * FROM sync_outbox')).not.toEqual([]);
    expect(all('SELECT * FROM rejected_work')).toEqual([]);

    await releaseWorkBehindRejectedStarts();

    expect(await countUnsentOutboxRows()).toBe(0);
    expect(await claimOutbox('operator-ana')).toEqual({ ok: true, unsent: 0 });
    // The refused work stays in the queue, quarantined, for the review list.
    expect(all("SELECT id FROM sync_outbox WHERE COALESCE(state, 'pending') <> 'quarantined'")).toEqual([]);
    expect(all("SELECT id FROM sync_outbox WHERE state = 'quarantined' ORDER BY id").length).toBe(6);
  });

  it('handles a refusal and its waiting work in the same pass, without trying the work', async () => {
    addLocalShift('queued');
    queue('start', 'shift_start', 'queued', { shiftId: 'queued', projectId: PROJECT });
    queue('handover', 'shift_handover', 'queued', { shiftId: 'queued', items: [] });
    mockShiftStart.mockRejectedValue({ message: OVERLAP, code: '55000' });

    await syncProductV2PreWork();

    expect(states()).toEqual({ start: 'quarantined', handover: 'quarantined' });
    expect(mockConfirmHandover).not.toHaveBeenCalled();
    expect(one(`SELECT status FROM shifts WHERE id = 'queued'`).status).toBe('rejected');
  });

  it('goes back to review if "Reintentar" is refused again', async () => {
    stuckPhone();
    await releaseWorkBehindRejectedStarts();
    await resetOutboxForManualRetry();
    expect(new Set(Object.values(states()))).toEqual(new Set(['pending']));
    mockShiftStart.mockRejectedValue({ message: 'Access denied to this project', code: '42501' });

    await syncProductV2PreWork();

    expect(new Set(Object.values(states()))).toEqual(new Set(['quarantined']));
    expect(mockConfirmHandover).not.toHaveBeenCalled();
  });

  it('restores the shift and its work if "Reintentar" is accepted', async () => {
    stuckPhone();
    await releaseWorkBehindRejectedStarts();
    await resetOutboxForManualRetry();
    mockShiftStart.mockResolvedValue(serverShift('refused'));
    mockConfirmHandover.mockResolvedValue({ handover_confirmed: true });

    await syncProductV2PreWork();

    const shift = one(`SELECT status, server_id FROM shifts WHERE id = 'refused'`);
    expect(shift.status).toBe('open');
    expect(shift.server_id).toBe('refused');
    expect(mockConfirmHandover).toHaveBeenCalledTimes(1);
    const after = states();
    expect(after.start).toBeUndefined();
    expect(after['out-bar-1']).toBe('pending');
  });

  it('does nothing for a start the server has already accepted', async () => {
    addLocalShift('landed', 'landed');
    queue('start', 'shift_start', 'landed', { shiftId: 'landed' }, 'quarantined');
    queue('close', 'shift_end', 'landed', { shiftId: 'landed' });
    expect(await releaseWorkBehindRejectedStarts()).toBe(0);
    expect(states().close).toBe('pending');
    expect(one(`SELECT status FROM shifts WHERE id = 'landed'`).status).toBe('open');
  });
});
