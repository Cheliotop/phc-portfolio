import type { DatabaseTransaction } from '../db';

/**
 * SQLite v6 is the offline foundation for the 2026-07-10 product plan.
 *
 * Existing operational rows predate shifts, so all new references added to
 * populated tables are nullable. New offline-created entities use a local
 * TEXT id plus nullable server_id/client_entry_id sync metadata.
 */
export const PRODUCT_FOUNDATION_SCHEMA_VERSION = 6;

export type ColumnAdditions = Readonly<Record<string, readonly string[]>>;

/**
 * Definitions added to tables that already exist in v5. Do not put UNIQUE in
 * an ALTER TABLE definition: SQLite rejects adding a UNIQUE column. Uniqueness
 * needed by the new model is provided by indexes below.
 */
export const v6ColumnAdditions: ColumnAdditions = {
  projects: [
    'target_depth REAL',
    'default_bar_length REAL DEFAULT 3',
    'default_bar_diameter TEXT',
    'coordinates TEXT',
    'well_name TEXT',
  ],
  photos: [
    'shift_id TEXT',
  ],
  drilling_bar_entries: [
    'shift_id TEXT',
  ],
  project_materials: [
    "layer TEXT NOT NULL DEFAULT 'extras'",
    'catalog_variant_id INTEGER',
    'catalog_variant_local_id TEXT',
    'active INTEGER NOT NULL DEFAULT 1',
  ],
  material_consumption: [
    'client_entry_id TEXT',
    'server_id INTEGER',
    "sync_status TEXT DEFAULT 'pending'",
    'last_error TEXT',
    'shift_id TEXT',
    'approximate INTEGER NOT NULL DEFAULT 0',
    'anomaly_flag INTEGER NOT NULL DEFAULT 0',
  ],
  supply_requests: [
    'client_entry_id TEXT',
    'approved_by TEXT',
    'approval_notes TEXT',
    'server_id INTEGER',
    "sync_status TEXT DEFAULT 'pending'",
    'last_error TEXT',
    "kind TEXT NOT NULL DEFAULT 'empresa'",
    'justification TEXT',
    'closed_manually INTEGER NOT NULL DEFAULT 0',
    'closed_by TEXT',
    'closed_at TEXT',
  ],
  completion_reports_local: [
    'client_entry_id TEXT',
    'format_version INTEGER NOT NULL DEFAULT 1',
    'specific_flow_rate REAL',
    'maximum_flow_rate REAL',
    'pump_depth_m REAL',
    'specific_flow_overridden INTEGER NOT NULL DEFAULT 0',
    'hydraulic_mismatch INTEGER NOT NULL DEFAULT 0',
    'exploration_depth_m REAL',
    'widening_depth_m REAL',
    'casing_total_m REAL',
    'casing_above_ground_m REAL',
    'blind_casing_m REAL',
    'filter_casing_m REAL',
    'sediment_trap_m REAL',
    'centralizer_count INTEGER',
    'bottom_plug_details TEXT',
    'bentonite_quantity REAL',
    'gravel_quantity REAL',
    "casing_layout TEXT NOT NULL DEFAULT '[]'",
    'submitted_at TEXT',
    'finalized_at TEXT',
  ],
};

