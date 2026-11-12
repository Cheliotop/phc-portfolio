import type { DatabaseTransaction, QueryResult } from '../src/db/db';
import {
  migrateV5ToV6,
  PRODUCT_FOUNDATION_SCHEMA_VERSION,
  v6ColumnAdditions,
  v6CreateTablesSQL,
} from '../src/db/migrations/0006_product_foundation';
import { COMPATIBILITY_COLUMNS } from '../src/db/init';
import { createIndexesSQL, createTablesSQL, SCHEMA_VERSION } from '../src/db/schema';
import {
  migrateV9ToV10,
  REJECTED_WORK_SCHEMA_VERSION,
  REJECTED_WORK_TABLE_SQL,
} from '../src/db/migrations/0010_rejected_work_archive';
import {
  migrateV6ToV7,
  SHIFT_OUTBOX_SCHEMA_VERSION,
} from '../src/db/migrations/0007_shift_outbox_state';
import {
  MATERIAL_CONSUMPTION_IDENTITY_SCHEMA_VERSION,
  MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL,
  migrateV7ToV8,
} from '../src/db/migrations/0008_material_consumption_identity';
import {
  migrateV8ToV9,
  PROJECT_SECONDARY_OPERATORS_INDEX_SQL,
  PROJECT_SECONDARY_OPERATORS_TABLE_SQL,
  SECONDARY_OPERATOR_ASSIGNMENTS_SCHEMA_VERSION,
} from '../src/db/migrations/0009_secondary_operator_assignments';
import { migrateV10ToV11, OUTBOX_AUTHOR_SCHEMA_VERSION } from '../src/db/migrations/0011_outbox_author_and_shift_join';

interface MemoryTable {
  columns: Set<string>;
  rows: Array<Record<string, unknown>>;
}

class PopulatedV5Transaction implements DatabaseTransaction {
  readonly tables = new Map<string, MemoryTable>();
  readonly statements: string[] = [];
  userVersion = 5;

  constructor() {
    this.addTable('projects', ['id', 'name', 'target_depth', 'default_bar_length', 'default_bar_diameter', 'coordinates', 'well_name'], [
      { id: 41, name: 'Pozo legado', status: 'En Progreso' },
    ]);
    this.addTable('photos', ['id', 'local_uri', 'movement_id', 'sync_status'], [
      { id: 'photo-v5', local_uri: 'file:///photo-v5.jpg', sync_status: 'pending' },
    ]);
    this.addTable('drilling_bar_entries', ['id', 'server_id', 'project_id', 'operator_id', 'bar_number', 'depth_start', 'depth_end', 'length', 'diameter', 'soil_type', 'timestamp_local', 'sync_status', 'last_error', 'created_at', 'updated_at'], [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `bar-v5-${index + 1}`,
        project_id: 41,
        operator_id: 'operator-v5',
        bar_number: index + 1,
        depth_start: index * 3,
        depth_end: (index + 1) * 3,
      })),
    ]);
    this.addTable('project_materials', ['id', 'project_id', 'material_name', 'initial_quantity', 'current_quantity', 'unit'], [
      { id: 7, project_id: 41, material_name: 'Tuberia', initial_quantity: 20, current_quantity: 18, unit: 'm' },
    ]);
    this.addTable('material_consumption', ['id', 'client_entry_id', 'project_id', 'operator_id', 'material_name', 'quantity_used', 'unit', 'date', 'server_id', 'sync_status', 'last_error'], [
      { id: 9, client_entry_id: 'consumption-v5', project_id: 41, quantity_used: 2, sync_status: 'pending' },
    ]);
    this.addTable('supply_requests', ['id', 'client_entry_id', 'project_id', 'operator_id', 'material', 'quantity', 'approved_by', 'approval_notes', 'server_id', 'sync_status', 'last_error'], [
      { id: 12, client_entry_id: 'pedido-v5', material: 'Cemento', quantity: 3, status: 'Pendiente' },
    ]);
    this.addTable('completion_reports_local', ['id', 'server_id', 'project_id', 'operator_id', 'static_level', 'dynamic_level', 'flow_rate', 'operator_signature', 'admin_signature', 'status', 'sync_status', 'last_error'], [
      { id: 'completion-v5', project_id: 41, static_level: 8.5, status: 'submitted' },
    ]);
  }

  private addTable(name: string, columns: string[], rows: Array<Record<string, unknown>>): void {
    this.tables.set(name, { columns: new Set(columns), rows });
  }

  async execute(sql: string, _params: any[] = []): Promise<QueryResult> {
    this.statements.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    const alterMatch = normalized.match(/^ALTER TABLE "([A-Za-z_][A-Za-z0-9_]*)" ADD COLUMN ([A-Za-z_][A-Za-z0-9_]*)/i);
    if (alterMatch) {
      const table = this.tables.get(alterMatch[1]);
      if (!table) {
        throw new Error(`no such table: ${alterMatch[1]}`);
      }
      if (table.columns.has(alterMatch[2])) {
        throw new Error(`duplicate column: ${alterMatch[2]}`);
      }
      table.columns.add(alterMatch[2]);
      return { changes: 0 };
    }

    const createTableMatch = normalized.match(/^CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/i);
    if (createTableMatch && !this.tables.has(createTableMatch[1])) {
      const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
      const columns = body
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/)?.[1])
        .filter((column): column is string => Boolean(column))
        .filter((column) => !['FOREIGN', 'UNIQUE', 'CHECK', 'PRIMARY'].includes(column.toUpperCase()));
      this.addTable(createTableMatch[1], columns, []);
      return { changes: 0 };
    }

    const versionMatch = normalized.match(/^PRAGMA user_version = (\d+)$/i);
    if (versionMatch) {
      this.userVersion = Number(versionMatch[1]);
    }

    return { changes: 0 };
  }

  async query<Row = any>(sql: string, _params: any[] = []): Promise<Row[]> {
    const pragmaMatch = sql.trim().match(/^PRAGMA table_info\("([A-Za-z_][A-Za-z0-9_]*)"\)$/i);
    if (!pragmaMatch) {
      return [];
    }

    const table = this.tables.get(pragmaMatch[1]);
    return Array.from(table?.columns ?? []).map((name) => ({ name })) as Row[];
  }

  async queryFirst<Row = any>(sql: string, params: any[] = []): Promise<Row | null> {
    return (await this.query<Row>(sql, params))[0] ?? null;
  }
}

