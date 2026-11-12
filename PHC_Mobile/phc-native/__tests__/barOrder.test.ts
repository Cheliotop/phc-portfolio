/**
 * A well's bars must reach the server in the order they were recorded, and a shift's
 * close must wait for its bars, because the server numbers bars and works out their
 * depth as they arrive. These run the real SQL against a real SQLite with the app's
 * real schema. Only the network is fake.
 */
const { DatabaseSync } = require('node:sqlite');
import AsyncStorage from '@react-native-async-storage/async-storage';

let mockSqlite: any;
const mockCreateBar = jest.fn();
const mockUploadPhoto = jest.fn();
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
jest.mock('../src/api/supabase-drilling-bars', () => ({
  drillingBarsApi: { create: (...args: any[]) => mockCreateBar(...args) },
}));
jest.mock('../src/api/supabase-photos', () => ({
  photosApi: { uploadProjectPhoto: (...args: any[]) => mockUploadPhoto(...args) },
}));
const mockGetById = jest.fn();
jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: {
    end: (...args: any[]) => mockEnd(...args),
    getById: (...args: any[]) => mockGetById(...args),
  },
}));
jest.mock('../src/api/supabase-pedidos', () => ({ pedidosApi: {} }));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: {} }));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { LocalPhotoMissingError } from '../src/api/photoErrors';
import { syncPendingDrillingBars } from '../src/sync/drillingSync';
import { syncPendingShiftAutoCloses, syncPendingShiftEnds } from '../src/sync/productV2Sync';

const ANA = 'operator-ana';
const WELL = 7;
const OTHER_WELL = 8;

const one = (sql: string, ...params: any[]) => mockSqlite.prepare(sql).get(...params);
const outboxIds = () =>
  mockSqlite.prepare(`SELECT id FROM sync_outbox ORDER BY created_at, rowid`).all().map((row: any) => row.id);

const addShift = (id: string, serverId: string | null, project = WELL) =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'closed', '2026-11-08T09:00:00.000Z')`,
  ).run(id, serverId, `entry-${id}`, project, ANA);

let clock = 0;
const queue = (
  id: string,
  entity: string,
  entityId: string,
  payload: Record<string, unknown>,
  extra: { retries?: number; state?: string; updatedAt?: string } = {},
) => {
  clock += 1;
  const createdAt = `2026-11-08T10:00:${String(clock).padStart(2, '0')}.000Z`;
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, created_at, updated_at)
     VALUES (?, ?, ?, 'UPSERT', ?, ?, ?, ?, ?)`,
  ).run(
    id, entity, entityId, JSON.stringify(payload), extra.retries ?? 0, extra.state ?? 'pending',
    createdAt, extra.updatedAt ?? createdAt,
  );
};

const queueBar = (
  id: string,
  shiftId: string,
  project = WELL,
  extra: Parameters<typeof queue>[4] & { photos?: string[]; notes?: string } = {},
) => queue(id, 'drilling_bar', `local-${id}`, {
  project_id: project,
  shift_id: shiftId,
  client_entry_id: `entry-${id}`,
  soil_type: 'Arcilla',
  length: 3,
  timestamp_local: '2026-11-08T10:00:00.000Z',
  ...(extra.photos ? { photo_paths: extra.photos } : {}),
  ...(extra.notes ? { notes: extra.notes } : {}),
}, extra);

const queueClose = (id: string, shiftId: string) =>
  queue(id, 'shift_end', shiftId, { shiftId, endType: 'manual', usage: [] });

const offline = () => Object.assign(new TypeError('Network request failed'));

