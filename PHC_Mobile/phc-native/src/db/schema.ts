import { execute } from './db';
import {
  v6CreateIndexesSQL,
  v6CreateTablesSQL,
} from './migrations/0006_product_foundation';
import {
  MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL,
} from './migrations/0008_material_consumption_identity';
import {
  PROJECT_SECONDARY_OPERATORS_INDEX_SQL,
  PROJECT_SECONDARY_OPERATORS_TABLE_SQL,
} from './migrations/0009_secondary_operator_assignments';
import {
  REJECTED_WORK_SCHEMA_VERSION,
  REJECTED_WORK_TABLE_SQL,
} from './migrations/0010_rejected_work_archive';

/**
 * Database schema for PHC Native offline storage
 * Includes wells, progress logs, materials, photos, and sync management
 */

export const SCHEMA_VERSION = REJECTED_WORK_SCHEMA_VERSION + 1;
// v6 adds the offline product-plan foundation. Fresh installs receive this
// complete schema; populated v5 devices are upgraded by the explicit,
// transactional migrations under db/migrations.

export const createTablesSQL = [
  // Wells table - stores drilling well information
  `CREATE TABLE IF NOT EXISTS wells (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    name TEXT,
    coordinates TEXT,
    target_depth REAL,
    status TEXT,
    created_at TEXT,
    updated_at TEXT,
    origin TEXT,
    version INTEGER,
    deleted INTEGER DEFAULT 0
  )`,

  // Progress logs table - stores drilling progress data
  `CREATE TABLE IF NOT EXISTS progress_logs (
    id TEXT PRIMARY KEY NOT NULL,
    well_id TEXT,
    meters_drilled REAL,
    rod_length REAL,
    diameter REAL,
    depth_reached REAL,
    note TEXT,
    photo_id TEXT,
    timestamp_local TEXT,
    sync_status TEXT,
    origin TEXT,
    version INTEGER,
    deleted INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`,

  // Materials catalog table - stores material types
  `CREATE TABLE IF NOT EXISTS materials_catalog (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    unit TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  )`,

  // Material movements table - tracks material usage and inventory
  `CREATE TABLE IF NOT EXISTS material_movements (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT,
    well_id TEXT,
    project_id TEXT,
    material_type_id TEXT,
    quantity REAL,
    unit TEXT,
    movement_type TEXT,
    note TEXT,
    photo_id TEXT,
    timestamp_local TEXT,
    sync_status TEXT,
    origin TEXT,
    version INTEGER,
    deleted INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`,

  // Photos table - stores local and remote photo references
  `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY NOT NULL,
    local_uri TEXT,
    uploaded_url TEXT,
    mime TEXT,
    size INTEGER,
    sha256 TEXT,
    well_id TEXT,
    movement_id TEXT,
    shift_id TEXT,
    created_at TEXT,
    updated_at TEXT,
    sync_status TEXT,
    origin TEXT,
    version INTEGER,
    deleted INTEGER DEFAULT 0
  )`,

  // Sync outbox table - manages offline sync queue
  `CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY NOT NULL,
    entity TEXT,
    entity_id TEXT,
    op TEXT,
    payload_json TEXT,
    author_id TEXT,
    retries INTEGER DEFAULT 0,
    last_error TEXT,
    -- 'pending' | 'quarantined'. Quarantined rows were permanently rejected by
    -- the server; they are kept as evidence for review and never drained again.
    -- Distinct from retries >= 3, which means transient attempts ran out.
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS shift_joined_local (
    shift_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (shift_id, operator_id)
  )`,

  // Operators table - stores operator information
  `CREATE TABLE IF NOT EXISTS operators (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'operator',
    status TEXT DEFAULT 'active',
    pin TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // Projects table - stores project information
  `CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT,
    assigned_operator_id TEXT,
    target_depth REAL,
    default_bar_length REAL DEFAULT 3,
    default_bar_diameter TEXT,
    coordinates TEXT,
    well_name TEXT,
    progress REAL DEFAULT 0,
    status TEXT DEFAULT 'En Progreso',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    deleted INTEGER DEFAULT 0,
    FOREIGN KEY (assigned_operator_id) REFERENCES operators(id)
  )`,

  // Enhanced progress logs table for dashboard compatibility
  `CREATE TABLE IF NOT EXISTS progress_logs_dashboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    operator_id TEXT,
    date TEXT NOT NULL,
    depth_start REAL NOT NULL,
    depth_end REAL NOT NULL,
    bars_added INTEGER,
    bar_type TEXT,
    drilling_method TEXT,
    soil_type TEXT,
    water_level REAL,
    notes TEXT,
    photo_paths TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )`,

  // One physical drilling bar per row. This is the production field log.
  `CREATE TABLE IF NOT EXISTS drilling_bar_entries (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER,
    project_id INTEGER NOT NULL,
    operator_id TEXT NOT NULL,
    shift_id TEXT,
    bar_number INTEGER NOT NULL,
    depth_start REAL NOT NULL,
    depth_end REAL NOT NULL,
    length REAL NOT NULL,
    diameter TEXT,
    soil_type TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    duration_minutes INTEGER,
    water_level REAL,
    notes TEXT,
    photo_paths TEXT,
    timestamp_local TEXT NOT NULL,
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, bar_number)
  )`,

  // Materials used table for tracking material consumption
  `CREATE TABLE IF NOT EXISTS materials_used (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    operator_id TEXT,
    date TEXT NOT NULL,
    material_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    notes TEXT,
    photo_paths TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )`,

  // Supply requests table for material requests
  `CREATE TABLE IF NOT EXISTS supply_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_entry_id TEXT UNIQUE,
    project_id INTEGER,
    operator_id TEXT,
    material TEXT NOT NULL,
    quantity REAL NOT NULL,
    priority TEXT DEFAULT 'Normal',
    reason TEXT,
    needed_by TEXT,
    job_site TEXT,
    pedido_type TEXT,
    notes TEXT,
    pedido_number TEXT,
    status TEXT DEFAULT 'Pendiente',
    admin_notes TEXT,
    approved_by TEXT,
    approval_notes TEXT,
    kind TEXT NOT NULL DEFAULT 'empresa',
    justification TEXT,
    closed_manually INTEGER NOT NULL DEFAULT 0,
    closed_by TEXT,
    closed_at TEXT,
    server_id INTEGER,
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )`,

  // Material inventory table for stock management
  `CREATE TABLE IF NOT EXISTS material_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_name TEXT NOT NULL,
    current_stock REAL NOT NULL DEFAULT 0,
    min_stock REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL,
    location TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // Project materials table - tracks materials assigned to specific projects
  `CREATE TABLE IF NOT EXISTS project_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    material_name TEXT NOT NULL,
    initial_quantity REAL NOT NULL,
    current_quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    layer TEXT NOT NULL DEFAULT 'extras',
    catalog_variant_id INTEGER,
    catalog_variant_local_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    assigned_date TEXT DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  )`,

  // Material consumption table - tracks daily material usage by operators
  `CREATE TABLE IF NOT EXISTS material_consumption (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_entry_id TEXT UNIQUE,
    project_id INTEGER NOT NULL,
    operator_id TEXT NOT NULL,
    shift_id TEXT,
    project_material_id INTEGER,
    material_id INTEGER,
    material_name TEXT NOT NULL,
    quantity_used REAL NOT NULL,
    unit TEXT NOT NULL,
    date TEXT NOT NULL,
    notes TEXT,
    approximate INTEGER NOT NULL DEFAULT 0,
    anomaly_flag INTEGER NOT NULL DEFAULT 0,
    server_id INTEGER,
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )`,

  // Completion reports table (local mirror) - pump-test/handoff report,
  // one per well/project completion. Mirrors public.completion_reports.
  `CREATE TABLE IF NOT EXISTS completion_reports_local (
    id TEXT PRIMARY KEY NOT NULL,
    server_id INTEGER,
    client_entry_id TEXT,
    project_id INTEGER NOT NULL,
    operator_id TEXT,
    format_version INTEGER NOT NULL DEFAULT 1,
    static_level REAL,
    dynamic_level REAL,
    flow_rate REAL,
    specific_flow_rate REAL,
    maximum_flow_rate REAL,
    pump_depth_m REAL,
    specific_flow_overridden INTEGER NOT NULL DEFAULT 0,
    hydraulic_mismatch INTEGER NOT NULL DEFAULT 0,
    required_flow REAL,
    bucket_flow_rate REAL,
    flow_unit TEXT DEFAULT 'L/h',
    compressor_hours REAL,
    pump_hours REAL,
    water_quality TEXT,
    perforated_meters REAL,
    installed_meters REAL,
    materials_summary TEXT,
    completion_checklist TEXT,
    completion_notes TEXT,
    exploration_depth_m REAL,
    widening_depth_m REAL,
    casing_total_m REAL,
    casing_above_ground_m REAL,
    blind_casing_m REAL,
    filter_casing_m REAL,
    sediment_trap_m REAL,
    centralizer_count INTEGER,
    bottom_plug_details TEXT,
    bentonite_quantity REAL,
    gravel_quantity REAL,
    casing_layout TEXT NOT NULL DEFAULT '[]',
    operator_signature TEXT,
    client_signature TEXT,
    admin_signature TEXT,
    pdf_local_uri TEXT,
    pdf_url TEXT,
    status TEXT DEFAULT 'submitted',
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    submitted_at TEXT,
    finalized_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  )`,

  // v6 offline-first domain tables (catalog, shifts, pedidos v2, closure).
  ...v6CreateTablesSQL,

  // Audit log table - tracks all user actions for security
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_role TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    timestamp TEXT NOT NULL
  )`,

  // Settings table - app configuration
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // v9: subcontractor assignments, mirrored from the server so an operator can
  // reach a well they are a secondary on. See 0009 for why this is a table
  // rather than a relaxed filter.
  PROJECT_SECONDARY_OPERATORS_TABLE_SQL,
  REJECTED_WORK_TABLE_SQL,
];

/**
 * Database indexes for improved query performance
 */
export const createIndexesSQL = [
  // Wells indexes
  'CREATE INDEX IF NOT EXISTS idx_wells_project_id ON wells(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_wells_status ON wells(status)',
  'CREATE INDEX IF NOT EXISTS idx_wells_deleted ON wells(deleted)',

  // Progress logs indexes
  'CREATE INDEX IF NOT EXISTS idx_progress_logs_well_id ON progress_logs(well_id)',
  'CREATE INDEX IF NOT EXISTS idx_progress_logs_timestamp ON progress_logs(timestamp_local)',
  'CREATE INDEX IF NOT EXISTS idx_progress_logs_sync_status ON progress_logs(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_progress_logs_deleted ON progress_logs(deleted)',

  // Material movements indexes
  'CREATE INDEX IF NOT EXISTS idx_material_movements_well_id ON material_movements(well_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_movements_project_id ON material_movements(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_movements_material_type_id ON material_movements(material_type_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_movements_timestamp ON material_movements(timestamp_local)',
  'CREATE INDEX IF NOT EXISTS idx_material_movements_sync_status ON material_movements(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_material_movements_deleted ON material_movements(deleted)',

  // Photos indexes
  'CREATE INDEX IF NOT EXISTS idx_photos_well_id ON photos(well_id)',
  'CREATE INDEX IF NOT EXISTS idx_photos_movement_id ON photos(movement_id)',
  'CREATE INDEX IF NOT EXISTS idx_photos_sync_status ON photos(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted)',

  // Sync outbox indexes
  'CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity)',
  'CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity_id ON sync_outbox(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at)',

  // Project materials indexes
  'CREATE INDEX IF NOT EXISTS idx_drilling_bar_entries_project_id ON drilling_bar_entries(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_drilling_bar_entries_sync_status ON drilling_bar_entries(sync_status)',
  'CREATE INDEX IF NOT EXISTS idx_drilling_bar_entries_timestamp ON drilling_bar_entries(timestamp_local)',

  // Project materials indexes
  'CREATE INDEX IF NOT EXISTS idx_project_materials_project_id ON project_materials(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_project_materials_material_name ON project_materials(material_name)',

  // Material consumption indexes
  'CREATE INDEX IF NOT EXISTS idx_material_consumption_project_id ON material_consumption(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_consumption_operator_id ON material_consumption(operator_id)',
  'CREATE INDEX IF NOT EXISTS idx_material_consumption_date ON material_consumption(date)',
  'CREATE INDEX IF NOT EXISTS idx_material_consumption_material_name ON material_consumption(material_name)',
  'CREATE INDEX IF NOT EXISTS idx_material_consumption_sync_status ON material_consumption(sync_status)',
  MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL,

  // Supply requests (pedidos) indexes
  'CREATE INDEX IF NOT EXISTS idx_supply_requests_project_id ON supply_requests(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_supply_requests_sync_status ON supply_requests(sync_status)',

  // Completion reports (local) indexes
  'CREATE INDEX IF NOT EXISTS idx_completion_reports_local_project_id ON completion_reports_local(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_completion_reports_local_sync_status ON completion_reports_local(sync_status)',

  // Audit log indexes
  'CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)',

  // Settings indexes
  'CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key)',

  // Subcontractor assignment lookup
  PROJECT_SECONDARY_OPERATORS_INDEX_SQL,

  // v6 product-foundation indexes, also used by the installed-device upgrade.
  ...v6CreateIndexesSQL,
];

/**
 * Initialize database schema by creating all tables and indexes
 */
export const initializeSchema = async (): Promise<void> => {
  try {
    for (const sql of createTablesSQL) {
      await execute(sql);
    }

    for (const sql of createIndexesSQL) {
      await execute(sql);
    }
  } catch (error) {
    console.error('[PHC] Database schema initialization failed:', error);
    throw error;
  }
};
