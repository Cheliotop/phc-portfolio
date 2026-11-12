/**
 * What the header badge counts. Real SQLite with the app's schema.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;

jest.mock('../src/db/db', () => ({
  query: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params),
  queryFirst: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null,
}));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { readQueueStatus } from '../src/sync/queueStatus';

const queue = (id: string, state = 'pending', retries = 0) =>
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, created_at, updated_at)
     VALUES (?, 'drilling_bar', ?, 'UPSERT', '{}', ?, ?, '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
  ).run(id, `bar-${id}`, retries, state);

const reported = (id: string, uploadedAt: string | null) =>
  mockSqlite.prepare(
    `INSERT INTO rejected_work (id, owner_id, entity, archived_at, uploaded_at)
     VALUES (?, 'ana', 'drilling_bar', '2026-11-08T10:01:00Z', ?)`,
  ).run(id, uploadedAt);

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
});

afterEach(() => mockSqlite.close());

it('is empty with nothing queued', async () => {
  expect(await readQueueStatus()).toEqual({ waiting: 0, refused: 0 });
});

it('counts work that failed only for lack of signal as waiting, not refused', async () => {
  queue('a');
  queue('b', 'pending', 3);

  expect(await readQueueStatus()).toEqual({ waiting: 2, refused: 0 });
});

it('counts refused work until it reaches the admin review list', async () => {
  queue('a', 'quarantined', 3);
  queue('b', 'quarantined', 3);
  reported('a', null);
  reported('b', '2026-11-08T10:02:00Z');

  expect(await readQueueStatus()).toEqual({ waiting: 0, refused: 1 });
});
