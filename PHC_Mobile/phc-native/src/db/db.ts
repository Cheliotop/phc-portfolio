import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

const DATABASE_NAME = 'phc_v2.db';
/** How long a write waits for another connection's lock before SQLite gives up. */
const TRANSACTION_BUSY_TIMEOUT_MS = 5000;

let db: SQLiteDatabase | null = null;
let isConnecting = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_RETRY_DELAY = 1000;

export interface QueryResult {
  lastInsertRowId?: number;
  changes: number;
}

export interface DatabaseError extends Error {
  code?: string;
  details?: any;
}

/**
 * Restricted database surface passed into an exclusive transaction. Using
 * this adapter (instead of the global helpers) guarantees every statement is
 * executed on Expo SQLite's transaction connection.
 */
export interface DatabaseTransaction {
  execute(sql: string, params?: any[]): Promise<QueryResult>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryFirst<T = any>(sql: string, params?: any[]): Promise<T | null>;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const openDb = async (): Promise<SQLiteDatabase> => {
  if (db) {
    return db;
  }

  if (isConnecting) {
    // Wait for existing connection attempt
    while (isConnecting && connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      await delay(100);
    }
    if (db) return db;
  }

  isConnecting = true;

  try {
    while (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      try {
        const opened = await openDatabaseAsync(DATABASE_NAME);
        // SQLite leaves foreign-key enforcement disabled per connection even
        // when tables declare REFERENCES clauses. Without this, orphan shifts,
        // receipts, attachments, and material rows can be inserted silently.
        // Existing rows are not retroactively rejected; all new writes are.
        await opened.execAsync('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        db = opened;
        connectionAttempts = 0;
        return db;
      } catch (error) {
        connectionAttempts++;
        console.error(`[PHC] Database connection attempt ${connectionAttempts} failed:`, error);

        if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
          const dbError: DatabaseError = new Error(`Failed to connect to database after ${MAX_CONNECTION_ATTEMPTS} attempts`);
          dbError.code = 'CONNECTION_FAILED';
          dbError.details = error;
          throw dbError;
        }

        await delay(CONNECTION_RETRY_DELAY * connectionAttempts);
      }
    }

    throw new Error('Unexpected database connection failure');
  } finally {
    isConnecting = false;
  }
};

export const execute = async (sql: string, params: any[] = []): Promise<QueryResult> => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const database = await openDb();

      // Validate SQL and parameters
      if (!sql || typeof sql !== 'string') {
        throw new Error('Invalid SQL query: must be a non-empty string');
      }

      if (!Array.isArray(params)) {
        throw new Error('Invalid parameters: must be an array');
      }

      const result = await database.runAsync(sql, params);
      return result;
    } catch (error: any) {
      console.error(`[PHC] SQL execution attempt ${attempt} failed:`, error);

      // Check if this is a retryable error
      const isRetryable = error.message?.includes('database is locked') ||
                         error.message?.includes('busy') ||
                         error.code === 'SQLITE_BUSY';

      if (attempt < MAX_RETRIES && isRetryable) {
        await delay(RETRY_DELAY * attempt);
        continue;
      }

      // Create detailed error for non-retryable errors or max retries reached
      const dbError: DatabaseError = new Error(`SQL execution failed: ${error.message}`);
      dbError.code = error.code || 'SQL_ERROR';
      dbError.details = { sql, params, originalError: error };
      throw dbError;
    }
  }

  throw new Error('Unexpected error in execute function');
};

export const query = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const database = await openDb();

      // Validate SQL and parameters
      if (!sql || typeof sql !== 'string') {
        throw new Error('Invalid SQL query: must be a non-empty string');
      }

      if (!Array.isArray(params)) {
        throw new Error('Invalid parameters: must be an array');
      }

      const result = await database.getAllAsync<T>(sql, params);
      return result || [];
    } catch (error: any) {
      console.error(`[PHC] SQL query attempt ${attempt} failed:`, error);

      // Check if this is a retryable error
      const isRetryable = error.message?.includes('database is locked') ||
                         error.message?.includes('busy') ||
                         error.code === 'SQLITE_BUSY';

      if (attempt < MAX_RETRIES && isRetryable) {
        await delay(RETRY_DELAY * attempt);
        continue;
      }

      // Create detailed error for non-retryable errors or max retries reached
      const dbError: DatabaseError = new Error(`SQL query failed: ${error.message}`);
      dbError.code = error.code || 'SQL_QUERY_ERROR';
      dbError.details = { sql, params, originalError: error };
      throw dbError;
    }
  }

  throw new Error('Unexpected error in query function');
};