export const v6CreateTablesSQL = [
  `CREATE TABLE IF NOT EXISTS catalog_materials (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    name TEXT NOT NULL,
    normalized_name TEXT,
    external_code TEXT,
    material_type TEXT NOT NULL DEFAULT 'consumable',
    unit TEXT NOT NULL,
    measurement_method TEXT NOT NULL DEFAULT 'quantity',
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS catalog_variants (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    material_id TEXT NOT NULL,
    material_server_id INTEGER,
    display_name TEXT NOT NULL,
    normalized_name TEXT,
    external_code TEXT,
    diameter TEXT,
    length_m REAL,
    dimension_text TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (material_id) REFERENCES catalog_materials(id)
  )`,

  `CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT UNIQUE,
    client_entry_id TEXT UNIQUE,
    project_id INTEGER NOT NULL,
    operator_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    start_device_time TEXT,
    end_device_time TEXT,
    end_type TEXT,
    usage_report_submitted INTEGER NOT NULL DEFAULT 0,
    handover_confirmed INTEGER NOT NULL DEFAULT 0,
    device_time_flag INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )`,

  `CREATE TABLE IF NOT EXISTS shift_handovers (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    shift_id TEXT NOT NULL,
    project_material_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    expected_quantity REAL NOT NULL,
    observed_quantity REAL,
    note TEXT,
    photo_path TEXT,
    confirmed_by TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (shift_id, project_material_id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
    FOREIGN KEY (project_material_id) REFERENCES project_materials(id)
  )`,

  `CREATE TABLE IF NOT EXISTS pedido_items (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    pedido_id INTEGER,
    pedido_server_id INTEGER,
    catalog_variant_id INTEGER,
    catalog_variant_local_id TEXT,
    material_name_snapshot TEXT NOT NULL,
    requested_quantity REAL NOT NULL,
    unit_snapshot TEXT NOT NULL DEFAULT 'unidad',
    state TEXT NOT NULL DEFAULT 'solicitado',
    approved_quantity REAL,
    received_quantity REAL NOT NULL DEFAULT 0,
    layer TEXT NOT NULL DEFAULT 'extras',
    decision_reason TEXT,
    incident_note TEXT,
    decided_by TEXT,
    decided_at TEXT,
    closed_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pedido_id) REFERENCES supply_requests(id),
    FOREIGN KEY (catalog_variant_local_id) REFERENCES catalog_variants(id)
  )`,

  `CREATE TABLE IF NOT EXISTS pedido_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    pedido_item_id TEXT NOT NULL,
    pedido_item_server_id INTEGER,
    outcome TEXT NOT NULL,
    quantity_received REAL NOT NULL DEFAULT 0,
    incident_note TEXT,
    confirmed_by TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pedido_item_id) REFERENCES pedido_items(id)
  )`,

  `CREATE TABLE IF NOT EXISTS material_reconciliations (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    project_id INTEGER NOT NULL,
    project_material_id INTEGER NOT NULL,
    sent_quantity REAL NOT NULL,
    consumed_quantity REAL NOT NULL DEFAULT 0,
    returned_quantity REAL NOT NULL,
    missing_quantity REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, project_material_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (project_material_id) REFERENCES project_materials(id)
  )`,

  `CREATE TABLE IF NOT EXISTS water_samples (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    project_id INTEGER NOT NULL,
    sample_number INTEGER NOT NULL,
    depth_m REAL,
    stage TEXT,
    operator_id TEXT NOT NULL,
    notes TEXT,
    bottle_photo_path TEXT,
    taken_at TEXT NOT NULL,
    timestamp_local TEXT,
    device_time_flag INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, sample_number),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )`,

  `CREATE TABLE IF NOT EXISTS project_attachments (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER UNIQUE,
    client_entry_id TEXT UNIQUE,
    project_id INTEGER NOT NULL,
    water_sample_id TEXT,
    water_sample_server_id INTEGER,
    kind TEXT NOT NULL,
    storage_path TEXT,
    local_uri TEXT,
    filename TEXT,
    mime_type TEXT,
    notes TEXT,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (water_sample_id) REFERENCES water_samples(id)
  )`,
];

