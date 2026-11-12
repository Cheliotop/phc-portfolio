-- ============================================================================
-- PHC baseline schema
--
-- The original 13 public tables were created manually before migration history
-- began, so the first recorded migration already depends on them. This baseline
-- was derived by subtracting every structural addition in the immutable later
-- migrations from the production catalog facts extracted on 2026-07-20. It
-- intentionally contains only the pre-migration tables, sequences, surviving
-- constraints/indexes, sequence ownership, and RLS enablement.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.projects_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.drilling_bars_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.materials_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.material_transactions_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.project_materials_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.material_consumption_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.progress_reports_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.pedidos_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.completion_reports_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.photos_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.notifications_id_seq AS bigint;
CREATE SEQUENCE IF NOT EXISTS public.settings_id_seq AS bigint;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE NOT NULL,
  email text UNIQUE,
  role text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  full_name text,
  first_name text,
  last_name text,
  phone text,
  avatar_url text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.projects (
  id bigint PRIMARY KEY DEFAULT nextval('public.projects_id_seq'::regclass),
  name text NOT NULL,
  location text,
  description text,
  client text,
  type text,
  project_type text,
  target_depth real,
  default_bar_length real DEFAULT 3,
  default_bar_diameter text,
  coordinates text,
  well_name text,
  status text DEFAULT 'planning',
  start_date date,
  end_date date,
  estimated_completion date,
  progress_percentage integer DEFAULT 0,
  assigned_operator_id uuid REFERENCES public.profiles(id),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.drilling_bars (
  id bigint PRIMARY KEY DEFAULT nextval('public.drilling_bars_id_seq'::regclass),
  client_entry_id text UNIQUE,
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES public.profiles(id),
  bar_number integer NOT NULL,
  depth_start real NOT NULL,
  depth_end real NOT NULL,
  length real NOT NULL,
  diameter text,
  soil_type text NOT NULL,
  start_time text,
  end_time text,
  duration_minutes integer,
  water_level real,
  notes text,
  photo_paths text,
  timestamp_local text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (project_id, bar_number)
);

CREATE TABLE IF NOT EXISTS public.materials (
  id bigint PRIMARY KEY DEFAULT nextval('public.materials_id_seq'::regclass),
  name text NOT NULL,
  type text,
  category text NOT NULL,
  unit text NOT NULL,
  quantity real DEFAULT 0,
  min_quantity real DEFAULT 0,
  current_stock real DEFAULT 0,
  minimum_stock real DEFAULT 0,
  cost_per_unit real DEFAULT 0,
  supplier text,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.material_transactions (
  id bigint PRIMARY KEY DEFAULT nextval('public.material_transactions_id_seq'::regclass),
  material_id bigint NOT NULL REFERENCES public.materials(id),
  project_id bigint REFERENCES public.projects(id),
  type text,
  transaction_type text,
  quantity real NOT NULL,
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.project_materials (
  id bigint PRIMARY KEY DEFAULT nextval('public.project_materials_id_seq'::regclass),
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  material_id bigint REFERENCES public.materials(id),
  material_name text NOT NULL,
  quantity_allocated real DEFAULT 0,
  initial_quantity real DEFAULT 0,
  current_quantity real DEFAULT 0,
  unit text,
  assigned_date timestamptz DEFAULT now(),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.material_consumption (
  id bigint PRIMARY KEY DEFAULT nextval('public.material_consumption_id_seq'::regclass),
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES public.profiles(id),
  project_material_id bigint REFERENCES public.project_materials(id),
  material_id bigint REFERENCES public.materials(id),
  material_name text NOT NULL,
  quantity_used real NOT NULL,
  unit text,
  date date,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.progress_reports (
  id bigint PRIMARY KEY DEFAULT nextval('public.progress_reports_id_seq'::regclass),
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text,
  description text,
  status text,
  progress_percentage integer DEFAULT 0,
  reported_by uuid NOT NULL REFERENCES public.profiles(id),
  report_date date,
  work_description text,
  issues text,
  next_steps text,
  weather_conditions text,
  crew_size integer,
  hours_worked real,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pedidos (
  id bigint PRIMARY KEY DEFAULT nextval('public.pedidos_id_seq'::regclass),
  pedido_number text UNIQUE,
  project_id bigint REFERENCES public.projects(id),
  operator_id uuid NOT NULL REFERENCES public.profiles(id),
  job_site text,
  priority text DEFAULT 'Normal',
  pedido_type text,
  items jsonb DEFAULT '[]'::jsonb,
  material text,
  quantity real,
  reason text,
  needed_by date,
  notes text,
  status text DEFAULT 'Pendiente',
  admin_notes text,
  pdf_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.completion_reports (
  id bigint PRIMARY KEY DEFAULT nextval('public.completion_reports_id_seq'::regclass),
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES public.profiles(id),
  static_level real,
  dynamic_level real,
  flow_rate real,
  required_flow real,
  bucket_flow_rate real,
  flow_unit text DEFAULT 'L/h',
  compressor_hours real,
  pump_hours real,
  water_quality text,
  completion_notes text,
  installed_meters real,
  perforated_meters real,
  materials_summary text,
  completion_checklist text,
  operator_signature text,
  client_signature text,
  admin_signature text,
  status text DEFAULT 'submitted',
  pdf_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.photos (
  id bigint PRIMARY KEY DEFAULT nextval('public.photos_id_seq'::regclass),
  report_id bigint REFERENCES public.progress_reports(id),
  project_id bigint REFERENCES public.projects(id),
  storage_path text NOT NULL,
  filename text,
  original_name text,
  file_size integer,
  mime_type text,
  caption text,
  uploaded_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id bigint PRIMARY KEY DEFAULT nextval('public.notifications_id_seq'::regclass),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  related_project bigint REFERENCES public.projects(id),
  related_material bigint REFERENCES public.materials(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.settings (
  id bigint PRIMARY KEY DEFAULT nextval('public.settings_id_seq'::regclass),
  key text UNIQUE NOT NULL,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;
ALTER SEQUENCE public.drilling_bars_id_seq OWNED BY public.drilling_bars.id;
ALTER SEQUENCE public.materials_id_seq OWNED BY public.materials.id;
ALTER SEQUENCE public.material_transactions_id_seq OWNED BY public.material_transactions.id;
ALTER SEQUENCE public.project_materials_id_seq OWNED BY public.project_materials.id;
ALTER SEQUENCE public.material_consumption_id_seq OWNED BY public.material_consumption.id;
ALTER SEQUENCE public.progress_reports_id_seq OWNED BY public.progress_reports.id;
ALTER SEQUENCE public.pedidos_id_seq OWNED BY public.pedidos.id;
ALTER SEQUENCE public.completion_reports_id_seq OWNED BY public.completion_reports.id;
ALTER SEQUENCE public.photos_id_seq OWNED BY public.photos.id;
ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;
ALTER SEQUENCE public.settings_id_seq OWNED BY public.settings.id;

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_projects_assigned_operator ON public.projects(assigned_operator_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(status);
CREATE INDEX IF NOT EXISTS idx_drilling_bars_project ON public.drilling_bars(project_id);
CREATE INDEX IF NOT EXISTS idx_drilling_bars_operator ON public.drilling_bars(operator_id);
CREATE INDEX IF NOT EXISTS idx_materials_category ON public.materials(category);
CREATE INDEX IF NOT EXISTS idx_material_transactions_material ON public.material_transactions(material_id);
CREATE INDEX IF NOT EXISTS idx_material_transactions_project ON public.material_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_materials_project ON public.project_materials(project_id);
CREATE INDEX IF NOT EXISTS idx_material_consumption_project ON public.material_consumption(project_id);
CREATE INDEX IF NOT EXISTS idx_material_consumption_operator ON public.material_consumption(operator_id);
CREATE INDEX IF NOT EXISTS idx_progress_reports_project ON public.progress_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_operator ON public.pedidos(operator_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON public.pedidos(status);
CREATE INDEX IF NOT EXISTS idx_completion_reports_project ON public.completion_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_project ON public.photos(project_id);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drilling_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.progress_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.completion_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Baseline RLS policy that predates migration history.
--
-- Production has a SELECT policy on public.settings granting all authenticated
-- users read access. It was defined in supabase/01_schema.sql, never in a
-- migration, so a from-scratch rebuild ended up with 68 policies against
-- production's 69. Verified against the production catalog on 2026-07-20.
-- ---------------------------------------------------------------------------
CREATE POLICY "Authenticated users can view settings"
  ON public.settings
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- Platform-created helper that never existed in migration history.
--
-- Production has public.rls_auto_enable() because the Supabase platform created
-- it out-of-band; the only reference anywhere in this repo is a REVOKE in
-- 20260708225908_phc_rls_role_and_perf_fixes.sql, which fails on a fresh
-- database (SQLSTATE 42883). Definition below is copied verbatim from the
-- production catalog (pg_get_functiondef) on 2026-07-20.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance, from supabase/01_schema.sql.
--
-- These nine triggers predate migration history and were missing from the
-- first cut of this baseline, so a rebuilt database silently stopped
-- maintaining updated_at on the base tables (prod had 56 public triggers,
-- a fresh rebuild had 47). update_updated_at_column() is re-declared here
-- because 20260708225908 also defines it but runs AFTER this baseline.
-- ---------------------------------------------------------------------------
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