const snapshotRows = (transaction: PopulatedV5Transaction): Record<string, unknown> =>
  Object.fromEntries(
    Array.from(transaction.tables.entries()).map(([name, table]) => [
      name,
      JSON.parse(JSON.stringify(table.rows)),
    ]),
  );

describe('SQLite v5 -> v6 product-foundation migration', () => {
  test('preserves populated v5 rows and adds the complete v6 foundation', async () => {
    const transaction = new PopulatedV5Transaction();
    const beforeRows = snapshotRows(transaction);

    await migrateV5ToV6(transaction);

    for (const [tableName, rows] of Object.entries(beforeRows)) {
      expect(transaction.tables.get(tableName)?.rows).toEqual(rows);
    }
    expect(transaction.tables.get('drilling_bar_entries')?.rows).toHaveLength(5);

    expect(transaction.tables.get('drilling_bar_entries')?.columns).toContain('shift_id');
    expect(transaction.tables.get('material_consumption')?.columns).toContain('shift_id');
    expect(transaction.tables.get('photos')?.columns).toContain('shift_id');

    const expectedNewTables = v6CreateTablesSQL.map((sql) =>
      sql.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1],
    );
    for (const tableName of expectedNewTables) {
      expect(tableName).toBeDefined();
      expect(transaction.tables.has(tableName as string)).toBe(true);
    }

    const completionColumns = transaction.tables.get('completion_reports_local')?.columns;
    expect(completionColumns).toBeDefined();
    expect(completionColumns?.has('specific_flow_rate')).toBe(true);
    expect(completionColumns?.has('casing_layout')).toBe(true);
    expect(completionColumns?.has('finalized_at')).toBe(true);

    expect(transaction.userVersion).toBe(PRODUCT_FOUNDATION_SCHEMA_VERSION);
    expect(transaction.statements.at(-1)).toBe(
      `PRAGMA user_version = ${PRODUCT_FOUNDATION_SCHEMA_VERSION}`,
    );
  });

  test('is idempotent when the v6 step is retried after a completed upgrade', async () => {
    const transaction = new PopulatedV5Transaction();
    const expectedAlterCount = Object.entries(v6ColumnAdditions).reduce(
      (total, [tableName, definitions]) => {
        const existingColumns = transaction.tables.get(tableName)?.columns ?? new Set<string>();
        return total + definitions.filter((definition) =>
          !existingColumns.has(definition.trim().split(/\s+/)[0]),
        ).length;
      },
      0,
    );

    await migrateV5ToV6(transaction);
    const rowsAfterFirstRun = snapshotRows(transaction);
    const alterCountAfterFirstRun = transaction.statements.filter((sql) =>
      sql.trim().startsWith('ALTER TABLE'),
    ).length;

    await migrateV5ToV6(transaction);

    expect(snapshotRows(transaction)).toEqual(rowsAfterFirstRun);
    expect(transaction.statements.filter((sql) => sql.trim().startsWith('ALTER TABLE'))).toHaveLength(
      alterCountAfterFirstRun,
    );
    expect(alterCountAfterFirstRun).toBe(expectedAlterCount);
    expect(transaction.userVersion).toBe(PRODUCT_FOUNDATION_SCHEMA_VERSION);
  });
});

