// PHC Native Database Initial Migration
// Version: 0001
// Description: Create all tables for drilling management system

export const migration_0001_init = `-- PHC Native Database Initial Migration
-- Version: 0001
-- Description: Create all tables for drilling management system

-- Wells table - stores drilling well information
CREATE TABLE IF NOT EXISTS wells (
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
);

-- Progress logs table - stores drilling progress data
CREATE TABLE IF NOT EXISTS progress_logs (
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
);

-- Materials catalog table - stores material types
CREATE TABLE IF NOT EXISTS materials_catalog (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  unit TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

-- Material movements table - tracks material usage and inventory
CREATE TABLE IF NOT EXISTS material_movements (
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
);

-- Photos table - stores local and remote photo references
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY NOT NULL,
  local_uri TEXT,
  uploaded_url TEXT,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  well_id TEXT,
  movement_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  sync_status TEXT,
  origin TEXT,
  version INTEGER,
  deleted INTEGER DEFAULT 0
);

-- Sync outbox table - manages offline sync queue
CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  entity TEXT,
  entity_id TEXT,
  op TEXT,
  payload_json TEXT,
  retries INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Create indexes for performance optimization

-- Wells indexes
CREATE INDEX IF NOT EXISTS idx_wells_project_id ON wells(project_id);
CREATE INDEX IF NOT EXISTS idx_wells_status ON wells(status);
CREATE INDEX IF NOT EXISTS idx_wells_deleted ON wells(deleted);

-- Progress logs indexes
CREATE INDEX IF NOT EXISTS idx_progress_logs_well_id ON progress_logs(well_id);
CREATE INDEX IF NOT EXISTS idx_progress_logs_timestamp ON progress_logs(timestamp_local);
CREATE INDEX IF NOT EXISTS idx_progress_logs_sync_status ON progress_logs(sync_status);
CREATE INDEX IF NOT EXISTS idx_progress_logs_deleted ON progress_logs(deleted);

-- Material movements indexes
CREATE INDEX IF NOT EXISTS idx_material_movements_well_id ON material_movements(well_id);
CREATE INDEX IF NOT EXISTS idx_material_movements_project_id ON material_movements(project_id);
CREATE INDEX IF NOT EXISTS idx_material_movements_material_type_id ON material_movements(material_type_id);
CREATE INDEX IF NOT EXISTS idx_material_movements_timestamp ON material_movements(timestamp_local);
CREATE INDEX IF NOT EXISTS idx_material_movements_sync_status ON material_movements(sync_status);
CREATE INDEX IF NOT EXISTS idx_material_movements_deleted ON material_movements(deleted);

-- Photos indexes
CREATE INDEX IF NOT EXISTS idx_photos_well_id ON photos(well_id);
CREATE INDEX IF NOT EXISTS idx_photos_movement_id ON photos(movement_id);
CREATE INDEX IF NOT EXISTS idx_photos_sync_status ON photos(sync_status);
CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted);

-- Sync outbox indexes
CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity_id ON sync_outbox(entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at);

-- Migration tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);

-- Record this migration
INSERT OR REPLACE INTO schema_migrations (version, applied_at)
VALUES ('0001', datetime('now'));`;
