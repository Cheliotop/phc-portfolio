/**
 * A teammate's bar can take a number this phone gave a bar recorded offline. The
 * server's number wins, and the phone must not get stuck on its own UNIQUE
 * (project_id, bar_number): bars now upload strictly in order, so a stuck bar would
 * hold the well's later bars and its shift's close for good. Real SQLite with the
 * app's schema; only the network is fake.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockCreateBar = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
}));
jest.mock('../src/db/db', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
  query: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params),
  queryFirst: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null,
}));
jest.mock('../src/api/supabase-drilling-bars', () => ({
  drillingBarsApi: { create: (...args: any[]) => mockCreateBar(...args) },
}));
jest.mock('../src/api/supabase-photos', () => ({ photosApi: {} }));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { applySyncedDrillingBar, mirrorServerDrillingBar } from '../src/db/repositories/drillingBars';
import { syncPendingDrillingBars } from '../src/sync/drillingSync';

const WELL = 7;
const numbers = () => Object.fromEntries(
  mockSqlite.prepare(`SELECT id, bar_number FROM drilling_bar_entries ORDER BY id`).all()
    .map((row: any) => [row.id, row.bar_number]),
);

const localBar = (id: string, barNumber: number, serverId: number | null = null) =>
  mockSqlite.prepare(
    `INSERT INTO drilling_bar_entries (id, server_id, project_id, operator_id, shift_id, bar_number,
       depth_start, depth_end, length, soil_type, timestamp_local, sync_status)
     VALUES (?, ?, ?, 'ana', 's1', ?, ?, ?, 3, 'Arcilla', '2026-11-08T10:00:00Z', ?)`,
  ).run(id, serverId, WELL, barNumber, (barNumber - 1) * 3, barNumber * 3, serverId ? 'synced' : 'pending');

const serverBar = (id: number, barNumber: number, clientEntryId: string) => ({
  id, client_entry_id: clientEntryId, project_id: WELL, operator_id: 'ciro', shift_id: 's9',
  bar_number: barNumber, depth_start: (barNumber - 1) * 3, depth_end: barNumber * 3, length: 3,
  diameter: null, soil_type: 'Roca', start_time: null, end_time: null, duration_minutes: null,
  water_level: null, notes: null, photo_paths: null, timestamp_local: '2026-11-08T09:00:00Z',
  created_at: '2026-11-08T09:00:00Z', updated_at: '2026-11-08T09:00:00Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSqlite = new DatabaseSync(':memory:');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana'), ('ciro', 'Ciro')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (?, 'Pozo 7', 'ana')`).run(WELL);
  mockSqlite.prepare(`INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
    VALUES ('s1', 's1', 'e1', ?, 'ana', 'open', '2026-11-08T08:00:00Z')`).run(WELL);
});

afterEach(() => mockSqlite.close());

it('gives a bar the server\'s number even when a later offline bar holds it', async () => {
  localBar('a', 5);
  localBar('b', 6);

  await applySyncedDrillingBar({ id: 'a', serverId: 40, barNumber: 6, updatedAt: '2026-11-08T11:00:00Z' });

  expect(numbers()).toEqual({ a: 6, b: 7 });
});

it('makes room for a teammate\'s bar mirrored from the server', async () => {
  localBar('a', 5);

  await mirrorServerDrillingBar(serverBar(39, 5, 'ciro-bar'));

  expect(numbers()).toEqual({ a: 6, 'ciro-bar': 5 });
});

it('never moves a bar the server already numbered', async () => {
  localBar('done', 5, 38);

  await mirrorServerDrillingBar(serverBar(39, 5, 'ciro-bar'));

  expect(numbers()).toEqual({ done: 5 });
});

it('drops a mirrored copy of the same server bar', async () => {
  localBar('a', 5);
  await mirrorServerDrillingBar(serverBar(40, 6, 'server-copy-of-a'));

  await applySyncedDrillingBar({ id: 'a', serverId: 40, barNumber: 6, updatedAt: '2026-11-08T11:00:00Z' });

  expect(numbers()).toEqual({ a: 6 });
});

it('uploads both offline bars after a teammate took a number, with no error', async () => {
  // Beto recorded 5 and 6 offline; Ciro's bar took 5 on the server meanwhile.
  localBar('a', 5);
  localBar('b', 6);
  const queue = mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
     VALUES (?, 'drilling_bar', ?, 'UPSERT', ?, 0, ?, ?)`,
  );
  queue.run('qa', 'a', JSON.stringify({ project_id: WELL, shift_id: 's1', client_entry_id: 'a', soil_type: 'Arcilla' }),
    '2026-11-08T10:00:01Z', '2026-11-08T10:00:01Z');
  queue.run('qb', 'b', JSON.stringify({ project_id: WELL, shift_id: 's1', client_entry_id: 'b', soil_type: 'Arcilla' }),
    '2026-11-08T10:00:02Z', '2026-11-08T10:00:02Z');
  let next = 6;
  mockCreateBar.mockImplementation(async () => {
    const number = next++;
    return { data: { id: 40 + number, bar_number: number, depth_start: (number - 1) * 3, depth_end: number * 3, length: 3 } };
  });

  expect(await syncPendingDrillingBars()).toEqual({ synced: 2, failed: 0 });

  expect(numbers()).toEqual({ a: 6, b: 7 });
  expect(mockSqlite.prepare(`SELECT COUNT(*) AS n FROM sync_outbox`).get().n).toBe(0);
  expect(mockSqlite.prepare(`SELECT COUNT(*) AS n FROM drilling_bar_entries WHERE last_error IS NOT NULL`).get().n).toBe(0);
});