describe('compatibility columns', () => {
  // A column added only to COMPATIBILITY_COLUMNS reaches upgraded devices and
  // never fresh installs; added only to CREATE TABLE, the reverse. Both halves
  // silently "work" in whichever case you happen to test, which is how A-6's
  // four-copies-of-one-write bug survived as long as it did.
  it('declares every compatibility column in CREATE TABLE as well', () => {
    const missing: string[] = [];

    for (const [table, definitions] of Object.entries(COMPATIBILITY_COLUMNS)) {
      const createTable = createTablesSQL.find((sql) =>
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql));

      if (!createTable) {
        missing.push(`${table}: no CREATE TABLE in schema.ts`);
        continue;
      }

      for (const definition of definitions) {
        const column = definition.trim().split(/\s+/)[0];
        if (!new RegExp(`^\\s*${column}\\s`, 'm').test(createTable)) {
          missing.push(`${table}.${column}: added on upgrade, missing from CREATE TABLE`);
        }
      }
    }

    expect(missing).toEqual([]);
    expect(createTablesSQL.join('\n')).toContain("state TEXT NOT NULL DEFAULT 'pending'");
  });

  it('keeps the outbox quarantine column non-null with a default so ADD COLUMN is legal', () => {
    // SQLite rejects ALTER TABLE ADD COLUMN for a NOT NULL column with no
    // default. Devices with queued rows would fail to open the database.
    const [definition] = COMPATIBILITY_COLUMNS.sync_outbox;
    expect(definition).toMatch(/NOT NULL/);
    expect(definition).toMatch(/DEFAULT '/);
  });
});

describe('SQLite v6 -> v7 shift outbox migration', () => {
  it('backfills existing auto-closes without changing or deleting shift rows', async () => {
    const execute = jest.fn().mockResolvedValue({ changes: 1 });
    const transaction: DatabaseTransaction = {
      execute,
      query: jest.fn().mockResolvedValue([]),
      queryFirst: jest.fn().mockResolvedValue(null),
    };

    await migrateV6ToV7(transaction);

    expect(SHIFT_OUTBOX_SCHEMA_VERSION).toBe(7);
    expect(execute).toHaveBeenCalledTimes(2);
    const backfill = String(execute.mock.calls[0][0]);
    expect(backfill).toContain("'shift_auto_close'");
    expect(backfill).toContain("s.status = 'report_pending'");
    expect(backfill).toContain("s.end_type = 'auto'");
    expect(backfill).toContain('NOT EXISTS');
    expect(backfill).not.toMatch(/UPDATE\s+shifts|DELETE\s+FROM\s+shifts/i);
    expect(execute.mock.calls[1][0]).toBe(
      `PRAGMA user_version = ${SHIFT_OUTBOX_SCHEMA_VERSION}`,
    );
  });
});

