/**
 * One join per (shift, operator) on this device (code read OPA-1, item 6 of the
 * equipo task). Real SQLite with the app's schema.
 */
let mockSqlite: any;

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) =>
    mockSqlite.prepare(sql).get(...params) ?? null;
  return {
    execute, query, queryFirst,
    runInTransaction: async (task: any) => task({ execute, query, queryFirst }),
  };
});

const { DatabaseSync } = require('node:sqlite');
import { queueShiftJoin, pendingShiftJoins } from '../src/sync/shiftJoin';

const OPEN = { id: 's1', project_id: 7, status: 'open' };

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana'), ('partner', 'Beto'), ('outsider', 'Otro')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', 'ana')`).run();
  mockSqlite.prepare(`INSERT INTO project_secondary_operators (project_id, operator_id) VALUES (7, 'partner')`).run();
});

afterEach(() => mockSqlite.close());

it('queues one join per (shift, operator), however many times the screen loads', async () => {
  expect(await queueShiftJoin(OPEN, 'partner')).toBe(true);
  expect(await queueShiftJoin(OPEN, 'partner')).toBe(false);
  expect(await queueShiftJoin(OPEN, 'partner')).toBe(false);

  expect(await pendingShiftJoins('s1')).toEqual([{ id: expect.any(String), author_id: 'partner' }]);
});

it('queues a join for each crew member who signs in on the shift', async () => {
  expect(await queueShiftJoin(OPEN, 'ana')).toBe(true);
  expect(await queueShiftJoin(OPEN, 'partner')).toBe(true);
  expect((await pendingShiftJoins('s1')).map((row) => row.author_id).sort()).toEqual(['ana', 'partner']);
});

it('queues nothing for an operator who is not on the well, or for a shift that is not open', async () => {
  expect(await queueShiftJoin(OPEN, 'outsider')).toBe(false);
  expect(await queueShiftJoin({ ...OPEN, status: 'closed' }, 'partner')).toBe(false);
  expect(await pendingShiftJoins('s1')).toEqual([]);
});
