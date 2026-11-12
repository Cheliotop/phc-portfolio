import AsyncStorage from '@react-native-async-storage/async-storage';
import { openDb, query, execute, runInTransaction } from './db';
import { createTablesSQL, initializeSchema, SCHEMA_VERSION } from './schema';
import { migrateV5ToV6 } from './migrations/0006_product_foundation';
import { migrateV6ToV7 } from './migrations/0007_shift_outbox_state';
import { migrateV7ToV8 } from './migrations/0008_material_consumption_identity';
import { migrateV8ToV9 } from './migrations/0009_secondary_operator_assignments';
import { migrateV9ToV10 } from './migrations/0010_rejected_work_archive';
import { migrateV10ToV11 } from './migrations/0011_outbox_author_and_shift_join';
import { seedSampleData } from './seedData';
import { log } from '../utils/log';
// import * as FileSystem from 'expo-file-system'; // Temporarily disabled for bundling

/**
 * Database initialization and migration management
 */

/**
 * Initialize the PHC database with proper schema and versioning
 */
export const initializeDatabase = async (): Promise<void> => {
  try {
    log('🚀 PHC Native - Starting database initialization...');

    await openDb();
    log('✅ Database connection established (phc_v2.db)');

    // Check current database version
    const versionInfo = await query<{ user_version: number }>('PRAGMA user_version');
    const currentVersion = versionInfo[0]?.user_version || 0;

    log(`Current database version: ${currentVersion}, Required version: ${SCHEMA_VERSION}`);

    // Check if tables exist
    const tableCount = await query<{ count: number }>(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    const existingTables = tableCount[0]?.count || 0;

    log(`Existing tables count: ${existingTables}`);

    if (currentVersion === 0 || existingTables === 0) {
      // Fresh installation - create all tables
      log('Fresh installation detected, creating schema...');
      await initializeSchema();

      // Set database version
      await execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      log(`Database version set to ${SCHEMA_VERSION}`);

    } else if (currentVersion < SCHEMA_VERSION) {
      // Migration needed
      log(`Migration needed from version ${currentVersion} to ${SCHEMA_VERSION}`);
      await migrateDatabase(currentVersion, SCHEMA_VERSION);

    } else {
      log('Database schema is up to date');
    }

    await ensureCompatibilityColumns();

    // Verify database integrity
    await verifyDatabaseIntegrity();

    if (__DEV__) {
      log('🌱 Development build detected, ensuring sample data exists...');
      await seedSampleData();
      log('✅ Development sample data check completed');
    }

    log('Database initialization completed successfully');

  } catch (error) {
    log('Database initialization failed:', error);
    throw new Error(`Database initialization failed: ${error}`);
  }
};

const ensureColumn = async (tableName: string, definition: string): Promise<void> => {
  const columnName = definition.trim().split(/\s+/)[0];
  const columns = await query<{ name: string }>(`PRAGMA table_info(${tableName})`);

  if (!columns.some((column) => column.name === columnName)) {
    await execute(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
};

/**
 * Columns added to tables that already exist on installed devices. Applied on
 * every launch and idempotent, so it covers upgrades that predate the current
 * schema version without needing one of their own.
 *
 * Every entry here MUST also appear in the table's CREATE TABLE in schema.ts —
 * fresh installs never run this path. `databaseMigration.test.ts` holds the two
 * in step; letting them drift is how a column ends up present on upgraded
 * devices and missing on new ones.
 */
export const COMPATIBILITY_COLUMNS: Record<string, string[]> = {
  projects: [
    'target_depth REAL',
    'default_bar_length REAL DEFAULT 3',
    'default_bar_diameter TEXT',
    'coordinates TEXT',
    'well_name TEXT',
  ],
  supply_requests: [
    'approved_by TEXT',
    'approval_notes TEXT',
  ],
  // W-11(b): quarantine for permanently rejected writes. Added here rather than
  // as a schema-version bump because sync_outbox predates v6 and every v6 device
  // in the field already carries the table without this column. SQLite permits
  // NOT NULL in ADD COLUMN as long as a non-null default is given, so existing
  // queued rows land on 'pending' — exactly their current behaviour.
  sync_outbox: [
    "state TEXT NOT NULL DEFAULT 'pending'",
  ],
  // Code read S8: refused work that a manual retry later got through. `sent_at`
  // is when it reached the server, `sent_reported_at` when the review list was
  // told, so the admin doesn't enter it again by hand.
  rejected_work: [
    'sent_at TEXT',
    'sent_reported_at TEXT',
  ],
};

const ensureCompatibilityColumns = async (): Promise<void> => {
  for (const [tableName, definitions] of Object.entries(COMPATIBILITY_COLUMNS)) {
    for (const definition of definitions) {
      await ensureColumn(tableName, definition);
    }
  }
};

/**
 * Handle database migrations between versions
 */
const migrateDatabase = async (fromVersion: number, toVersion: number): Promise<void> => {
  log(`Migrating database from version ${fromVersion} to ${toVersion}`);

  if (toVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported migration target: ${toVersion}`);
  }

  if (fromVersion < SCHEMA_VERSION) {
    const outboxOwnerId = fromVersion < 11
      ? await AsyncStorage.getItem('phc.outboxOwnerId')
      : null;
    await runInTransaction(async (transaction) => {
      // Ensure every legacy/core table exists before ALTER statements. These
      // are CREATE IF NOT EXISTS only: populated rows are never replaced.
      // Indexes are intentionally deferred until new columns have been added.
      for (const sql of createTablesSQL) {
        await transaction.execute(sql);
      }

      if (fromVersion < 6) {
        await migrateV5ToV6(transaction);
      }
      if (fromVersion < 7) {
        await migrateV6ToV7(transaction);
      }
      if (fromVersion < 8) {
        await migrateV7ToV8(transaction);
      }
      if (fromVersion < 9) {
        await migrateV8ToV9(transaction);
      }
      if (fromVersion < 10) {
        await migrateV9ToV10(transaction);
      }
      if (fromVersion < 11) {
        await migrateV10ToV11(transaction, outboxOwnerId);
      }
    });

    log(`Database migrated to version ${SCHEMA_VERSION}`);
  }
};

/**
 * Verify database integrity and essential tables
 */
const verifyDatabaseIntegrity = async (): Promise<void> => {
  const requiredTables = [
    'operators',
    'projects',
    'photos',
    'sync_outbox',
    'progress_logs_dashboard',
    'drilling_bar_entries',
    'materials_used',
    'supply_requests',
    'material_inventory',
    'project_materials',
    'material_consumption',
    'completion_reports_local',
    'catalog_materials',
    'catalog_variants',
    'shifts',
    'shift_handovers',
    'pedido_items',
    'pedido_receipts',
    'material_reconciliations',
    'water_samples',
    'project_attachments',
    'project_secondary_operators',
  ];

  log('🔍 Verifying database integrity - checking all critical tables...');

  // List all existing tables first
  const allTables = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  log(`📊 Found ${allTables.length} tables in database:`, allTables.map(t => t.name).join(', '));

  let missingTables: string[] = [];
  let existingTables: string[] = [];

  for (const tableName of requiredTables) {
    const tableExists = await query<{ count: number }>(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?",
      [tableName]
    );

    if (tableExists[0]?.count === 0) {
      missingTables.push(tableName);
      log(`❌ MISSING CRITICAL TABLE: ${tableName}`);
    } else {
      existingTables.push(tableName);
      log(`✅ Table ${tableName} exists`);
    }
  }

  if (missingTables.length > 0) {
    const errorMsg = `CRITICAL: Missing required tables: ${missingTables.join(', ')}`;
    log(`🚨 ${errorMsg}`);
    throw new Error(errorMsg);
  }

  log('✅ Database integrity verification passed - all critical tables exist');
  log(`📋 Verified tables: ${existingTables.join(', ')}`);
};