describe('SQLite v7 -> v8 material-consumption identity migration', () => {
  it('creates the partial server_id unique index when existing rows are safe', async () => {
    const execute = jest.fn().mockResolvedValue({ changes: 0 });
    const queryFirst = jest.fn().mockResolvedValue({ duplicate_count: 0 });
    const transaction: DatabaseTransaction = {
      execute,
      query: jest.fn().mockResolvedValue([]),
      queryFirst,
    };

    await migrateV7ToV8(transaction);

    // v8 is a step in the history now, not the head. What must stay true is
    // that a v7 device still lands exactly on 8 (asserted below) and that the
    // head never moves backwards past it.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(MATERIAL_CONSUMPTION_IDENTITY_SCHEMA_VERSION);
    expect(queryFirst).toHaveBeenCalledWith(
      `SELECT COUNT(*) AS duplicate_count
       FROM (
         SELECT server_id
         FROM material_consumption
         WHERE server_id IS NOT NULL
         GROUP BY server_id
         HAVING COUNT(*) > 1
       )`,
    );
    expect(execute).toHaveBeenNthCalledWith(1, MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL);
    expect(MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL).toContain(
      'ON material_consumption(server_id) WHERE server_id IS NOT NULL',
    );
    expect(createIndexesSQL).toContain(MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      `PRAGMA user_version = ${MATERIAL_CONSUMPTION_IDENTITY_SCHEMA_VERSION}`,
    );
  });

  it('leaves duplicate server ids untouched and completes the upgrade without the index', async () => {
    const execute = jest.fn().mockResolvedValue({ changes: 0 });
    const transaction: DatabaseTransaction = {
      execute,
      query: jest.fn().mockResolvedValue([]),
      queryFirst: jest.fn().mockResolvedValue({ duplicate_count: 2 }),
    };

    await migrateV7ToV8(transaction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalledWith(MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL);
    expect(execute).toHaveBeenCalledWith(
      `PRAGMA user_version = ${MATERIAL_CONSUMPTION_IDENTITY_SCHEMA_VERSION}`,
    );
    const mutations = execute.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(mutations).not.toMatch(/UPDATE\s+material_consumption|DELETE\s+FROM\s+material_consumption/i);
  });
});

describe('SQLite v8 -> v9 subcontractor assignment migration', () => {
  it('is the schema version the app now ships', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(SECONDARY_OPERATOR_ASSIGNMENTS_SCHEMA_VERSION);
    expect(SECONDARY_OPERATOR_ASSIGNMENTS_SCHEMA_VERSION).toBe(9);
  });

  it('creates the table for fresh installs and the index for both paths', () => {
    // Upgrades get the table from the createTablesSQL pass that runs before
    // every versioned migration; fresh installs get it from initializeSchema.
    // It has to be in both lists or one of the two paths is missing a table.
    expect(createTablesSQL).toContain(PROJECT_SECONDARY_OPERATORS_TABLE_SQL);
    expect(createIndexesSQL).toContain(PROJECT_SECONDARY_OPERATORS_INDEX_SQL);
  });

  it('declares project_id as INTEGER to match projects.id', () => {
    // projects.id is `INTEGER PRIMARY KEY`. SQLite compares INTEGER 5 to TEXT
    // '5' as unequal, so a TEXT column here would make every membership lookup
    // return nothing — silently restoring the bug, with no error to notice.
    expect(PROJECT_SECONDARY_OPERATORS_TABLE_SQL).toMatch(/project_id\s+INTEGER\s+NOT NULL/);
    expect(PROJECT_SECONDARY_OPERATORS_TABLE_SQL).toMatch(/operator_id\s+TEXT\s+NOT NULL/);
    expect(PROJECT_SECONDARY_OPERATORS_TABLE_SQL).toMatch(/PRIMARY KEY \(project_id, operator_id\)/);
  });

  it('advances the version and touches no field data', async () => {
    const execute = jest.fn().mockResolvedValue({ changes: 0 });
    const transaction: DatabaseTransaction = {
      execute,
      query: jest.fn().mockResolvedValue([]),
      queryFirst: jest.fn().mockResolvedValue(null),
    };

    await migrateV8ToV9(transaction);

    expect(execute).toHaveBeenNthCalledWith(1, PROJECT_SECONDARY_OPERATORS_INDEX_SQL);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      `PRAGMA user_version = ${SECONDARY_OPERATOR_ASSIGNMENTS_SCHEMA_VERSION}`,
    );
    const mutations = execute.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(mutations).not.toMatch(/\b(?:UPDATE|DELETE FROM|DROP)\b/i);
  });
});

describe('SQLite v9 -> v10 rejected work archive', () => {
  it('is the schema version the app now ships', () => {
    expect(SCHEMA_VERSION).toBe(REJECTED_WORK_SCHEMA_VERSION + 1);
    expect(REJECTED_WORK_SCHEMA_VERSION).toBe(10);
  });

  it('creates the archive on fresh installs and before every migration', () => {
    expect(createTablesSQL).toContain(REJECTED_WORK_TABLE_SQL);
    expect(REJECTED_WORK_TABLE_SQL).toMatch(/owner_id TEXT NOT NULL/);
  });

  it('only advances the version and touches no field data', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);

    await migrateV9ToV10({ execute } as any);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(`PRAGMA user_version = ${REJECTED_WORK_SCHEMA_VERSION}`);
  });
});

describe('SQLite v10 -> v11 outbox authorship', () => {
  it('bumps the schema version and adds/backfills author_id from the old outbox owner', async () => {
    expect(SCHEMA_VERSION).toBe(11);
    expect(OUTBOX_AUTHOR_SCHEMA_VERSION).toBe(11);
    const execute = jest.fn().mockResolvedValue({ changes: 1 });
    const query = jest.fn().mockResolvedValue([{ name: 'payload_json' }]);
    await migrateV10ToV11({ execute, query } as any, 'operator-a');
    expect(execute).toHaveBeenNthCalledWith(1, 'ALTER TABLE sync_outbox ADD COLUMN author_id TEXT');
    expect(execute).toHaveBeenNthCalledWith(2,
      'UPDATE sync_outbox SET author_id = ? WHERE author_id IS NULL', ['operator-a']);
    expect(execute).toHaveBeenLastCalledWith('PRAGMA user_version = 11');
  });
});
