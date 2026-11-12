/**
 * The local balance while a close is still queued (code read S7). Real SQLite.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
jest.mock('../src/db/index', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
}));
jest.mock('../src/db/db', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
  query: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params),
  queryFirst: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null,
}));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { mirrorProjectMaterial } from '../src/db/repositories/projectMaterials';

const balance = () => mockSqlite.prepare('SELECT current_quantity AS q FROM project_materials WHERE id = 31').get().q;
const server = { id: 31, project_id: 7, material_name: 'Caño', initial_quantity: 10, current_quantity: 10, unit: 'u', active: true };

beforeEach(async () => {
  mockSqlite = new DatabaseSync(':memory:');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', 'ana')`).run();
  mockSqlite.prepare(`INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at)
    VALUES ('s1', 's1', 'e1', 7, 'ana', 'open', '2026-11-08T08:00:00Z')`).run();
  await mirrorProjectMaterial(server as any);
  // The operator finished the shift offline, using 2.
  mockSqlite.prepare(`INSERT INTO material_consumption (client_entry_id, project_id, operator_id, shift_id, project_material_id,
    material_name, quantity_used, unit, date, sync_status) VALUES ('c1', 7, 'ana', 's1', 31, 'Caño', 2, 'u', '2026-11-08', 'pending')`).run();
  mockSqlite.prepare(`UPDATE project_materials SET current_quantity = 8 WHERE id = 31`).run();
});

afterEach(() => mockSqlite.close());

const queueClose = (state = 'pending') => mockSqlite.prepare(
  `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, created_at, updated_at)
   VALUES ('q1', 'shift_end', 's1', 'UPDATE', '{}', 0, ?, '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
).run(state);

it('keeps the queued usage off the balance the server sends back', async () => {
  queueClose();
  await mirrorProjectMaterial(server as any);
  expect(balance()).toBe(8);
});

it('takes the server figure once the close has landed', async () => {
  mockSqlite.prepare(`UPDATE material_consumption SET sync_status = 'synced'`).run();
  await mirrorProjectMaterial({ ...server, current_quantity: 8 } as any);
  expect(balance()).toBe(8);
});

it('takes the server figure when the close was refused', async () => {
  queueClose('quarantined');
  await mirrorProjectMaterial(server as any);
  expect(balance()).toBe(10);
});