export const v6CreateIndexesSQL = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_materials_normalized_name ON catalog_materials(normalized_name) WHERE normalized_name IS NOT NULL',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_materials_external_code ON catalog_materials(external_code COLLATE NOCASE) WHERE external_code IS NOT NULL AND external_code <> ''",
  'CREATE INDEX IF NOT EXISTS idx_catalog_materials_active ON catalog_materials(active, name)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_variants_material_name ON catalog_variants(material_id, normalized_name) WHERE normalized_name IS NOT NULL',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_variants_external_code ON catalog_variants(external_code COLLATE NOCASE) WHERE external_code IS NOT NULL AND external_code <> ''",
  'CREATE INDEX IF NOT EXISTS idx_catalog_variants_material ON catalog_variants(material_id, active)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_unresolved_operator ON shifts(operator_id) WHERE status IN ('open', 'report_pending')",
  'CREATE INDEX IF NOT EXISTS idx_shifts_project_started ON shifts(project_id, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_shifts_operator_started ON shifts(operator_id, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_shifts_sync_status ON shifts(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_shift_handovers_shift ON shift_handovers(shift_id)',
  'CREATE INDEX IF NOT EXISTS idx_shift_handovers_sync_status ON shift_handovers(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_drilling_bar_entries_shift_id ON drilling_bar_entries(shift_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_consumption_shift_id ON material_consumption(shift_id)',
  'CREATE INDEX IF NOT EXISTS idx_photos_shift_id ON photos(shift_id)',
  'CREATE INDEX IF NOT EXISTS idx_project_materials_layer ON project_materials(project_id, layer)',
  'CREATE INDEX IF NOT EXISTS idx_project_materials_catalog_variant ON project_materials(catalog_variant_id)',
  'CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido_state ON pedido_items(pedido_id, state)',
  'CREATE INDEX IF NOT EXISTS idx_pedido_items_sync_status ON pedido_items(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_pedido_receipts_item ON pedido_receipts(pedido_item_id, confirmed_at)',
  'CREATE INDEX IF NOT EXISTS idx_pedido_receipts_sync_status ON pedido_receipts(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_material_reconciliations_project ON material_reconciliations(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_reconciliations_sync_status ON material_reconciliations(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_water_samples_project_taken ON water_samples(project_id, taken_at)',
  'CREATE INDEX IF NOT EXISTS idx_water_samples_sync_status ON water_samples(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_project_attachments_project_uploaded ON project_attachments(project_id, uploaded_at)',
  'CREATE INDEX IF NOT EXISTS idx_project_attachments_sync_status ON project_attachments(sync_status)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_reports_local_client_entry_id ON completion_reports_local(client_entry_id) WHERE client_entry_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_material_consumption_client_entry_id ON material_consumption(client_entry_id) WHERE client_entry_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_requests_client_entry_id ON supply_requests(client_entry_id) WHERE client_entry_id IS NOT NULL',
];

const quoteIdentifier = (identifier: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }

  return `"${identifier}"`;
};

const ensureColumn = async (
  transaction: DatabaseTransaction,
  tableName: string,
  definition: string,
): Promise<void> => {
  const quotedTable = quoteIdentifier(tableName);
  const columnName = definition.trim().split(/\s+/)[0];
  const columns = await transaction.query<{ name: string }>(`PRAGMA table_info(${quotedTable})`);

  if (columns.length === 0) {
    throw new Error(`Cannot migrate missing v5 table: ${tableName}`);
  }

  if (!columns.some((column) => column.name === columnName)) {
    await transaction.execute(`ALTER TABLE ${quotedTable} ADD COLUMN ${definition}`);
  }
};

/**
 * Apply v5 -> v6 using the transaction supplied by the migration runner.
 * Every operation is idempotent so an interrupted app launch can safely retry;
 * PRAGMA user_version is deliberately the final statement.
 */
export const migrateV5ToV6 = async (transaction: DatabaseTransaction): Promise<void> => {
  for (const [tableName, definitions] of Object.entries(v6ColumnAdditions)) {
    for (const definition of definitions) {
      await ensureColumn(transaction, tableName, definition);
    }
  }

  for (const sql of v6CreateTablesSQL) {
    await transaction.execute(sql);
  }

  for (const sql of v6CreateIndexesSQL) {
    await transaction.execute(sql);
  }

  await transaction.execute(`PRAGMA user_version = ${PRODUCT_FOUNDATION_SCHEMA_VERSION}`);
};
