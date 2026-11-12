/**
 * SYNC-7: a well that stays assigned to the signed-in operator on this phone, but
 * that the server no longer lists for them, must stop listing for them. Another
 * operator's wells on the same tablet must not be touched, and nothing is deleted.
 * Real SQLite, so the UPDATE is checked against the actual schema.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const { DatabaseSync } = require('node:sqlite');
let mockSqlite: any;
let mockServerRows: any[] = [];
let mockSecondaryRows: any[] = [];

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
  projectsApi: { getAll: async () => mockServerRows },
}));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: { getVisibleSecondaryAssignments: async () => mockSecondaryRows },
}));

import { createTablesSQL, createIndexesSQL } from '../src/db/schema';
import { cacheServerProjects } from '../src/api/projectCache';

const ownWell = { id: 9, name: 'Pozo 9', assigned_operator_id: 'op-bea', status: 'active' };
const otherWell = { id: 8, name: 'Pozo 8', assigned_operator_id: 'op-ana', status: 'active' };
const stillOwn = { id: 5, name: 'Pozo 5', assigned_operator_id: 'op-bea', status: 'active' };

const localAssignments = () => Object.fromEntries(
  mockSqlite.prepare('SELECT id, assigned_operator_id FROM projects ORDER BY id').all()
    .map((row: any) => [row.id, row.assigned_operator_id]),
);

beforeEach(async () => {
  mockSecondaryRows = [];
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([
    ['authToken', 'token'], ['userId', 'op-bea'], ['userRole', 'operator'], ['userName', 'Bea'],
  ]);
});

it('preserves another crew member\'s offline assignments when refreshing a different account', async () => {
  mockServerRows = [ownWell, otherWell, stillOwn];
  mockSecondaryRows = [{ project_id: 8, operator_id: 'op-bea' }];
  await cacheServerProjects();
  await AsyncStorage.multiSet([['userId', 'op-cora'], ['userName', 'Cora']]);
  mockServerRows = [{ id: 12, name: 'Pozo 12', assigned_operator_id: 'op-cora', status: 'active' }];
  mockSecondaryRows = [];
  await cacheServerProjects();
  expect(mockSqlite.prepare('SELECT project_id, operator_id FROM project_secondary_operators').all())
    .toEqual([{ project_id: 8, operator_id: 'op-bea' }]);
});

it('removes revoked secondary memberships only within the current account\'s visibility', async () => {
  mockServerRows = [ownWell, otherWell];
  mockSecondaryRows = [{ project_id: 8, operator_id: 'op-bea' }, { project_id: 9, operator_id: 'op-ana' }];
  await cacheServerProjects();
  mockSecondaryRows = [];
  await cacheServerProjects();
  expect(mockSqlite.prepare('SELECT * FROM project_secondary_operators').all()).toEqual([]);
});

afterEach(() => mockSqlite.close());

it('unassigns the signed-in operator from an absent well, keeps the row, and leaves another operator\'s well alone', async () => {
  mockServerRows = [ownWell, otherWell, stillOwn];
  await cacheServerProjects();
  expect(localAssignments()).toEqual({ 5: 'op-bea', 8: 'op-ana', 9: 'op-bea' });

  // The server now lists only well 5 for this operator.
  mockServerRows = [stillOwn];
  await cacheServerProjects();

  expect(localAssignments()).toEqual({ 5: 'op-bea', 8: 'op-ana', 9: null });
});

it('keeps every assignment when the server still lists them', async () => {
  mockServerRows = [ownWell, stillOwn];
  await cacheServerProjects();
  await cacheServerProjects();

  expect(localAssignments()).toEqual({ 5: 'op-bea', 9: 'op-bea' });
});

it('does not delete an absent well, so local field data that references it still resolves', async () => {
  mockServerRows = [ownWell, stillOwn];
  await cacheServerProjects();
  mockServerRows = [stillOwn];
  await cacheServerProjects();

  expect(Object.keys(localAssignments())).toEqual(['5', '9']);
  expect(localAssignments()[9]).toBeNull();
});

it('never trusts an empty list: a request that lost its session gets 200 with no rows', async () => {
  mockServerRows = [ownWell, stillOwn];
  await cacheServerProjects();
  mockServerRows = [];
  await cacheServerProjects();

  expect(localAssignments()).toEqual({ 5: 'op-bea', 9: 'op-bea' });
});