beforeEach(() => {
  jest.clearAllMocks();
  clock = 0;
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Ana')`).run(ANA);
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (?, 'Pozo 7', ?), (?, 'Pozo 8', ?)`)
    .run(WELL, ANA, OTHER_WELL, ANA);
  let number = 0;
  mockCreateBar.mockImplementation(async (payload: any) => {
    number += 1;
    return { data: { id: number, bar_number: number, depth_start: 0, depth_end: 3, length: 3, payload } };
  });
  mockEnd.mockImplementation(async (payload: any) => ({
    id: payload.shiftId, ended_at: '2026-11-08T12:00:00.000Z', end_type: 'manual', device_time_flag: false,
  }));
});

afterEach(() => mockSqlite.close());

describe('a well\'s bars upload in the order they were recorded', () => {
  it('leaves a non-crew operator\'s well rows waiting without retrying them', async () => {
    await AsyncStorage.setItem('operatorId', ANA);
    mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('operator-other', 'Otro')`).run();
    mockSqlite.prepare('UPDATE projects SET assigned_operator_id = ? WHERE id = ?').run('operator-other', OTHER_WELL);
    addShift('s8', 's8', OTHER_WELL);
    queueBar('other-crew-bar', 's8', OTHER_WELL);

    expect(await syncPendingDrillingBars()).toEqual({ synced: 0, failed: 0 });
    expect(mockCreateBar).not.toHaveBeenCalled();
    expect(one("SELECT retries, state FROM sync_outbox WHERE id = 'other-crew-bar'")).toEqual({ retries: 0, state: 'pending' });
  });

  it('does not let other wells\' waiting rows use up the batch a crew well drains', async () => {
    await AsyncStorage.setItem('operatorId', ANA);
    mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('operator-other', 'Otro')`).run();
    mockSqlite.prepare('UPDATE projects SET assigned_operator_id = ? WHERE id = ?').run('operator-other', OTHER_WELL);
    addShift('s1', 's1');
    addShift('s8', 's8', OTHER_WELL);
    for (let index = 0; index < 26; index += 1) queueBar(`other-${index}`, 's8', OTHER_WELL);
    queueBar('mine', 's1');

    expect((await syncPendingDrillingBars()).synced).toBe(1);
    expect(mockCreateBar.mock.calls[0][0].client_entry_id).toBe('entry-mine');
  });

  it('holds later bars of a well while an earlier one fails, and lets other wells go', async () => {
    addShift('s1', 's1');
    addShift('s8', 's8', OTHER_WELL);
    queueBar('b1', 's1');
    queueBar('b2', 's1');
    queueBar('c1', 's8', OTHER_WELL);
    mockCreateBar.mockImplementationOnce(async () => { throw offline(); });

    expect(await syncPendingDrillingBars()).toEqual({ synced: 1, failed: 1 });

    expect(mockCreateBar.mock.calls.map(([payload]) => payload.client_entry_id)).toEqual(['entry-b1', 'entry-c1']);
    expect(outboxIds()).toEqual(['b1', 'b2']);
    // The bar that waited used no retry.
    expect(one(`SELECT retries FROM sync_outbox WHERE id = 'b2'`).retries).toBe(0);
  });

  it('sends them in order once the earlier one goes through', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1');
    queueBar('b2', 's1');
    queueBar('b3', 's1');

    expect(await syncPendingDrillingBars()).toEqual({ synced: 3, failed: 0 });

    expect(mockCreateBar.mock.calls.map(([payload]) => payload.client_entry_id))
      .toEqual(['entry-b1', 'entry-b2', 'entry-b3']);
  });

  it('holds them behind an earlier bar that is cooling down and was not picked this time', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1', WELL, { retries: 3, updatedAt: new Date().toISOString() });
    queueBar('b2', 's1');

    expect(await syncPendingDrillingBars()).toEqual({ synced: 0, failed: 0 });

    expect(mockCreateBar).not.toHaveBeenCalled();
  });

  it('does not hold them behind a bar the server refused for good', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1', WELL, { state: 'quarantined', retries: 3 });
    queueBar('b2', 's1');

    expect(await syncPendingDrillingBars()).toEqual({ synced: 1, failed: 0 });

    expect(mockCreateBar.mock.calls.map(([payload]) => payload.client_entry_id)).toEqual(['entry-b2']);
  });

  it('holds a later shift\'s bars behind an earlier shift that is still waiting for its start', async () => {
    addShift('old', null);
    addShift('s2', 's2');
    queueBar('b1', 'old');
    queueBar('b2', 's2');

    expect(await syncPendingDrillingBars()).toEqual({ synced: 0, failed: 0 });

    expect(mockCreateBar).not.toHaveBeenCalled();
  });

  it('uploads a bar whose photo the phone lost, and says so in its notes', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1', WELL, {
      photos: ['file:///cache/gone.jpg', 'file:///cache/kept.jpg'],
      notes: 'Napa a 4 m',
    });
    queueBar('b2', 's1');
    mockUploadPhoto
      .mockRejectedValueOnce(new LocalPhotoMissingError('file:///cache/gone.jpg'))
      .mockResolvedValueOnce({ photo: { id: 41, filename: '7/kept.jpg' } });

    expect(await syncPendingDrillingBars()).toEqual({ synced: 2, failed: 0 });

    const sent = mockCreateBar.mock.calls[0][0];
    expect(sent.photo_paths).toEqual([{ id: 41, filename: '7/kept.jpg' }]);
    expect(sent.notes).toBe('Napa a 4 m [1 foto se perdió en este dispositivo antes de subir]');
  });

  it('still retries a photo that failed for any other reason', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1', WELL, { photos: ['file:///cache/a.jpg'] });
    queueBar('b2', 's1');
    mockUploadPhoto.mockRejectedValueOnce(offline());

    expect(await syncPendingDrillingBars()).toEqual({ synced: 0, failed: 1 });

    expect(mockCreateBar).not.toHaveBeenCalled();
    expect(outboxIds()).toEqual(['b1', 'b2']);
  });
});

describe('a shift\'s close waits for its bars', () => {
  it('waits while one of the shift\'s bars is queued, without using a retry', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1');
    queueClose('end1', 's1');

    expect(await syncPendingShiftEnds()).toEqual({ synced: 0, failed: 0 });

    expect(mockEnd).not.toHaveBeenCalled();
    expect(one(`SELECT retries, last_error FROM sync_outbox WHERE id = 'end1'`)).toEqual({ retries: 0, last_error: null });
  });

  it('goes once the bars have uploaded, in the same drain order the app uses', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1');
    queueClose('end1', 's1');

    await syncPendingDrillingBars();
    expect(await syncPendingShiftEnds()).toEqual({ synced: 1, failed: 0 });

    expect(mockCreateBar.mock.invocationCallOrder[0]).toBeLessThan(mockEnd.mock.invocationCallOrder[0]);
    expect(outboxIds()).toEqual([]);
  });

  it('waits while a bar failed in this drain', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1');
    queueClose('end1', 's1');
    mockCreateBar.mockImplementationOnce(async () => { throw offline(); });

    await syncPendingDrillingBars();
    await syncPendingShiftEnds();

    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('recognises a bar whose payload already carries the server\'s shift id', async () => {
    // A phone that queued its start before vc46 has a local id that differs from
    // the server's, and an upload attempt swaps the server's into the bar.
    addShift('local-s1', 'server-s1');
    queueBar('b1', 'server-s1');
    queueClose('end1', 'local-s1');

    await syncPendingShiftEnds();

    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('is not held by a bar the server refused for good', async () => {
    addShift('s1', 's1');
    queueBar('b1', 's1', WELL, { state: 'quarantined', retries: 3 });
    queueClose('end1', 's1');

    expect(await syncPendingShiftEnds()).toEqual({ synced: 1, failed: 0 });
  });

  it('is not held by another shift\'s bar', async () => {
    addShift('s1', 's1');
    addShift('s2', 's2');
    queueBar('b2', 's2');
    queueClose('end1', 's1');

    expect(await syncPendingShiftEnds()).toEqual({ synced: 1, failed: 0 });

    expect(mockEnd).toHaveBeenCalledWith(expect.objectContaining({ shiftId: 's1' }));
  });
});

describe('a shift\'s bars and close wait for its handover (code read S1)', () => {
  it('holds the bars and the close while the handover is still queued', async () => {
    addShift('s1', 's1');
    queue('h1', 'shift_handover', 's1', { shiftId: 's1', items: [] }, { retries: 3, updatedAt: new Date().toISOString() });
    queueBar('b1', 's1');
    queueClose('end1', 's1');

    expect(await syncPendingDrillingBars()).toEqual({ synced: 0, failed: 0 });
    expect(await syncPendingShiftEnds()).toEqual({ synced: 0, failed: 0 });

    expect(mockCreateBar).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('is not held by a handover the server refused for good', async () => {
    addShift('s1', 's1');
    queue('h1', 'shift_handover', 's1', { shiftId: 's1', items: [] }, { state: 'quarantined', retries: 3 });
    queueBar('b1', 's1');

    expect(await syncPendingDrillingBars()).toEqual({ synced: 1, failed: 0 });
  });
});

describe('an auto-close check after the admin force-closed the shift (code read S4)', () => {
  it('clears once the server has the shift closed', async () => {
    addShift('s1', 's1');
    queue('a1', 'shift_auto_close', 's1', { shiftId: 's1', endedAt: '2026-11-08T21:00:00.000Z' });
    mockGetById.mockResolvedValue({ id: 's1', status: 'closed', end_type: 'admin', ended_at: '2026-11-08T15:00:00.000Z' });

    expect(await syncPendingShiftAutoCloses()).toEqual({ synced: 1, failed: 0 });

    expect(outboxIds()).toEqual([]);
  });
});
