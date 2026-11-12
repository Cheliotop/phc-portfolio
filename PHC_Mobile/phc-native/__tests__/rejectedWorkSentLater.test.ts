/**
 * Code read S8: refused work reported to the admin review list, then got through
 * by a manual retry. The review list must be told, so the admin doesn't enter it
 * again by hand. Real SQLite with the app's schema; the server is fake.
 */
const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockReport = jest.fn();
const mockMarkSent = jest.fn();

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null;
  return { execute, query, queryFirst, runInTransaction: async (task: any) => task({ execute, query, queryFirst }) };
});
jest.mock('../src/api/supabase-rejected-work', () => ({
  rejectedWorkApi: {
    report: (...args: any[]) => mockReport(...args),
    markSent: (...args: any[]) => mockMarkSent(...args),
  },
}));
jest.mock('../src/sync/outboxOwner', () => ({
  getOutboxOwner: async () => 'ana',
  archiveRejectedRows: jest.requireActual('../src/sync/outboxOwner').archiveRejectedRows,
}));

import { reportRejectedWork } from '../src/sync/rejectedWorkReport';
import { deleteOutbox, resetOutboxForManualRetry } from '../src/db/operations';

const NOW = '2026-11-08T10:00:00Z';
const stamps = () => mockSqlite.prepare('SELECT uploaded_at, sent_at, sent_reported_at FROM rejected_work WHERE id = ?').get('q1');

beforeEach(() => {
  jest.clearAllMocks();
  mockReport.mockResolvedValue(1);
  mockMarkSent.mockResolvedValue(true);
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
     VALUES ('q1', 'pedido_v2', '5', 'INSERT', '{"projectId":7}', 3, 'quarantined', 'refused (22023)', ?, ?)`,
  ).run(NOW, NOW);
});

afterEach(() => mockSqlite.close());

it('archives and reports the original typist after a partner switches accounts', async () => {
  mockSqlite.prepare('UPDATE sync_outbox SET author_id = ? WHERE id = ?').run('bea', 'q1');
  await reportRejectedWork();
  expect(mockReport).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 'bea' }));
  expect(mockSqlite.prepare('SELECT owner_id FROM rejected_work WHERE id = ?').get('q1').owner_id).toBe('bea');
});

it('tells the review list once when a reported refusal gets through on retry', async () => {
  await reportRejectedWork();
  expect(mockReport).toHaveBeenCalledTimes(1);
  expect(stamps().uploaded_at).toBeTruthy();

  await resetOutboxForManualRetry();
  await deleteOutbox('q1'); // the retry got through

  await reportRejectedWork();
  expect(mockMarkSent).toHaveBeenCalledWith('q1');
  expect(stamps().sent_reported_at).toBeTruthy();

  await reportRejectedWork();
  expect(mockMarkSent).toHaveBeenCalledTimes(1);
  expect(mockReport).toHaveBeenCalledTimes(1);
});

it('tries again when the server could not be told', async () => {
  await reportRejectedWork();
  await deleteOutbox('q1');
  mockMarkSent.mockRejectedValueOnce(new Error('offline'));

  await reportRejectedWork();
  expect(stamps().sent_reported_at).toBeNull();

  await reportRejectedWork();
  expect(mockMarkSent).toHaveBeenCalledTimes(2);
  expect(stamps().sent_reported_at).toBeTruthy();
});

it('never reports work that got through before its report went out', async () => {
  mockReport.mockRejectedValueOnce(new Error('offline'));
  await reportRejectedWork();
  expect(stamps().uploaded_at).toBeNull();

  await deleteOutbox('q1');
  await reportRejectedWork();

  expect(mockReport).toHaveBeenCalledTimes(1);
  expect(mockMarkSent).not.toHaveBeenCalled();
});

it('does not call a row sent when it was dropped for another reason', async () => {
  await reportRejectedWork();
  await deleteOutbox('q1', { sent: false });

  await reportRejectedWork();

  expect(stamps().sent_at).toBeNull();
  expect(mockMarkSent).not.toHaveBeenCalled();
});