export const queryFirst = async <T = any>(sql: string, params: any[] = []): Promise<T | null> => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const database = await openDb();

      // Validate SQL and parameters
      if (!sql || typeof sql !== 'string') {
        throw new Error('Invalid SQL query: must be a non-empty string');
      }

      if (!Array.isArray(params)) {
        throw new Error('Invalid parameters: must be an array');
      }

      const result = await database.getFirstAsync<T>(sql, params);
      return result || null;
    } catch (error: any) {
      console.error(`[PHC] SQL queryFirst attempt ${attempt} failed:`, error);

      // Check if this is a retryable error
      const isRetryable = error.message?.includes('database is locked') ||
                         error.message?.includes('busy') ||
                         error.code === 'SQLITE_BUSY';

      if (attempt < MAX_RETRIES && isRetryable) {
        await delay(RETRY_DELAY * attempt);
        continue;
      }

      // Create detailed error for non-retryable errors or max retries reached
      const dbError: DatabaseError = new Error(`SQL queryFirst failed: ${error.message}`);
      dbError.code = error.code || 'SQL_QUERY_FIRST_ERROR';
      dbError.details = { sql, params, originalError: error };
      throw dbError;
    }
  }

  throw new Error('Unexpected error in queryFirst function');
};

/**
 * Execute a unit of work in a single SQLite transaction.
 *
 * The transaction runs on its own connection, so statements on the shared
 * connection cannot slip inside it. expo-sqlite's helper opens that connection
 * with no busy timeout, which failed any save that overlapped a background drain
 * with "database is locked". So this opens the connection itself, sets the
 * timeout, and takes the write lock up front (BEGIN IMMEDIATE) so waiting
 * happens once, at the start, under the timeout. Foreign keys stay off here, as
 * they were with the helper: see the note below.
 *
 * Callers must use the supplied transaction object; calling the module-level
 * execute/query helpers inside the callback would escape the transaction.
 */
export const runInTransaction = async <T>(
  task: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> => {
  // Ensures the database is open (with retries) before a second connection
  // is created for the transaction.
  await openDb();
  const connection = await openDatabaseAsync(DATABASE_NAME, { useNewConnection: true });

  try {
    // Foreign keys stay off on this connection, as they always were with expo's
    // helper (said explicitly rather than left to the build's default). Turning them on (2026-11-09) made every save by operador 2 of a shared
    // tablet fail on device, because records reference parent rows the tablet may
    // not hold yet (their own operator row, catalog or pedido rows not cached). An
    // orphan row can be repaired; a refused save loses the field record.
    await connection.execAsync(
      `PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = ${TRANSACTION_BUSY_TIMEOUT_MS};`,
    );

    try {
      await connection.execAsync('BEGIN IMMEDIATE');
    } catch (error: any) {
      const message = String(error?.message ?? '');
      if (/locked|busy/i.test(message)) {
        const busy: DatabaseError = new Error('La base del dispositivo está ocupada. Intentá de nuevo en unos segundos.');
        busy.code = 'SQLITE_BUSY';
        busy.details = { originalError: error };
        throw busy;
      }
      throw error;
    }

    const validate = (sql: string, params: any[]): void => {
      if (!sql || typeof sql !== 'string') {
        throw new Error('Invalid SQL query: must be a non-empty string');
      }

      if (!Array.isArray(params)) {
        throw new Error('Invalid parameters: must be an array');
      }
    };

    const transaction: DatabaseTransaction = {
      execute: async (sql, params = []) => {
        validate(sql, params);
        return connection.runAsync(sql, params);
      },
      query: async <Row = any>(sql: string, params: any[] = []) => {
        validate(sql, params);
        return connection.getAllAsync<Row>(sql, params);
      },
      queryFirst: async <Row = any>(sql: string, params: any[] = []) => {
        validate(sql, params);
        return connection.getFirstAsync<Row>(sql, params);
      },
    };

    let taskResult: T;
    try {
      taskResult = await task(transaction);
      await connection.execAsync('COMMIT');
    } catch (error) {
      await connection.execAsync('ROLLBACK').catch(() => undefined);
      throw error;
    }
    return taskResult;
  } finally {
    await connection.closeAsync().catch(() => undefined);
  }
};

// Health check function to verify database connectivity
export const healthCheck = async (): Promise<boolean> => {
  try {
    await query('SELECT 1 as health_check');
    return true;
  } catch (error) {
    console.error('[PHC] Database health check failed:', error);
    return false;
  }
};

// Reset connection (useful for recovery scenarios)
export const resetConnection = async (): Promise<void> => {
  db = null;
  connectionAttempts = 0;
  isConnecting = false;
  await openDb();
};
