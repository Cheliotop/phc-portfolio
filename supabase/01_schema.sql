-- =====================================================
-- PHC Supabase Schema Migration
-- Run this in the Supabase SQL Editor (all at once)
-- =====================================================

-- 1. PROFILES TABLE (extends Supabase Auth)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 2. PROJECTS TABLE
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  description TEXT,
  client TEXT,
  type TEXT,
  project_type TEXT,
  target_depth REAL,
  default_bar_length REAL DEFAULT 3,
  default_bar_diameter TEXT,
  coordinates TEXT,
  well_name TEXT,
  status TEXT DEFAULT 'planning',
  start_date DATE,
  end_date DATE,
  estimated_completion DATE,
  progress_percentage INTEGER DEFAULT 0,
  assigned_operator_id UUID REFERENCES profiles(id),
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- 3. DRILLING BARS TABLE
CREATE TABLE IF NOT EXISTS drilling_bars (
  id BIGSERIAL PRIMARY KEY,
  client_entry_id TEXT UNIQUE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES profiles(id),
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
  timestamp_local TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, bar_number)
);
ALTER TABLE drilling_bars ENABLE ROW LEVEL SECURITY;

-- 4. MATERIALS (inventory)
CREATE TABLE IF NOT EXISTS materials (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL DEFAULT 0,
  min_quantity REAL DEFAULT 0,
  current_stock REAL DEFAULT 0,
  minimum_stock REAL DEFAULT 0,
  cost_per_unit REAL DEFAULT 0,
  supplier TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;

-- 5. MATERIAL TRANSACTIONS
CREATE TABLE IF NOT EXISTS material_transactions (
  id BIGSERIAL PRIMARY KEY,
  material_id BIGINT NOT NULL REFERENCES materials(id),
  project_id BIGINT REFERENCES projects(id),
  type TEXT,
  transaction_type TEXT,
  quantity REAL NOT NULL,
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE material_transactions ENABLE ROW LEVEL SECURITY;

-- 6. PROJECT MATERIALS (allocations)
CREATE TABLE IF NOT EXISTS project_materials (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id BIGINT REFERENCES materials(id),
  material_name TEXT NOT NULL,
  quantity_allocated REAL DEFAULT 0,
  initial_quantity REAL DEFAULT 0,
  current_quantity REAL DEFAULT 0,
  unit TEXT,
  assigned_date TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE project_materials ENABLE ROW LEVEL SECURITY;

-- 7. MATERIAL CONSUMPTION
CREATE TABLE IF NOT EXISTS material_consumption (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES profiles(id),
  project_material_id BIGINT REFERENCES project_materials(id),
  material_id BIGINT REFERENCES materials(id),
  material_name TEXT NOT NULL,
  quantity_used REAL NOT NULL,
  unit TEXT,
  date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE material_consumption ENABLE ROW LEVEL SECURITY;

-- 8. PROGRESS REPORTS
CREATE TABLE IF NOT EXISTS progress_reports (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  status TEXT,
  progress_percentage INTEGER DEFAULT 0,
  reported_by UUID NOT NULL REFERENCES profiles(id),
  report_date DATE,
  work_description TEXT,
  issues TEXT,
  next_steps TEXT,
  weather_conditions TEXT,
  crew_size INTEGER,
  hours_worked REAL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE progress_reports ENABLE ROW LEVEL SECURITY;

-- 9. PEDIDOS (supply requests)
CREATE TABLE IF NOT EXISTS pedidos (
  id BIGSERIAL PRIMARY KEY,
  pedido_number TEXT UNIQUE,
  project_id BIGINT REFERENCES projects(id),
  operator_id UUID NOT NULL REFERENCES profiles(id),
  job_site TEXT,
  priority TEXT DEFAULT 'Normal',
  pedido_type TEXT,
  items JSONB DEFAULT '[]',
  material TEXT,
  quantity REAL,
  reason TEXT,
  needed_by DATE,
  notes TEXT,
  status TEXT DEFAULT 'Pendiente',
  admin_notes TEXT,
  pdf_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;

-- 10. COMPLETION REPORTS
CREATE TABLE IF NOT EXISTS completion_reports (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES profiles(id),
  static_level REAL,
  dynamic_level REAL,
  flow_rate REAL,
  required_flow REAL,
  bucket_flow_rate REAL,
  flow_unit TEXT DEFAULT 'L/h',
  compressor_hours REAL,
  pump_hours REAL,
  water_quality TEXT,
  completion_notes TEXT,
  installed_meters REAL,
  perforated_meters REAL,
  materials_summary TEXT,
  completion_checklist TEXT,
  operator_signature TEXT,
  client_signature TEXT,
  admin_signature TEXT,
  status TEXT DEFAULT 'submitted',
  pdf_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE completion_reports ENABLE ROW LEVEL SECURITY;

-- 11. PHOTOS
CREATE TABLE IF NOT EXISTS photos (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT REFERENCES progress_reports(id),
  project_id BIGINT REFERENCES projects(id),
  storage_path TEXT NOT NULL,
  filename TEXT,
  original_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  caption TEXT,
  uploaded_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;

-- 12. NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  related_project BIGINT REFERENCES projects(id),
  related_material BIGINT REFERENCES materials(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- 13. SETTINGS
CREATE TABLE IF NOT EXISTS settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- =====================
-- INDEXES
-- =====================
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_projects_assigned_operator ON projects(assigned_operator_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_drilling_bars_project ON drilling_bars(project_id);
CREATE INDEX IF NOT EXISTS idx_drilling_bars_operator ON drilling_bars(operator_id);
CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category);
CREATE INDEX IF NOT EXISTS idx_material_transactions_material ON material_transactions(material_id);
CREATE INDEX IF NOT EXISTS idx_material_transactions_project ON material_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_materials_project ON project_materials(project_id);
CREATE INDEX IF NOT EXISTS idx_material_consumption_project ON material_consumption(project_id);
CREATE INDEX IF NOT EXISTS idx_material_consumption_operator ON material_consumption(operator_id);
CREATE INDEX IF NOT EXISTS idx_progress_reports_project ON progress_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_operator ON pedidos(operator_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_completion_reports_project ON completion_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_project ON photos(project_id);

-- =====================
-- AUTO-UPDATE updated_at TRIGGER
-- =====================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_profiles BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_projects BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_drilling_bars BEFORE UPDATE ON drilling_bars FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_materials BEFORE UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_project_materials BEFORE UPDATE ON project_materials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_progress_reports BEFORE UPDATE ON progress_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_pedidos BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_completion_reports BEFORE UPDATE ON completion_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_settings BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
