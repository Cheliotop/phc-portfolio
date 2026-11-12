/**
 * Operador 2 of a shared tablet is not the assigned operator of the well, so the
 * well refresh never wrote their local operator row, and every save that references
 * it failed on the device once foreign keys were enforced (2026-11-09). The refresh
 * now records the signed-in operator's own row, and another operator's stub no
 * longer carries the signed-in operator's name. Real SQLite with foreign keys on.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const { DatabaseSync } = require('node:sqlite');
let mockSqlite: any;

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null;
  return {
    execute, query, queryFirst,
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
jest.mock('../src/db/index', () => jest.requireMock('../src/db/db'));
jest.mock('../src/api/supabase-projects', () => ({
  projectsApi: {
    getAll: async () => [{ id: 5, name: 'Pozo 05', status: 'active', assigned_operator_id: 'op-ana' }],
  },
}));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: {
    getVisibleSecondaryAssignments: async () => [{ project_id: 5, operator_id: 'op-bea' }],
  },
}));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { cacheServerProjects } from '../src/api/projectCache';

const operators = () => mockSqlite.prepare('SELECT id, name FROM operators ORDER BY id').all()
  .map((row: any) => ({ ...row }));

beforeEach(async () => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([
    ['authToken', 'token'], ['userId', 'op-bea'], ['userRole', 'operator'], ['userName', 'Bea'],
  ]);
});

afterEach(() => mockSqlite.close());

it('records operador 2 and leaves operador 1 a neutral stub', async () => {
  await cacheServerProjects();

  expect(operators()).toEqual([
    { id: 'op-ana', name: 'Operador' },
    { id: 'op-bea', name: 'Bea' },
  ]);
});

it('so a record operador 2 saves can reference their row', async () => {
  await cacheServerProjects();

  expect(() => mockSqlite.prepare(
    `INSERT INTO shifts (id, client_entry_id, project_id, operator_id, status, started_at)
     VALUES ('s1', 'e1', 5, 'op-bea', 'open', '2026-11-09T10:00:00.000Z')`,
  ).run()).not.toThrow();
});
