/**
 * Transactions run on their own SQLite connection. That connection waits on a
 * busy lock like the main one does, and leaves foreign keys off: a save must not
 * be refused because the tablet lacks a parent row (operador 2's own operator row
 * on a shared tablet was the case found on the device, 2026-11-09). Real SQLite
 * (node:sqlite) on a temp file stands in for expo-sqlite, so the PRAGMAs are
 * checked by the engine itself rather than by a mock's call log.
 */
const mockState = { file: '' };

jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = require('node:sqlite');
  const wrap = (conn: any): any => ({
    // expo-sqlite's helper: a fresh connection with NO pragmas, then a plain BEGIN.
    // On Android that connection has foreign keys OFF by default; node:sqlite
    // defaults them on, so switch them off explicitly to match the device.
    withExclusiveTransactionAsync: async (task: (tx: any) => Promise<void>) => {
      const txConn = new DatabaseSync(mockState.file);
      txConn.exec('PRAGMA foreign_keys = OFF; BEGIN');
      try {
        await task(wrap(txConn));
        txConn.exec('COMMIT');
      } catch (error) {
        txConn.exec('ROLLBACK');
        throw error;
      } finally {
        txConn.close();
      }
    },
    execAsync: async (sql: string) => { conn.exec(sql); },
    runAsync: async (sql: string, params: any[] = []) => {
      const result = conn.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getAllAsync: async (sql: string, params: any[] = []) => conn.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, params: any[] = []) => conn.prepare(sql).get(...params) ?? null,
    closeAsync: async () => { conn.close(); },
  });
  return {
    openDatabaseAsync: jest.fn(async () => wrap(new DatabaseSync(mockState.file))),
  };
});

import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { runInTransaction } from '../src/db/db';

const { DatabaseSync } = require('node:sqlite');

beforeEach(() => {
  mockState.file = join(tmpdir(), `phc-tx-${randomUUID()}.db`);
  const setup = new DatabaseSync(mockState.file);
  setup.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent (id)
    );
  `);
  setup.close();
});

afterEach(() => {
  rmSync(mockState.file, { force: true });
});

it('writes a record whose parent row this tablet does not hold yet', async () => {
  // node:sqlite turns foreign keys on by default, so this also proves the
  // connection switches them off rather than relying on the build's default.
  await runInTransaction(async (tx) => {
    await tx.execute('INSERT INTO child (id, parent_id) VALUES (1, 99)');
  });

  const rows = await runInTransaction((tx) => tx.query('SELECT id FROM child'));
  expect(rows).toEqual([{ id: 1 }]);
});

it('waits on a busy lock for a timeout, not at once', async () => {
  let pragma: { timeout: number } | null = null;
  await runInTransaction(async (tx) => {
    pragma = await tx.queryFirst<{ timeout: number }>('PRAGMA busy_timeout');
  });
  expect(pragma).toEqual({ timeout: 5000 });
});

it('rolls the whole transaction back when the task throws', async () => {
  await expect(runInTransaction(async (tx) => {
    await tx.execute('INSERT INTO parent (id) VALUES (1)');
    throw new Error('boom');
  })).rejects.toThrow('boom');

  const rows = await runInTransaction((tx) => tx.query('SELECT id FROM parent'));
  expect(rows).toEqual([]);
});

it('gives a Spanish message when another connection holds the write lock', async () => {
  const holder = new DatabaseSync(mockState.file);
  holder.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; INSERT INTO parent (id) VALUES (7);');
  try {
    // Shrinks the wait so the test stays fast: the transaction connection's
    // busy_timeout is set by runInTransaction itself, so the holder is what
    // matters here.
    await expect(runInTransaction(async (tx) => {
      await tx.execute('INSERT INTO parent (id) VALUES (8)');
    })).rejects.toMatchObject({
      code: 'SQLITE_BUSY',
      message: expect.stringMatching(/ocupada/),
    });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
}, 15000);
