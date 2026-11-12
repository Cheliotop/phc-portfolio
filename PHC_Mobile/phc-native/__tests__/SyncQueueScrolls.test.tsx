/**
 * AUTH-13: the sync queue list lives in a ScrollView, so rows past the eighth stay
 * reachable. Refused rows are the ones an operator most needs to see. Real SQLite.
 */
import { render, within } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;

jest.mock('../src/db/db', () => {
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null;
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  return { query, queryFirst, execute, runInTransaction: async (task: any) => task({ query, queryFirst, execute }) };
});
jest.mock('../src/db/index', () => jest.requireMock('../src/db/db'));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutbox: jest.fn(async () => undefined),
  drainOutboxIncludingNew: jest.fn(async () => undefined),
}));

import { SyncQueueModal } from '../src/components/shared/SyncStatusIndicator';

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  for (let n = 1; n <= 10; n += 1) {
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
       VALUES (?, 'completion_v2', ?, 'INSERT', '{}', 3, 'quarantined', ?, ?, ?)`,
    ).run(`row-${n}`, `e${n}`, `Motivo de rechazo ${n}`, `2026-11-08T10:${String(n).padStart(2, '0')}:00Z`, `2026-11-08T10:${String(n).padStart(2, '0')}:00Z`);
  }
});

afterEach(() => mockSqlite.close());

it('renders every queued row, and the list is a ScrollView so the tenth row can be reached', async () => {
  const screen = render(<SyncQueueModal visible onClose={jest.fn()} />);

  await screen.findByText(/Motivo de rechazo 10/, {}, { timeout: 3000 });
  const list = screen.UNSAFE_getByType(ScrollView);
  expect(within(list).getByText(/Motivo de rechazo 10/)).toBeTruthy();
  expect(within(list).getByText(/Motivo de rechazo 9/)).toBeTruthy();
});
