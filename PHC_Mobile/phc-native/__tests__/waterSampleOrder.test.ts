/**
 * Water samples use server-assigned numbers, while queued local samples hold
 * provisional numbers under a per-well UNIQUE constraint. Real SQLite with the
 * app schema; only the network is fake.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockRegisterSample = jest.fn();
const mockUploadPhoto = jest.fn();

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
  };
});
jest.mock('../src/db/index', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
}));
jest.mock('../src/api/supabase-water-samples', () => ({
  waterSamplesApi: { register: (...args: any[]) => mockRegisterSample(...args) },
}));
jest.mock('../src/api/supabase-photos', () => ({
  photosApi: { uploadProjectPhoto: (...args: any[]) => mockUploadPhoto(...args) },
}));
jest.mock('../src/api/supabase-shifts', () => ({ shiftsApi: {} }));
jest.mock('../src/api/supabase-pedidos', () => ({ pedidosApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: {} }));
jest.mock('../src/sync/rejection', () => ({ recordSyncFailure: jest.fn() }));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { syncPendingWaterSamples } from '../src/sync/productV2Sync';

const WELL = 7;
const one = (sql: string, ...params: any[]) => mockSqlite.prepare(sql).get(...params);
const numbers = () => Object.fromEntries(
  mockSqlite.prepare('SELECT id, sample_number FROM water_samples ORDER BY id').all()
    .map((row: any) => [row.id, row.sample_number]),
);
const outboxIds = () => mockSqlite
  .prepare('SELECT id FROM sync_outbox WHERE entity = \'water_sample\' ORDER BY created_at, rowid')
  .all().map((row: any) => row.id);

const queueSample = (id: string, sampleNumber: number, createdAt: string, hasPhoto = false) => {
  mockSqlite.prepare(
    `INSERT INTO water_samples (id, client_entry_id, project_id, sample_number, operator_id, taken_at, sync_status)
     VALUES (?, ?, ?, ?, 'ana', ?, 'pending')`,
  ).run(id, `entry-${id}`, WELL, sampleNumber, createdAt);
  const payload = {
    clientEntryId: `entry-${id}`,
    projectId: WELL,
    takenAt: createdAt,
    sampleNumber,
    ...(hasPhoto ? { bottlePhotoLocalUri: `file:///cache/${id}.jpg` } : {}),
  };
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
     VALUES (?, 'water_sample', ?, 'UPSERT', ?, 0, ?, ?)`,
  ).run(`out-${id}`, id, JSON.stringify(payload), createdAt, createdAt);
};

const offline = () => Object.assign(new TypeError('Network request failed'));

beforeEach(() => {
  jest.clearAllMocks();
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare("INSERT INTO operators (id, name) VALUES ('ana', 'Ana')").run();
  mockSqlite.prepare("INSERT INTO projects (id, name, assigned_operator_id) VALUES (?, 'Pozo 7', 'ana')")
    .run(WELL);
});

afterEach(() => mockSqlite.close());

it('sends samples for a well in local order and recovers an accepted sample whose number conflicted', async () => {
  const earlier = '2026-11-08T10:00:00.000Z';
  const later = '2026-11-08T10:01:00.000Z';
  queueSample('sample-3', 3, earlier, true);
  queueSample('sample-4', 4, later);

  // This is the finding's starting condition: the later sample already exists
  // remotely as #3, but its old local apply failed on UNIQUE(project_id, sample_number).
  const accepted = { id: 42, sample_number: 3, bottle_photo_path: null, device_time_flag: false };
  mockUploadPhoto
    .mockRejectedValueOnce(offline())
    .mockResolvedValueOnce({ photo: { filename: '7/sample-3.jpg' } });
  mockRegisterSample.mockImplementation(async (payload: any) => {
    if (payload.clientEntryId === 'entry-sample-3') {
      return { id: 41, sample_number: 4, bottle_photo_path: null, device_time_flag: false };
    }
    return accepted;
  });

  expect(await syncPendingWaterSamples()).toMatchObject({ synced: 0, failed: 1 });
  expect(mockRegisterSample).not.toHaveBeenCalled();
  expect(outboxIds()).toEqual(['out-sample-3', 'out-sample-4']);

  expect(await syncPendingWaterSamples()).toMatchObject({ synced: 2, failed: 0 });

  expect(mockRegisterSample.mock.calls.map(([payload]) => payload.clientEntryId))
    .toEqual(['entry-sample-3', 'entry-sample-4']);
  expect(numbers()).toEqual({ 'sample-3': 4, 'sample-4': 3 });
  expect(one('SELECT sync_status, server_id FROM water_samples WHERE id = \'sample-3\'')).toEqual({
    sync_status: 'synced', server_id: 41,
  });
  expect(one('SELECT sync_status, server_id FROM water_samples WHERE id = \'sample-4\'')).toEqual({
    sync_status: 'synced', server_id: 42,
  });
  expect(outboxIds()).toEqual([]);
});

it('does not let a later sample pass an earlier sample that is cooling down', async () => {
  queueSample('sample-3', 3, '2026-11-08T10:00:00.000Z');
  queueSample('sample-4', 4, '2026-11-08T10:01:00.000Z');
  mockSqlite.prepare("UPDATE sync_outbox SET retries = 3, updated_at = ? WHERE id = 'out-sample-3'")
    .run(new Date().toISOString());

  expect(await syncPendingWaterSamples()).toMatchObject({ synced: 0, failed: 0 });

  expect(mockRegisterSample).not.toHaveBeenCalled();
  expect(outboxIds()).toEqual(['out-sample-3', 'out-sample-4']);
});
