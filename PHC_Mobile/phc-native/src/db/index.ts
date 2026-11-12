// Core database functions
export { openDb, execute, query, queryFirst } from './db';
export type { QueryResult } from './db';

// Schema and initialization
export { initializeSchema, createTablesSQL, createIndexesSQL, SCHEMA_VERSION } from './schema';
export { initializeDatabase } from './init';

// Migration functions
export { runMigrations } from './migrations';
