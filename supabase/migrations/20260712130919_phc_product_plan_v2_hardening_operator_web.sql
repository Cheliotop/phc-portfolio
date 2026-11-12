-- ============================================================================
-- PHC Product Plan v2 — post-deployment integrity hardening + operator web
--
-- Forward-only follow-up to the production-applied migration 20260711102930.
-- Never fold these statements back into the applied migration: remote and
-- local migration history must remain byte-stable and ordered.
-- ============================================================================

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE public.drilling_bars
  ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE public.material_consumption
  ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE public.water_samples
  ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS evidence_kind text NOT NULL DEFAULT 'field';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.photos'::regclass
      AND conname = 'photos_evidence_kind_check'
  ) THEN
    ALTER TABLE public.photos
      ADD CONSTRAINT photos_evidence_kind_check
      CHECK (evidence_kind IN ('field', 'water_sample'));
  END IF;
END;
$$;

ALTER TABLE public.completion_reports
  ADD COLUMN IF NOT EXISTS signed_pdf_attached_at timestamptz,
  ADD COLUMN IF NOT EXISTS submission_payload jsonb,
  ADD COLUMN IF NOT EXISTS last_resubmission_id text,
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS returned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_snapshot jsonb;

ALTER TABLE public.material_reconciliations
  ADD COLUMN IF NOT EXISTS overconsumed_quantity real GENERATED ALWAYS AS
    (greatest(consumed_quantity - sent_quantity, 0::real)) STORED;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.material_reconciliations'::regclass
      AND conname = 'material_reconciliations_returned_available_check'
  ) THEN
    ALTER TABLE public.material_reconciliations
      ADD CONSTRAINT material_reconciliations_returned_available_check
      CHECK (returned_quantity <= greatest(sent_quantity - consumed_quantity, 0::real) + 0.00001)
      NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_materials_active_variant_layer_uidx
  ON public.project_materials(project_id, catalog_variant_id, layer)
  WHERE catalog_variant_id IS NOT NULL AND active IS TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS project_attachments_storage_path_uidx
  ON public.project_attachments(storage_path);

CREATE TABLE IF NOT EXISTS public.notification_event_claims (
  event_type text NOT NULL CHECK (event_type IN ('pedido_created', 'low_stock', 'completion_signed')),
  entity_id bigint NOT NULL CHECK (entity_id > 0),
  claimed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (event_type, entity_id)
);
ALTER TABLE public.notification_event_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_event_claims FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
      AND p.is_active IS TRUE
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active IS TRUE
  );
$$;

-- One server vocabulary mirrors src/domain/projectStatus.ts. Unknown legacy
-- values intentionally normalize to active, matching the client migration.
CREATE OR REPLACE FUNCTION public.project_status_key(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE lower(btrim(COALESCE(p_status, '')))
    WHEN 'planning' THEN 'planning'
    WHEN 'planificado' THEN 'planning'
    WHEN 'active' THEN 'active'
    WHEN 'en progreso' THEN 'active'
    WHEN 'closure_submitted' THEN 'closure_submitted'
    WHEN 'cierre enviado' THEN 'closure_submitted'
    WHEN 'completed' THEN 'completed'
    WHEN 'completado' THEN 'completed'
    WHEN 'paused' THEN 'paused'
    WHEN 'pausado' THEN 'paused'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'canceled' THEN 'cancelled'
    WHEN 'cancelado' THEN 'cancelled'
    ELSE 'active'
  END;
$$;

CREATE OR REPLACE FUNCTION public.project_allows_field_work(p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND public.project_status_key(p.status) = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.project_allows_planning_change(p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND public.project_status_key(p.status) IN ('planning', 'active')
  );
$$;

CREATE OR REPLACE FUNCTION public.project_allows_closure_change(p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND public.project_status_key(p.status) IN ('active', 'closure_submitted')
  );
$$;

-- Storage policies must never cast an attacker-controlled folder name. A
-- malformed/root object maps to NULL and fails closed instead of aborting the
-- entire listing query.
CREATE OR REPLACE FUNCTION public.storage_project_id(p_object_name text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN split_part(COALESCE(p_object_name, ''), '/', 1) ~ '^[1-9][0-9]{0,17}$'
    THEN split_part(p_object_name, '/', 1)::bigint
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.safe_bigint(p_value text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN COALESCE(p_value, '') ~ '^[0-9]{1,18}$' THEN p_value::bigint
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_project_operator(p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_active_user() AND EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.assigned_operator_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_closing_operator(p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_active_user() AND EXISTS (
    SELECT 1
    FROM public.project_closing_assignments a
    WHERE a.project_id = p_project_id
      AND a.operator_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_project_operator(bigint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_closing_operator(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_project_operator(bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_closing_operator(bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.protect_finalized_completion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'completion reports cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_at IS NOT NULL
     OR (OLD.admin_signature IS NOT NULL AND btrim(OLD.admin_signature) <> '') THEN
    -- A derived signed PDF may be attached exactly once after the database
    -- signature; no Ficha field can change and repeated replacement is denied.
    IF (to_jsonb(NEW) - 'pdf_url' - 'signed_pdf_attached_at' - 'updated_at') =
       (to_jsonb(OLD) - 'pdf_url' - 'signed_pdf_attached_at' - 'updated_at')
       AND OLD.signed_pdf_attached_at IS NULL
       AND NEW.signed_pdf_attached_at IS NOT NULL
       AND NEW.pdf_url IS NOT NULL
       AND NEW.pdf_url IS DISTINCT FROM OLD.pdf_url
       AND public.is_admin() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'finalized Ficha is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Direct INSERT exists only for a bounded old-APK transition on projects that
-- predate this migration. The trigger is a second line of defense behind RLS:
-- callers cannot forge a v2/admin-signed row or populate final-only fields.
CREATE OR REPLACE FUNCTION private.protect_completion_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('phc.completion_v2_insert', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.format_version IS DISTINCT FROM 1
     OR NEW.status IS DISTINCT FROM 'submitted'
     OR NEW.admin_signature IS NOT NULL
     OR NEW.finalized_at IS NOT NULL
     OR NEW.signed_pdf_attached_at IS NOT NULL
     OR NEW.submission_payload IS NOT NULL
     OR NEW.last_resubmission_id IS NOT NULL
     OR NEW.return_reason IS NOT NULL
     OR NEW.returned_by IS NOT NULL
     OR NEW.returned_at IS NOT NULL
     OR NEW.finalized_snapshot IS NOT NULL
     OR NEW.specific_flow_rate IS NOT NULL
     OR NEW.maximum_flow_rate IS NOT NULL
     OR NEW.pump_depth_m IS NOT NULL
     OR NEW.specific_flow_overridden IS TRUE
     OR NEW.hydraulic_mismatch IS TRUE
     OR NEW.exploration_depth_m IS NOT NULL
     OR NEW.widening_depth_m IS NOT NULL
     OR NEW.casing_total_m IS NOT NULL
     OR NEW.casing_above_ground_m IS NOT NULL
     OR NEW.blind_casing_m IS NOT NULL
     OR NEW.filter_casing_m IS NOT NULL
     OR NEW.sediment_trap_m IS NOT NULL
     OR NEW.centralizer_count IS NOT NULL
     OR NEW.bottom_plug_details IS NOT NULL
     OR NEW.bentonite_quantity IS NOT NULL
     OR NEW.gravel_quantity IS NOT NULL
     OR NEW.casing_layout IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'COMPLETION_V2_RPC_REQUIRED: use submit_completion_v2'
      USING ERRCODE = '0A000';
  END IF;
  IF NEW.pdf_url IS NOT NULL AND (
    NEW.pdf_url NOT LIKE NEW.project_id::text || '/%'
    OR lower(NEW.pdf_url) NOT LIKE '%.pdf'
  ) THEN
    RAISE EXCEPTION 'Legacy PDF path must be a project-scoped PDF'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = NEW.project_id
      AND p.created_at < timestamptz '2026-07-11 10:29:30+00'
      AND public.project_status_key(p.status) = 'active'
  ) THEN
    RAISE EXCEPTION 'Legacy completion insertion is closed for this project; update the app'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

-- Once a project is signed, operational child rows are frozen at the data
-- layer. Attachments remain intentionally appendable and corrections retain
-- their own guarded, append-only path.
CREATE OR REPLACE FUNCTION private.protect_finalized_project_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_project_id bigint;
BEGIN
  v_project_id := NULLIF(v_row ->> 'project_id', '')::bigint;
  IF v_project_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = v_project_id
      AND public.project_status_key(p.status) = 'completed'
  ) THEN
    RAISE EXCEPTION 'Signed project evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_finalized_pedido_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_pedido_id bigint;
  v_project_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'pedidos' THEN
    v_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  ELSIF TG_TABLE_NAME = 'pedido_items' THEN
    v_pedido_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.pedido_id ELSE NEW.pedido_id END;
  ELSE
    SELECT pi.pedido_id INTO v_pedido_id
    FROM public.pedido_items pi
    WHERE pi.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.pedido_item_id ELSE NEW.pedido_item_id END;
  END IF;
  IF v_project_id IS NULL AND v_pedido_id IS NOT NULL THEN
    SELECT p.project_id INTO v_project_id FROM public.pedidos p WHERE p.id = v_pedido_id;
  END IF;
  IF v_project_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = v_project_id AND public.project_status_key(p.status) = 'completed'
  ) THEN
    RAISE EXCEPTION 'Pedidos of a signed project are frozen; close or carry them before signing'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Stable external codes form one namespace. The base material and its own
-- standard variant may intentionally share a code; cross-material ambiguity
-- is rejected so imports cannot silently choose the wrong material.
CREATE OR REPLACE FUNCTION private.protect_catalog_code_namespace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_code text := upper(btrim(COALESCE(NEW.external_code, '')));
BEGIN
  IF v_code = '' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'catalog_materials' THEN
    IF EXISTS (
      SELECT 1 FROM public.catalog_variants v
      WHERE upper(btrim(v.external_code)) = v_code
        AND v.material_id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'External code % already belongs to another material variant', v_code
        USING ERRCODE = '23505';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.catalog_materials m
      WHERE upper(btrim(m.external_code)) = v_code
        AND m.id IS DISTINCT FROM NEW.material_id
    ) THEN
      RAISE EXCEPTION 'External code % already belongs to another material', v_code
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_completed_project()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'projects cannot be deleted; cancel them with an audit reason'
      USING ERRCODE = '55000';
  END IF;
  IF public.project_status_key(OLD.status) = 'completed'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'completed project core data is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_project_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old text := public.project_status_key(OLD.status);
  v_new text := public.project_status_key(NEW.status);
BEGIN
  IF v_new = v_old THEN RETURN NEW; END IF;
  IF v_new = 'closure_submitted'
     AND current_setting('phc.project_closure_submit', true) <> 'on' THEN
    RAISE EXCEPTION 'closure_submitted is set only by submit_completion_v2'
      USING ERRCODE = '55000';
  END IF;
  IF v_new = 'completed'
     AND current_setting('phc.project_completion', true) <> 'on' THEN
    RAISE EXCEPTION 'completed is set only by atomic Ficha signature'
      USING ERRCODE = '55000';
  END IF;
  IF v_old = 'closure_submitted' AND v_new NOT IN ('completed', 'active', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid transition from closure_submitted to %', v_new
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_audit_log_append_only ON public.audit_log;
CREATE TRIGGER protect_audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION private.reject_append_only_mutation();
DROP TRIGGER IF EXISTS protect_corrections_append_only ON public.record_corrections;
CREATE TRIGGER protect_corrections_append_only
  BEFORE UPDATE OR DELETE ON public.record_corrections
  FOR EACH ROW EXECUTE FUNCTION private.reject_append_only_mutation();
DROP TRIGGER IF EXISTS protect_handovers_append_only ON public.shift_handovers;
CREATE TRIGGER protect_handovers_append_only
  BEFORE UPDATE OR DELETE ON public.shift_handovers
  FOR EACH ROW EXECUTE FUNCTION private.reject_append_only_mutation();
DROP TRIGGER IF EXISTS protect_receipts_append_only ON public.pedido_receipts;
CREATE TRIGGER protect_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.pedido_receipts
  FOR EACH ROW EXECUTE FUNCTION private.reject_append_only_mutation();
DROP TRIGGER IF EXISTS protect_water_samples_immutable ON public.water_samples;
CREATE TRIGGER protect_water_samples_immutable
  BEFORE UPDATE OR DELETE ON public.water_samples
  FOR EACH ROW EXECUTE FUNCTION private.reject_append_only_mutation();

DROP TRIGGER IF EXISTS protect_drilling_bars_history ON public.drilling_bars;
CREATE TRIGGER protect_drilling_bars_history
  BEFORE UPDATE OR DELETE ON public.drilling_bars
  FOR EACH ROW EXECUTE FUNCTION private.protect_operational_history();
DROP TRIGGER IF EXISTS protect_consumption_history ON public.material_consumption;
CREATE TRIGGER protect_consumption_history
  BEFORE UPDATE OR DELETE ON public.material_consumption
  FOR EACH ROW EXECUTE FUNCTION private.protect_operational_history();
DROP TRIGGER IF EXISTS protect_photos_history ON public.photos;
CREATE TRIGGER protect_photos_history
  BEFORE UPDATE OR DELETE ON public.photos
  FOR EACH ROW EXECUTE FUNCTION private.protect_operational_history();
DROP TRIGGER IF EXISTS protect_closed_shifts ON public.shifts;
CREATE TRIGGER protect_closed_shifts
  BEFORE UPDATE OR DELETE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION private.protect_closed_shift();
DROP TRIGGER IF EXISTS protect_finalized_completion_reports ON public.completion_reports;
CREATE TRIGGER protect_finalized_completion_reports
  BEFORE UPDATE OR DELETE ON public.completion_reports
  FOR EACH ROW EXECUTE FUNCTION private.protect_finalized_completion();
DROP TRIGGER IF EXISTS protect_completion_report_insert ON public.completion_reports;
CREATE TRIGGER protect_completion_report_insert
  BEFORE INSERT ON public.completion_reports
  FOR EACH ROW EXECUTE FUNCTION private.protect_completion_insert();
DROP TRIGGER IF EXISTS protect_completed_projects ON public.projects;
CREATE TRIGGER protect_completed_projects
  BEFORE UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION private.protect_completed_project();
DROP TRIGGER IF EXISTS protect_project_lifecycle_transitions ON public.projects;
CREATE TRIGGER protect_project_lifecycle_transitions
  BEFORE UPDATE OF status ON public.projects
  FOR EACH ROW EXECUTE FUNCTION private.protect_project_lifecycle_transition();

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'project_materials', 'material_reconciliations', 'shifts',
    'drilling_bars', 'material_consumption', 'photos', 'water_samples',
    'completion_discrepancies'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protect_%I_after_project_finalization ON public.%I', v_table, v_table);
    EXECUTE format(
      'CREATE TRIGGER protect_%I_after_project_finalization BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.protect_finalized_project_child()',
      v_table, v_table
    );
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS protect_pedidos_after_project_finalization ON public.pedidos;
CREATE TRIGGER protect_pedidos_after_project_finalization
  BEFORE INSERT OR UPDATE OR DELETE ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION private.protect_finalized_pedido_child();
DROP TRIGGER IF EXISTS protect_pedido_items_after_project_finalization ON public.pedido_items;
CREATE TRIGGER protect_pedido_items_after_project_finalization
  BEFORE INSERT OR UPDATE OR DELETE ON public.pedido_items
  FOR EACH ROW EXECUTE FUNCTION private.protect_finalized_pedido_child();
DROP TRIGGER IF EXISTS protect_pedido_receipts_after_project_finalization ON public.pedido_receipts;
CREATE TRIGGER protect_pedido_receipts_after_project_finalization
  BEFORE INSERT OR UPDATE OR DELETE ON public.pedido_receipts
  FOR EACH ROW EXECUTE FUNCTION private.protect_finalized_pedido_child();

DROP TRIGGER IF EXISTS protect_catalog_material_code_namespace ON public.catalog_materials;
CREATE TRIGGER protect_catalog_material_code_namespace
  BEFORE INSERT OR UPDATE OF external_code ON public.catalog_materials
  FOR EACH ROW EXECUTE FUNCTION private.protect_catalog_code_namespace();
DROP TRIGGER IF EXISTS protect_catalog_variant_code_namespace ON public.catalog_variants;
CREATE TRIGGER protect_catalog_variant_code_namespace
  BEFORE INSERT OR UPDATE OF external_code, material_id ON public.catalog_variants
  FOR EACH ROW EXECUTE FUNCTION private.protect_catalog_code_namespace();

-- Generic server-authenticated audit coverage. Domain RPCs set audit_reason
-- before mutations when a human reason exists.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'projects', 'project_closing_assignments', 'shifts', 'shift_handovers',
    'drilling_bars', 'material_consumption', 'water_samples',
    'catalog_materials',
    'catalog_variants', 'project_materials', 'material_reconciliations',
    'pedidos', 'pedido_items', 'pedido_receipts', 'completion_reports', 'project_attachments',
    'photos'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%I_mutation ON public.%I', v_table, v_table);
    EXECUTE format(
      'CREATE TRIGGER audit_%I_mutation AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.audit_mutation()',
      v_table, v_table
    );
  END LOOP;
END;
$$;

-- --------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.shifts, public.shift_handovers, public.audit_log,
  public.record_corrections, public.notification_event_claims,
  public.catalog_materials, public.catalog_variants,
  public.project_closing_assignments, public.material_imports,
  public.material_import_lines, public.material_reconciliations,
  public.pedido_items, public.pedido_receipts,
  public.completion_discrepancies, public.water_samples,
  public.project_attachments
FROM anon, authenticated;

-- RPC-only operational tables: direct writes bypass their invariants.
REVOKE INSERT, UPDATE, DELETE ON public.drilling_bars FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.material_consumption FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.project_materials FROM anon, authenticated;

-- Pricing/supplier fields from the retired warehouse model are not operator
-- data. New screens use the safe catalog instead.
DROP POLICY IF EXISTS "Everyone can view materials" ON public.materials;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.materials FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.material_transactions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.progress_reports FROM anon, authenticated;

-- Replace permissive legacy read policies so deactivation takes effect before
-- the JWT expires. Admin branches are already active-aware via is_admin().
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users view own profile for activation check" ON public.profiles;
CREATE POLICY "Users view own profile for activation check"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Active users update own profile" ON public.profiles;
CREATE POLICY "Active users update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (public.is_active_user() AND id = (SELECT auth.uid()))
  WITH CHECK (public.is_active_user() AND id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view assigned projects" ON public.projects;
DROP POLICY IF EXISTS "Active operators view assigned projects" ON public.projects;
CREATE POLICY "Active operators view assigned projects"
  ON public.projects FOR SELECT TO authenticated
  USING (public.is_active_user() AND assigned_operator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view own drilling bars" ON public.drilling_bars;
DROP POLICY IF EXISTS "Active operators view own drilling bars" ON public.drilling_bars;
CREATE POLICY "Active operators view own drilling bars"
  ON public.drilling_bars FOR SELECT TO authenticated
  USING (public.is_active_user() AND operator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view assigned project materials" ON public.project_materials;
DROP POLICY IF EXISTS "Active operators view assigned project materials" ON public.project_materials;
CREATE POLICY "Active operators view assigned project materials"
  ON public.project_materials FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_project_operator(project_id));
DROP POLICY IF EXISTS "Operators can view own consumption" ON public.material_consumption;
DROP POLICY IF EXISTS "Active operators view own consumption" ON public.material_consumption;
CREATE POLICY "Active operators view own consumption"
  ON public.material_consumption FOR SELECT TO authenticated
  USING (public.is_active_user() AND operator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view own reports" ON public.progress_reports;
DROP POLICY IF EXISTS "Active operators view own reports" ON public.progress_reports;
CREATE POLICY "Active operators view own reports"
  ON public.progress_reports FOR SELECT TO authenticated
  USING (public.is_active_user() AND reported_by = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view own pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Active operators view own pedidos" ON public.pedidos;
CREATE POLICY "Active operators view own pedidos"
  ON public.pedidos FOR SELECT TO authenticated
  USING (public.is_active_user() AND operator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view own completion reports" ON public.completion_reports;
DROP POLICY IF EXISTS "Active operators view own completion reports" ON public.completion_reports;
CREATE POLICY "Active operators view own completion reports"
  ON public.completion_reports FOR SELECT TO authenticated
  USING (public.is_active_user() AND operator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Operators can view own project photos" ON public.photos;
DROP POLICY IF EXISTS "Active operators view own project photos" ON public.photos;
CREATE POLICY "Active operators view own project photos"
  ON public.photos FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_project_operator(project_id));
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Active users view own notifications" ON public.notifications;
CREATE POLICY "Active users view own notifications"
  ON public.notifications FOR SELECT TO authenticated
  USING (public.is_active_user() AND user_id = (SELECT auth.uid()));

-- Strengthen the legacy direct-create paths retained during the APK rollout.
DROP POLICY IF EXISTS "Operators can insert their drilling bars" ON public.drilling_bars;
DROP POLICY IF EXISTS "Users can record own consumption" ON public.material_consumption;

DROP POLICY IF EXISTS "Operators can create pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Operators can create assigned-project pedidos" ON public.pedidos;
CREATE POLICY "Operators can create assigned-project pedidos"
  ON public.pedidos FOR INSERT TO authenticated
  WITH CHECK (
    operator_id = (SELECT auth.uid())
    AND public.is_project_operator(project_id)
    AND status = 'Pendiente'
    AND approved_by IS NULL
    AND approved_at IS NULL
    AND rejection_reason IS NULL
    AND closed_manually IS FALSE
    AND closed_by IS NULL
    AND closed_at IS NULL
    AND kind = 'empresa'
    AND request_payload IS NULL
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = pedidos.project_id
        AND p.created_at < timestamptz '2026-07-11 10:29:30+00'
        AND public.project_status_key(p.status) = 'active'
    )
    AND (kind <> 'empresa' OR length(btrim(COALESCE(justification, reason, notes, ''))) >= 3)
  );

DROP POLICY IF EXISTS "Operators can submit completion reports" ON public.completion_reports;
DROP POLICY IF EXISTS "Authorized closer can submit completion reports" ON public.completion_reports;
CREATE POLICY "Authorized closer can submit completion reports"
  ON public.completion_reports FOR INSERT TO authenticated
  WITH CHECK (
    operator_id = (SELECT auth.uid())
    AND public.is_active_user()
    AND format_version = 1
    AND status = 'submitted'
    AND admin_signature IS NULL
    AND finalized_at IS NULL
    AND signed_pdf_attached_at IS NULL
    AND submission_payload IS NULL
    AND last_resubmission_id IS NULL
    AND return_reason IS NULL
    AND returned_by IS NULL
    AND returned_at IS NULL
    AND finalized_snapshot IS NULL
    AND specific_flow_rate IS NULL
    AND maximum_flow_rate IS NULL
    AND pump_depth_m IS NULL
    AND specific_flow_overridden IS FALSE
    AND hydraulic_mismatch IS FALSE
    AND exploration_depth_m IS NULL
    AND widening_depth_m IS NULL
    AND casing_total_m IS NULL
    AND casing_above_ground_m IS NULL
    AND blind_casing_m IS NULL
    AND filter_casing_m IS NULL
    AND sediment_trap_m IS NULL
    AND centralizer_count IS NULL
    AND bottom_plug_details IS NULL
    AND bentonite_quantity IS NULL
    AND gravel_quantity IS NULL
    AND casing_layout = '[]'::jsonb
    AND (pdf_url IS NULL OR (
      pdf_url LIKE project_id::text || '/%'
      AND lower(pdf_url) LIKE '%.pdf'
    ))
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = completion_reports.project_id
        AND p.created_at < timestamptz '2026-07-11 10:29:30+00'
        AND public.project_status_key(p.status) = 'active'
    )
    -- Compatibility only for an old APK on projects that have not entered
    -- the v2 closing workflow. Assigned closers must use submit_completion_v2,
    -- which enforces the compiled Ficha contract atomically.
    AND NOT EXISTS (
      SELECT 1 FROM public.project_closing_assignments a
      WHERE a.project_id = completion_reports.project_id
    )
    AND public.is_project_operator(project_id)
  );

DROP POLICY IF EXISTS "Users can upload photos to accessible projects" ON public.photos;
DROP POLICY IF EXISTS "Active project operators upload photo metadata" ON public.photos;
-- Field evidence always names its shift. Water-sample bottle photos are the
-- sole shift-independent kind; register_water_sample later binds that object
-- to the sample. Closed shifts remain attachable for seven days so an offline
-- queue can upload a photo captured before the shift closed.
CREATE POLICY "Active project operators upload photo metadata"
  ON public.photos FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (SELECT auth.uid())
    AND public.is_project_operator(project_id)
    AND storage_path LIKE project_id::text || '/%'
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'phc-photos' AND o.name = photos.storage_path
    )
    AND (
      (evidence_kind = 'water_sample' AND shift_id IS NULL)
      OR (
        evidence_kind = 'field' AND shift_id IS NULL
        AND now() < timestamptz '2026-08-01 00:00:00+00'
        AND EXISTS (
          SELECT 1 FROM public.projects legacy_project
          WHERE legacy_project.id = photos.project_id
            AND legacy_project.created_at < timestamptz '2026-07-11 10:29:30+00'
        )
      )
      OR (evidence_kind = 'field' AND shift_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.shifts s
        WHERE s.id = photos.shift_id
          AND s.project_id = photos.project_id
          AND s.operator_id = (SELECT auth.uid())
          AND s.status IN ('open', 'report_pending', 'closed')
          AND s.started_at > now() - interval '7 days'
      ))
    )
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = photos.project_id
        AND public.project_status_key(p.status) = 'active'
    )
  );

-- --------------------------------------------------------------------------
-- Catalog, project-material, import, reconciliation and correction RPCs
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_catalog_material(
  p_name text,
  p_unit text,
  p_material_type text,
  p_measurement_method text,
  p_external_code text DEFAULT NULL,
  p_active boolean DEFAULT true,
  p_material_id bigint DEFAULT NULL
)
RETURNS public.catalog_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result public.catalog_materials;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_name, ''))) < 2 OR length(btrim(COALESCE(p_unit, ''))) = 0 THEN
    RAISE EXCEPTION 'Nombre y unidad son obligatorios' USING ERRCODE = '22023';
  END IF;

  IF p_material_id IS NULL THEN
    INSERT INTO public.catalog_materials (
      name, unit, material_type, measurement_method, external_code, active, created_by
    ) VALUES (
      btrim(p_name), btrim(p_unit), p_material_type, p_measurement_method,
      NULLIF(btrim(COALESCE(p_external_code, '')), ''), COALESCE(p_active, true), auth.uid()
    ) RETURNING * INTO v_result;

    INSERT INTO public.catalog_variants (
      material_id, display_name, external_code, dimension_text, created_by
    ) VALUES (
      v_result.id, 'Estándar', NULLIF(btrim(COALESCE(p_external_code, '')), ''),
      'Variante estándar', auth.uid()
    );
  ELSE
    UPDATE public.catalog_materials
    SET name = btrim(p_name),
        unit = btrim(p_unit),
        material_type = p_material_type,
        measurement_method = p_measurement_method,
        external_code = NULLIF(btrim(COALESCE(p_external_code, '')), ''),
        active = COALESCE(p_active, active),
        updated_at = now()
    WHERE id = p_material_id
    RETURNING * INTO v_result;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Material de catálogo no encontrado' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_catalog_variant(
  p_material_id bigint,
  p_display_name text,
  p_external_code text DEFAULT NULL,
  p_diameter text DEFAULT NULL,
  p_length_m real DEFAULT NULL,
  p_dimension_text text DEFAULT NULL,
  p_active boolean DEFAULT true,
  p_variant_id bigint DEFAULT NULL
)
RETURNS public.catalog_variants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result public.catalog_variants;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_display_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Nombre de variante requerido' USING ERRCODE = '22023';
  END IF;

  IF p_variant_id IS NULL THEN
    INSERT INTO public.catalog_variants (
      material_id, display_name, external_code, diameter, length_m,
      dimension_text, active, created_by
    ) VALUES (
      p_material_id, btrim(p_display_name), NULLIF(btrim(COALESCE(p_external_code, '')), ''),
      NULLIF(btrim(COALESCE(p_diameter, '')), ''), p_length_m,
      NULLIF(btrim(COALESCE(p_dimension_text, '')), ''), COALESCE(p_active, true), auth.uid()
    ) RETURNING * INTO v_result;
  ELSE
    UPDATE public.catalog_variants
    SET display_name = btrim(p_display_name),
        external_code = NULLIF(btrim(COALESCE(p_external_code, '')), ''),
        diameter = NULLIF(btrim(COALESCE(p_diameter, '')), ''),
        length_m = p_length_m,
        dimension_text = NULLIF(btrim(COALESCE(p_dimension_text, '')), ''),
        active = COALESCE(p_active, active),
        updated_at = now()
    WHERE id = p_variant_id AND material_id = p_material_id
    RETURNING * INTO v_result;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Variante no encontrada' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_project_closing_operator(
  p_project_id bigint,
  p_operator_id uuid
)
RETURNS public.project_closing_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects;
  v_result public.project_closing_assignments;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.project_status_key(v_project.status) NOT IN ('planning', 'active') THEN
    RAISE EXCEPTION 'No se puede cambiar el responsable de un proyecto finalizado'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_operator_id AND role = 'operator' AND is_active IS TRUE
  ) THEN
    RAISE EXCEPTION 'El operador de cierre debe estar activo' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.project_closing_assignments (project_id, operator_id, assigned_by)
  VALUES (p_project_id, p_operator_id, auth.uid())
  ON CONFLICT (project_id) DO UPDATE
    SET operator_id = EXCLUDED.operator_id,
        assigned_by = auth.uid(),
        updated_at = now()
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_catalog_material_to_project(
  p_project_id bigint,
  p_catalog_variant_id bigint,
  p_quantity real,
  p_layer text DEFAULT 'extras',
  p_notes text DEFAULT NULL
)
RETURNS public.project_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_variant public.catalog_variants;
  v_material public.catalog_materials;
  v_existing public.project_materials;
  v_result public.project_materials;
  v_snapshot text;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_layer NOT IN ('presupuesto', 'extras') THEN
    RAISE EXCEPTION 'Capa de material inválida' USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_allows_planning_change(p_project_id) THEN
    RAISE EXCEPTION 'Proyecto no disponible' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_variant
  FROM public.catalog_variants
  WHERE id = p_catalog_variant_id AND active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Variante no encontrada o inactiva' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_material
  FROM public.catalog_materials
  WHERE id = v_variant.material_id AND active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Material no encontrado o inactivo' USING ERRCODE = 'P0002';
  END IF;

  v_snapshot := CASE
    WHEN public.normalize_catalog_name(v_variant.display_name) = 'estandar'
      THEN v_material.name
    ELSE v_material.name || ' · ' || v_variant.display_name
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'project-material:' || p_project_id::text || ':' || p_catalog_variant_id::text || ':' || p_layer,
      0
    )
  );

  SELECT * INTO v_existing
  FROM public.project_materials
  WHERE project_id = p_project_id
    AND catalog_variant_id = p_catalog_variant_id
    AND layer = p_layer
    AND active IS TRUE
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.project_materials
    SET quantity_allocated = COALESCE(quantity_allocated, initial_quantity, 0) + p_quantity,
        initial_quantity = COALESCE(initial_quantity, 0) + p_quantity,
        current_quantity = COALESCE(current_quantity, 0) + p_quantity,
        notes = COALESCE(p_notes, notes),
        updated_at = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.project_materials (
      project_id, catalog_variant_id, material_name, quantity_allocated,
      initial_quantity, current_quantity, unit, layer, assigned_date, notes, active
    ) VALUES (
      p_project_id, p_catalog_variant_id, v_snapshot, p_quantity,
      p_quantity, p_quantity, v_material.unit, p_layer, now(), p_notes, true
    ) RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_project_material_assignment(
  p_assignment_id bigint,
  p_new_total real,
  p_notes text DEFAULT NULL
)
RETURNS public.project_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.project_materials;
  v_consumed real;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.project_materials WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND OR v_row.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Material asignado no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.project_allows_planning_change(v_row.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite cambios de materiales en su estado actual'
      USING ERRCODE = '55000';
  END IF;
  v_consumed := COALESCE(v_row.initial_quantity, 0) - COALESCE(v_row.current_quantity, 0);
  IF p_new_total IS NULL OR p_new_total < greatest(v_consumed, 0) THEN
    RAISE EXCEPTION 'El total no puede ser menor que el consumo registrado (%)', greatest(v_consumed, 0)
      USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Ajuste de cantidad asignada'), true);
  UPDATE public.project_materials
  SET initial_quantity = p_new_total,
      quantity_allocated = p_new_total,
      current_quantity = p_new_total - v_consumed,
      notes = COALESCE(p_notes, notes),
      updated_at = now()
  WHERE id = p_assignment_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_project_material_assignment(
  p_assignment_id bigint,
  p_reason text
)
RETURNS public.project_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.project_materials;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.project_materials WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND OR v_row.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Material asignado no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.project_allows_planning_change(v_row.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite cambios de materiales en su estado actual'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.material_consumption WHERE project_material_id = p_assignment_id
  ) THEN
    RAISE EXCEPTION 'No se puede quitar un material con consumo; ajusta el total o registra una corrección'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('phc.audit_reason', p_reason, true);
  UPDATE public.project_materials
  SET active = false, updated_at = now(), notes = concat_ws(' · ', notes, p_reason)
  WHERE id = p_assignment_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_project_materials(
  p_project_id bigint,
  p_document_number text,
  p_lines jsonb,
  p_source_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.material_imports;
  v_import public.material_imports;
  v_line jsonb;
  v_line_no integer := 0;
  v_variant_id bigint;
  v_material_id bigint;
  v_assignment public.project_materials;
  v_included integer := 0;
  v_quantity real;
  v_description text;
  v_unit text;
  v_code text;
  v_layer text;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_document_number, ''))) = 0 THEN
    RAISE EXCEPTION 'Número de documento requerido' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'La importación debe contener líneas' USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_allows_planning_change(p_project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite importaciones en su estado actual'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_existing
  FROM public.material_imports
  WHERE project_id = p_project_id AND document_number = btrim(p_document_number);
  IF FOUND THEN
    RETURN jsonb_build_object(
      'import_id', v_existing.id,
      'idempotent_replay', true,
      'line_count', v_existing.line_count
    );
  END IF;

  INSERT INTO public.material_imports (
    project_id, document_number, source_name, line_count, imported_by
  ) VALUES (
    p_project_id, btrim(p_document_number), p_source_name, jsonb_array_length(p_lines), auth.uid()
  ) RETURNING * INTO v_import;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_line_no := v_line_no + 1;
    v_variant_id := NULL;
    v_material_id := NULL;
    v_assignment := NULL;
    IF v_line ?| ARRAY[
      'price', 'precio', 'cost', 'costo', 'iva', 'tax', 'subtotal',
      'total', 'advance', 'anticipo', 'balance', 'saldo'
    ] THEN
      RAISE EXCEPTION 'La línea % contiene datos contables prohibidos', v_line_no
        USING ERRCODE = '22023';
    END IF;

    v_description := btrim(COALESCE(v_line ->> 'description', v_line ->> 'name', ''));
    v_unit := btrim(COALESCE(v_line ->> 'unit', 'unidad'));
    v_code := NULLIF(btrim(COALESCE(v_line ->> 'external_code', v_line ->> 'code', '')), '');
    v_quantity := COALESCE((v_line ->> 'quantity')::real, 0);
    v_layer := COALESCE(NULLIF(v_line ->> 'layer', ''), 'presupuesto');
    IF v_description = '' OR v_quantity <= 0 OR v_layer NOT IN ('presupuesto', 'extras') THEN
      RAISE EXCEPTION 'Línea de importación inválida: %', v_line_no USING ERRCODE = '22023';
    END IF;

    v_variant_id := NULLIF(v_line ->> 'catalog_variant_id', '')::bigint;
    IF v_variant_id IS NULL AND v_code IS NOT NULL THEN
      SELECT id INTO v_variant_id
      FROM public.catalog_variants
      WHERE upper(btrim(external_code)) = upper(v_code) AND active IS TRUE;
    END IF;
    IF v_variant_id IS NULL AND v_code IS NOT NULL THEN
      SELECT id INTO v_material_id
      FROM public.catalog_materials
      WHERE upper(btrim(external_code)) = upper(v_code) AND active IS TRUE;
      IF v_material_id IS NOT NULL THEN
        SELECT id INTO v_variant_id
        FROM public.catalog_variants
        WHERE material_id = v_material_id AND active IS TRUE
        ORDER BY id LIMIT 1;
      END IF;
    END IF;
    IF v_variant_id IS NULL AND COALESCE((v_line ->> 'create_new')::boolean, false) THEN
      INSERT INTO public.catalog_materials (
        name, external_code, material_type, unit, measurement_method, created_by
      ) VALUES (
        v_description, v_code, COALESCE(v_line ->> 'material_type', 'other'), v_unit,
        COALESCE(v_line ->> 'measurement_method', 'quantity'), auth.uid()
      ) RETURNING id INTO v_material_id;
      INSERT INTO public.catalog_variants (
        material_id, display_name, external_code, dimension_text, created_by
      ) VALUES (v_material_id, 'Estándar', v_code, v_description, auth.uid())
      RETURNING id INTO v_variant_id;
    END IF;

    IF COALESCE((v_line ->> 'included')::boolean, true) AND v_variant_id IS NULL THEN
      RAISE EXCEPTION 'Línea % sin coincidencia; confirma una variante o marca create_new', v_line_no
        USING ERRCODE = '22023';
    END IF;

    IF COALESCE((v_line ->> 'included')::boolean, true) THEN
      SELECT * INTO v_assignment
      FROM public.assign_catalog_material_to_project(
        p_project_id, v_variant_id, v_quantity, v_layer,
        'Importado de ' || btrim(p_document_number)
      );
      v_included := v_included + 1;
    ELSE
      v_assignment := NULL;
    END IF;

    INSERT INTO public.material_import_lines (
      import_id, line_number, external_code, description_snapshot, quantity,
      unit_snapshot, included, layer, catalog_variant_id, project_material_id
    ) VALUES (
      v_import.id, v_line_no, v_code, v_description, v_quantity, v_unit,
      COALESCE((v_line ->> 'included')::boolean, true), v_layer, v_variant_id,
      v_assignment.id
    );
  END LOOP;

  PERFORM private.write_audit(
    p_project_id, 'material_import.completed', 'material_imports', v_import.id::text,
    NULL, to_jsonb(v_import), NULL,
    jsonb_build_object('included_lines', v_included, 'document_number', p_document_number)
  );

  RETURN jsonb_build_object(
    'import_id', v_import.id,
    'idempotent_replay', false,
    'line_count', v_line_no,
    'included_count', v_included
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_material_reconciliation(
  p_project_id bigint,
  p_project_material_id bigint,
  p_returned_quantity real,
  p_notes text DEFAULT NULL
)
RETURNS public.material_reconciliations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_material public.project_materials;
  v_consumed real;
  v_result public.material_reconciliations;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_material
  FROM public.project_materials
  WHERE id = p_project_material_id AND project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Material asignado no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF v_material.active IS NOT TRUE OR NOT public.project_allows_closure_change(p_project_id) THEN
    RAISE EXCEPTION 'El proyecto/material no admite reconciliación en su estado actual'
      USING ERRCODE = '55000';
  END IF;
  v_consumed := COALESCE(v_material.initial_quantity, 0) - COALESCE(v_material.current_quantity, 0);
  IF p_returned_quantity IS NULL OR p_returned_quantity < 0
     OR p_returned_quantity > greatest(COALESCE(v_material.initial_quantity, 0) - greatest(v_consumed, 0), 0) THEN
    RAISE EXCEPTION 'Cantidad devuelta inválida' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Reconciliación de cierre'), true);
  INSERT INTO public.material_reconciliations (
    project_id, project_material_id, sent_quantity, consumed_quantity,
    returned_quantity, notes, created_by
  ) VALUES (
    p_project_id, p_project_material_id, COALESCE(v_material.initial_quantity, 0),
    greatest(v_consumed, 0), p_returned_quantity, p_notes, auth.uid()
  )
  ON CONFLICT (project_id, project_material_id) DO UPDATE
    SET sent_quantity = EXCLUDED.sent_quantity,
        consumed_quantity = EXCLUDED.consumed_quantity,
        returned_quantity = EXCLUDED.returned_quantity,
        notes = EXCLUDED.notes,
        updated_at = now()
  RETURNING * INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_admin_correction(
  p_entity_type text,
  p_entity_id text,
  p_field_name text,
  p_corrected_value jsonb,
  p_reason text
)
RETURNS public.record_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_original jsonb;
  v_project_id bigint;
  v_result public.record_corrections;
  v_row_found boolean := false;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_entity_type NOT IN ('drilling_bars', 'shifts', 'material_consumption', 'water_samples', 'completion_reports') THEN
    RAISE EXCEPTION 'Tipo de entidad no corregible' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(COALESCE(p_field_name, ''))) = 0
     OR length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Campo y motivo son obligatorios' USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (p_entity_type = 'drilling_bars' AND p_field_name = ANY (ARRAY[
      'depth_start', 'depth_end', 'length', 'diameter', 'soil_type',
      'start_time', 'end_time', 'duration_minutes', 'water_level', 'notes'
    ]))
    OR (p_entity_type = 'shifts' AND p_field_name = ANY (ARRAY[
      'started_at', 'ended_at', 'end_type', 'notes'
    ]))
    OR (p_entity_type = 'material_consumption' AND p_field_name = ANY (ARRAY[
      'quantity_used', 'unit', 'date', 'notes', 'approximate'
    ]))
    OR (p_entity_type = 'water_samples' AND p_field_name = ANY (ARRAY[
      'sample_number', 'depth_m', 'stage', 'notes', 'taken_at'
    ]))
    OR (p_entity_type = 'completion_reports' AND p_field_name = ANY (ARRAY[
      'static_level', 'dynamic_level', 'flow_rate', 'specific_flow_rate',
      'maximum_flow_rate', 'pump_depth_m', 'exploration_depth_m',
      'widening_depth_m', 'casing_total_m', 'casing_above_ground_m',
      'blind_casing_m', 'filter_casing_m', 'sediment_trap_m',
      'centralizer_count', 'bottom_plug_details', 'bentonite_quantity',
      'gravel_quantity', 'casing_layout', 'compressor_hours', 'pump_hours',
      'water_quality', 'completion_notes'
    ]))
  ) THEN
    RAISE EXCEPTION 'Campo no permitido para corrección: %.%', p_entity_type, p_field_name
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'SELECT to_jsonb(t) -> %L, NULLIF(to_jsonb(t) ->> ''project_id'', '''')::bigint, true FROM public.%I t WHERE t.id::text = $1',
    p_field_name, p_entity_type
  ) INTO v_original, v_project_id, v_row_found USING p_entity_id;
  IF v_row_found IS NOT TRUE THEN
    RAISE EXCEPTION 'Registro no encontrado' USING ERRCODE = 'P0002';
  END IF;
  SELECT c.corrected_value INTO v_original
  FROM public.record_corrections c
  WHERE c.entity_type = p_entity_type
    AND c.entity_id = p_entity_id
    AND c.field_name = p_field_name
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1;
  -- FOUND refers only to the query above; when there is no prior correction,
  -- keep the raw field value already loaded by the dynamic SELECT.
  IF NOT FOUND THEN
    EXECUTE format(
      'SELECT to_jsonb(t) -> %L FROM public.%I t WHERE t.id::text = $1',
      p_field_name, p_entity_type
    ) INTO v_original USING p_entity_id;
  END IF;
  IF v_original IS NOT DISTINCT FROM p_corrected_value THEN
    RAISE EXCEPTION 'El valor corregido debe diferir del valor vigente'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = v_project_id
      AND public.project_status_key(p.status) = 'completed'
  ) THEN
    RAISE EXCEPTION 'El dossier firmado es inmutable; registra una enmienda externa'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.record_corrections (
    project_id, entity_type, entity_id, field_name, original_value,
    corrected_value, corrected_by, reason
  ) VALUES (
    v_project_id, p_entity_type, p_entity_id, p_field_name,
    COALESCE(v_original, 'null'::jsonb), p_corrected_value, auth.uid(), btrim(p_reason)
  ) RETURNING * INTO v_result;

  PERFORM private.write_audit(
    v_project_id, 'record.corrected', p_entity_type, p_entity_id,
    jsonb_build_object(p_field_name, v_original),
    jsonb_build_object(p_field_name, p_corrected_value), p_reason,
    jsonb_build_object('correction_id', v_result.id)
  );
  RETURN v_result;
END;
$$;

-- --------------------------------------------------------------------------
-- Shift lifecycle and shift-bound operational RPCs
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_shift(
  p_project_id bigint,
  p_shift_id uuid,
  p_client_entry_id text,
  p_started_at timestamptz DEFAULT NULL,
  p_device_started_at timestamptz DEFAULT NULL
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.shifts;
  v_result public.shifts;
  v_started timestamptz := COALESCE(p_started_at, now());
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_field_work(p_project_id) THEN
    RAISE EXCEPTION 'Project is not open for a new shift' USING ERRCODE = '55000';
  END IF;
  IF p_shift_id IS NULL OR length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'shift_id and client_entry_id are required' USING ERRCODE = '22023';
  END IF;
  IF v_started > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Shift start cannot be more than 15 minutes in the future'
      USING ERRCODE = '22023';
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id,
    'started_at', v_started,
    'device_started_at', p_device_started_at
  ));

  -- Authorize first, then honor an idempotent replay only for the same actor
  -- and project. A globally guessed key can never return another user's row.
  SELECT * INTO v_existing
  FROM public.shifts
  WHERE id = p_shift_id OR client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key belongs to another shift' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_existing
  FROM public.shifts
  WHERE operator_id = auth.uid() AND status IN ('open', 'report_pending')
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'open' AND v_existing.started_at <= now() - interval '12 hours' THEN
      UPDATE public.shifts
      SET status = 'report_pending',
          ended_at = v_existing.started_at + interval '12 hours',
          end_type = 'auto',
          device_time_flag = true,
          updated_at = now()
      WHERE id = v_existing.id
      RETURNING * INTO v_existing;
    END IF;
    -- Returning the unresolved shift (instead of raising) commits the
    -- auto-close. The client must inspect status and finish its usage report.
    RETURN v_existing;
  END IF;

  INSERT INTO public.shifts (
    id, client_entry_id, project_id, operator_id, status,
    started_at, ended_at, start_device_time, end_type,
    device_time_flag, request_payload
  ) VALUES (
    p_shift_id, p_client_entry_id, p_project_id, auth.uid(),
    CASE WHEN v_started <= now() - interval '12 hours' THEN 'report_pending' ELSE 'open' END,
    v_started,
    CASE WHEN v_started <= now() - interval '12 hours' THEN v_started + interval '12 hours' END,
    p_device_started_at,
    CASE WHEN v_started <= now() - interval '12 hours' THEN 'auto' END,
    abs(extract(epoch FROM (now() - v_started))) > 900
      OR (p_device_started_at IS NOT NULL AND abs(extract(epoch FROM (v_started - p_device_started_at))) > 900),
    v_payload
  ) RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_shift_handover(
  p_shift_id uuid,
  p_items jsonb
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shift public.shifts;
  v_item jsonb;
  v_assignment public.project_materials;
  v_status text;
  v_client_entry_id text;
  v_observed real;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002';
  END IF;
  -- report_pending must stay confirmable: drilling sites sync queues hours or
  -- days late, and the auto-close that fires meanwhile is already flagged via
  -- end_type = 'auto'. Rejecting stale-but-queued handovers would strand the
  -- whole offline shift package (handover -> bars -> usage report).
  IF v_shift.operator_id IS DISTINCT FROM auth.uid()
     OR v_shift.status NOT IN ('open', 'report_pending') THEN
    RAISE EXCEPTION 'Only the operator can confirm an unresolved shift handover'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_field_work(v_shift.project_id) THEN
    RAISE EXCEPTION 'Project is not open for field work' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(COALESCE(p_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'items must be an array' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item
    GROUP BY item ->> 'project_material_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Each handover material may appear only once' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item
    LEFT JOIN public.project_materials pm
      ON pm.id = NULLIF(item ->> 'project_material_id', '')::bigint
     AND pm.project_id = v_shift.project_id
     AND pm.active IS TRUE
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'A handover item is not an active material in this project'
      USING ERRCODE = '22023';
  END IF;

  -- The payload is exception-based. Empty means "confirm all"; the server
  -- still snapshots one immutable testimony row for every active assignment.
  FOR v_assignment IN
    SELECT * FROM public.project_materials
    WHERE project_id = v_shift.project_id AND active IS TRUE
    ORDER BY id
    FOR UPDATE
  LOOP
    v_item := NULL;
    SELECT value INTO v_item
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
    WHERE (value ->> 'project_material_id')::bigint = v_assignment.id
    LIMIT 1;
    v_status := COALESCE(v_item ->> 'status', 'confirmed');
    v_client_entry_id := COALESCE(
      NULLIF(v_item ->> 'client_entry_id', ''),
      'handover:' || p_shift_id::text || ':' || v_assignment.id::text
    );
    IF v_status NOT IN ('confirmed', 'flagged') THEN
      RAISE EXCEPTION 'Invalid handover status' USING ERRCODE = '22023';
    END IF;
    v_observed := NULLIF(v_item ->> 'observed_quantity', '')::real;
    IF v_status = 'flagged' AND v_observed IS NULL THEN
      RAISE EXCEPTION 'A flagged handover requires the observed quantity'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.shift_handovers (
      client_entry_id, shift_id, project_material_id, status,
      expected_quantity, observed_quantity, note, photo_path, confirmed_by
    ) VALUES (
      v_client_entry_id, p_shift_id, v_assignment.id, v_status,
      COALESCE(v_assignment.current_quantity, 0),
      v_observed,
      NULLIF(v_item ->> 'note', ''), NULLIF(v_item ->> 'photo_path', ''), auth.uid()
    )
    ON CONFLICT (shift_id, project_material_id) DO NOTHING;
  END LOOP;

  UPDATE public.shifts
  SET handover_confirmed = true, updated_at = now()
  WHERE id = p_shift_id
  RETURNING * INTO v_shift;

  PERFORM private.write_audit(
    v_shift.project_id, 'shift.handover_confirmed', 'shifts', v_shift.id::text,
    NULL, to_jsonb(v_shift), NULL,
    jsonb_build_object('item_count', jsonb_array_length(COALESCE(p_items, '[]'::jsonb)))
  );
  RETURN v_shift;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_shift(
  p_shift_id uuid,
  p_usage jsonb,
  p_notes text DEFAULT NULL,
  p_device_ended_at timestamptz DEFAULT NULL,
  p_end_type text DEFAULT 'manual'
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shift public.shifts;
  v_item jsonb;
  v_assignment public.project_materials;
  v_quantity real;
  v_client_entry_id text;
  v_anomaly boolean;
  v_inserted_id bigint;
  v_end_payload jsonb;
  v_authoritative_end timestamptz;
  v_effective_end_type text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_end_type NOT IN ('manual', 'auto') THEN
    RAISE EXCEPTION 'Invalid shift end type' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_usage, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'usage must be an array; [] is the explicit zero report'
      USING ERRCODE = '22023';
  END IF;
  v_end_payload := jsonb_strip_nulls(jsonb_build_object(
    'usage', COALESCE(p_usage, '[]'::jsonb),
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'device_ended_at', p_device_ended_at,
    'requested_end_type', p_end_type
  ));

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this shift' USING ERRCODE = '42501';
  END IF;
  IF v_shift.status = 'closed' AND v_shift.usage_report_submitted THEN
    IF v_shift.request_payload -> 'end' IS DISTINCT FROM v_end_payload THEN
      RAISE EXCEPTION 'Idempotency replay does not match the submitted shift report'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_shift;
  END IF;
  IF v_shift.status NOT IN ('open', 'report_pending') THEN
    RAISE EXCEPTION 'Shift cannot be closed from status %', v_shift.status
      USING ERRCODE = '22023';
  END IF;
  -- An auto-closed (report_pending) shift must still deliver its usage report:
  -- the missed handover is already flagged through end_type = 'auto', and the
  -- operator UI offers no handover step once the shift left 'open'.
  IF v_shift.handover_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm the shift handover before closing the shift'
      USING ERRCODE = '55000';
  END IF;

  v_authoritative_end := now();
  IF p_device_ended_at IS NOT NULL
     AND p_device_ended_at >= v_shift.started_at
     AND p_device_ended_at <= now() + interval '15 minutes' THEN
    v_authoritative_end := least(p_device_ended_at, now());
  END IF;
  IF v_authoritative_end >= v_shift.started_at + interval '12 hours'
     OR v_shift.status = 'report_pending' THEN
    v_authoritative_end := v_shift.started_at + interval '12 hours';
    v_effective_end_type := 'auto';
  ELSE
    v_effective_end_type := p_end_type;
  END IF;

  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Cierre de turno'), true);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_usage, '[]'::jsonb)) item
    GROUP BY item ->> 'project_material_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cada material debe aparecer una sola vez en el informe de turno'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id AND pm.active IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p_usage, '[]'::jsonb)) item
        WHERE NULLIF(item ->> 'project_material_id', '')::bigint = pm.id
      )
  ) THEN
    RAISE EXCEPTION 'El informe debe confirmar uso exacto/cero para cada material activo'
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_usage, '[]'::jsonb)) LOOP
    v_quantity := COALESCE((v_item ->> 'quantity_used')::real, 0);
    IF v_quantity < 0 THEN
      RAISE EXCEPTION 'Usage cannot be negative' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = (v_item ->> 'project_material_id')::bigint
      AND project_id = v_shift.project_id
      AND active IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assigned material not found in shift project'
        USING ERRCODE = 'P0002';
    END IF;

    -- Zero quantities remain part of the explicit report but need no row;
    -- shifts.usage_report_submitted distinguishes zero from missing.
    IF v_quantity > 0 THEN
      v_client_entry_id := COALESCE(
        NULLIF(v_item ->> 'client_entry_id', ''),
        'shift-usage:' || p_shift_id::text || ':' || v_assignment.id::text
      );
      v_anomaly := v_quantity > COALESCE(v_assignment.current_quantity, 0);
      v_inserted_id := NULL;

      INSERT INTO public.material_consumption (
        client_entry_id, project_id, operator_id, shift_id,
        project_material_id, material_id, material_name, quantity_used,
        unit, date, notes, approximate, anomaly_flag
      ) VALUES (
        v_client_entry_id, v_shift.project_id, v_shift.operator_id, v_shift.id,
        v_assignment.id, v_assignment.material_id, v_assignment.material_name,
        v_quantity, v_assignment.unit, COALESCE((v_item ->> 'date')::date, CURRENT_DATE),
        NULLIF(v_item ->> 'notes', ''),
        COALESCE((v_item ->> 'approximate')::boolean, false), v_anomaly
      )
      ON CONFLICT (client_entry_id) DO NOTHING
      RETURNING id INTO v_inserted_id;

      IF v_inserted_id IS NOT NULL THEN
        UPDATE public.project_materials
        SET current_quantity = COALESCE(current_quantity, 0) - v_quantity,
            updated_at = now()
        WHERE id = v_assignment.id;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.shifts
  SET status = 'closed',
      ended_at = v_authoritative_end,
      end_device_time = COALESCE(p_device_ended_at, end_device_time),
      end_type = v_effective_end_type,
      usage_report_submitted = true,
      notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
      device_time_flag = device_time_flag OR (
        p_device_ended_at IS NOT NULL
        AND (
          p_device_ended_at < started_at
          OR p_device_ended_at > now() + interval '15 minutes'
        )
      ) OR v_effective_end_type = 'auto',
      request_payload = COALESCE(request_payload, '{}'::jsonb)
        || jsonb_build_object('end', v_end_payload),
      updated_at = now()
  WHERE id = p_shift_id
  RETURNING * INTO v_shift;

  PERFORM private.write_audit(
    v_shift.project_id, 'shift.closed', 'shifts', v_shift.id::text,
    NULL, to_jsonb(v_shift), p_notes,
    jsonb_build_object('usage_lines', jsonb_array_length(COALESCE(p_usage, '[]'::jsonb)))
  );
  RETURN v_shift;
END;
$$;

-- Replace create_drilling_bar with a single non-overloaded, shift-aware
-- signature. Existing APKs may omit p_shift_id during the transition.
DROP FUNCTION IF EXISTS public.create_drilling_bar(
  bigint, text, text, real, text, text, text, integer, real, text, text, text
);

DROP FUNCTION IF EXISTS public.create_drilling_bar(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid);

CREATE FUNCTION public.create_drilling_bar(
  p_project_id bigint,
  p_soil_type text,
  p_client_entry_id text DEFAULT NULL,
  p_length real DEFAULT NULL,
  p_diameter text DEFAULT NULL,
  p_start_time text DEFAULT NULL,
  p_end_time text DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL,
  p_water_level real DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_photo_paths text DEFAULT NULL,
  p_timestamp_local text DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL
)
RETURNS public.drilling_bars
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects;
  v_shift public.shifts;
  v_existing public.drilling_bars;
  v_last_bar integer;
  v_current_depth real;
  v_length real;
  v_result public.drilling_bars;
  v_progress integer;
  v_request_payload jsonb;
  v_captured_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'Project is not active' USING ERRCODE = '55000';
  END IF;
  IF p_shift_id IS NOT NULL THEN
    -- report_pending is accepted and no wall-clock recency is enforced: queued
    -- offline bars replay long after the field moment. Late attachment stays
    -- visible through the shift's auto-close flag and the row's created_at.
    SELECT * INTO v_shift
    FROM public.shifts
    WHERE id = p_shift_id AND project_id = p_project_id
      AND operator_id = auth.uid() AND status IN ('open', 'report_pending')
      AND handover_confirmed IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A current, handover-confirmed shift for this project is required'
        USING ERRCODE = '55000';
    END IF;
    IF NULLIF(btrim(COALESCE(p_timestamp_local, '')), '') IS NOT NULL THEN
      BEGIN
        v_captured_at := p_timestamp_local::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'timestamp_local must be an ISO timestamp'
          USING ERRCODE = '22023';
      END;
    END IF;
    IF (v_shift.status = 'report_pending' OR v_shift.started_at <= now() - interval '12 hours')
       AND v_captured_at IS NULL THEN
      RAISE EXCEPTION 'A delayed/offline bar requires its captured timestamp'
        USING ERRCODE = '22023';
    END IF;
    IF v_captured_at IS NOT NULL AND (
      v_captured_at < v_shift.started_at - interval '15 minutes'
      OR v_captured_at > v_shift.started_at + interval '12 hours 15 minutes'
    ) THEN
      RAISE EXCEPTION 'Bar timestamp is outside the shift evidence window'
        USING ERRCODE = '22023';
    END IF;
  ELSIF now() >= timestamptz '2026-08-01 00:00:00+00'
     OR v_project.created_at >= timestamptz '2026-07-11 10:29:30+00' THEN
    RAISE EXCEPTION 'SHIFT_REQUIRED: update the app and start a shift first'
      USING ERRCODE = '0A000';
  END IF;

  v_request_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'soil_type', btrim(p_soil_type),
    'length', p_length, 'diameter', p_diameter,
    'start_time', p_start_time, 'end_time', p_end_time,
    'duration_minutes', p_duration_minutes, 'water_level', p_water_level,
    'notes', p_notes, 'photo_paths', p_photo_paths,
    'timestamp_local', p_timestamp_local, 'shift_id', p_shift_id
  ));

  IF p_client_entry_id IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.drilling_bars
    WHERE client_entry_id = p_client_entry_id;
    IF FOUND THEN
      IF v_existing.operator_id IS DISTINCT FROM auth.uid()
         OR v_existing.project_id IS DISTINCT FROM p_project_id
         OR v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;
  IF length(btrim(COALESCE(p_soil_type, ''))) = 0 THEN
    RAISE EXCEPTION 'soil_type is required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(bar_number), 0), COALESCE(MAX(depth_end), 0)
  INTO v_last_bar, v_current_depth
  FROM public.drilling_bars WHERE project_id = p_project_id;
  v_length := COALESCE(p_length, v_project.default_bar_length, 3);
  IF v_length <= 0 THEN
    RAISE EXCEPTION 'length must be positive' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.drilling_bars (
    client_entry_id, project_id, operator_id, shift_id, bar_number,
    depth_start, depth_end, length, diameter, soil_type, start_time,
    end_time, duration_minutes, water_level, notes, photo_paths, timestamp_local,
    request_payload
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), p_shift_id, v_last_bar + 1,
    v_current_depth, v_current_depth + v_length, v_length,
    COALESCE(p_diameter, v_project.default_bar_diameter), btrim(p_soil_type),
    p_start_time, p_end_time, p_duration_minutes, p_water_level, p_notes,
    p_photo_paths, COALESCE(p_timestamp_local, now()::text), v_request_payload
  ) RETURNING * INTO v_result;

  IF v_project.target_depth IS NOT NULL AND v_project.target_depth > 0 THEN
    v_progress := least(100, round((v_result.depth_end / v_project.target_depth) * 100));
    UPDATE public.projects
    SET progress_percentage = v_progress, updated_at = now()
    WHERE id = p_project_id;
  END IF;
  RETURN v_result;
END;
$$;

DROP FUNCTION IF EXISTS public.record_material_consumption(
  bigint, real, text, bigint, bigint, text, text, date, text
);

DROP FUNCTION IF EXISTS public.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean);

CREATE FUNCTION public.record_material_consumption(
  p_project_id bigint,
  p_quantity_used real,
  p_client_entry_id text DEFAULT NULL,
  p_project_material_id bigint DEFAULT NULL,
  p_material_id bigint DEFAULT NULL,
  p_material_name text DEFAULT NULL,
  p_unit text DEFAULT NULL,
  p_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_approximate boolean DEFAULT false
)
RETURNS public.material_consumption
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.material_consumption;
  v_assignment public.project_materials;
  v_result public.material_consumption;
  v_anomaly boolean := false;
  v_request_payload jsonb;
  v_project public.projects;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND OR public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'Project is not open for consumption' USING ERRCODE = '55000';
  END IF;
  IF p_quantity_used IS NULL OR p_quantity_used <= 0 THEN
    RAISE EXCEPTION 'quantity_used must be positive' USING ERRCODE = '22023';
  END IF;

  v_request_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'quantity_used', p_quantity_used,
    'project_material_id', p_project_material_id, 'material_id', p_material_id,
    'material_name', p_material_name, 'unit', p_unit, 'date', p_date,
    'notes', p_notes, 'shift_id', p_shift_id,
    'approximate', COALESCE(p_approximate, false)
  ));

  IF p_client_entry_id IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.material_consumption
    WHERE client_entry_id = p_client_entry_id;
    IF FOUND THEN
      IF v_existing.operator_id IS DISTINCT FROM auth.uid()
         OR v_existing.project_id IS DISTINCT FROM p_project_id
         OR v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  IF p_project_material_id IS NOT NULL THEN
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = p_project_material_id AND project_id = p_project_id AND active IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assigned material not found' USING ERRCODE = 'P0002';
    END IF;
    v_anomaly := p_quantity_used > COALESCE(v_assignment.current_quantity, 0);
  END IF;
  IF p_shift_id IS NOT NULL THEN
    -- No wall-clock recency: queued offline consumption replays late by design.
    IF NOT EXISTS (
      SELECT 1 FROM public.shifts
      WHERE id = p_shift_id AND project_id = p_project_id
        AND operator_id = auth.uid() AND status IN ('open', 'report_pending')
        AND handover_confirmed IS TRUE
    ) THEN
      RAISE EXCEPTION 'Current handover-confirmed shift required' USING ERRCODE = '42501';
    END IF;
  ELSIF now() >= timestamptz '2026-08-01 00:00:00+00'
     OR v_project.created_at >= timestamptz '2026-07-11 10:29:30+00' THEN
    RAISE EXCEPTION 'SHIFT_REQUIRED: update the app and close usage through a shift'
      USING ERRCODE = '0A000';
  END IF;

  INSERT INTO public.material_consumption (
    client_entry_id, project_id, operator_id, shift_id, project_material_id,
    material_id, material_name, quantity_used, unit, date, notes,
    approximate, anomaly_flag, request_payload
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), p_shift_id, p_project_material_id,
    COALESCE(p_material_id, v_assignment.material_id),
    COALESCE(p_material_name, v_assignment.material_name, 'Material'),
    p_quantity_used, COALESCE(p_unit, v_assignment.unit), COALESCE(p_date, CURRENT_DATE),
    p_notes, COALESCE(p_approximate, false), v_anomaly, v_request_payload
  ) RETURNING * INTO v_result;

  IF v_assignment.id IS NOT NULL THEN
    UPDATE public.project_materials
    SET current_quantity = COALESCE(current_quantity, 0) - p_quantity_used,
        updated_at = now()
    WHERE id = v_assignment.id;
  END IF;
  RETURN v_result;
END;
$$;

-- --------------------------------------------------------------------------
-- Pedidos v2 RPCs: multi-item decisions and receipt-only inventory effects
-- --------------------------------------------------------------------------

-- Serialize the legacy human-readable daily counter. The previous COUNT+1
-- trigger raced under offline/concurrent sync and could fail a valid pedido.
CREATE OR REPLACE FUNCTION public.generate_pedido_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_date date := COALESCE(NEW.created_at::date, CURRENT_DATE);
  v_count integer;
BEGIN
  IF NEW.pedido_number IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pedido-number:' || v_date::text, 0)
  );
  SELECT count(*) + 1 INTO v_count
  FROM public.pedidos p
  WHERE p.created_at::date = v_date;
  NEW.pedido_number := 'PHC-' || to_char(v_date, 'YYYYMMDD') || '-'
    || lpad(v_count::text, 3, '0');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_legacy_pedido_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('phc.pedido_v2_insert', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.pedido_number IS NOT NULL
     OR NEW.status IS DISTINCT FROM 'Pendiente'
     OR NEW.kind IS DISTINCT FROM 'empresa'
     OR NEW.admin_notes IS NOT NULL
     OR NEW.pdf_url IS NOT NULL
     OR NEW.approved_by IS NOT NULL
     OR NEW.approved_at IS NOT NULL
     OR NEW.rejection_reason IS NOT NULL
     OR NEW.closed_manually IS TRUE
     OR NEW.closed_by IS NOT NULL
     OR NEW.closed_at IS NOT NULL
     OR NEW.request_payload IS NOT NULL THEN
    RAISE EXCEPTION 'PEDIDOS_V2_RPC_REQUIRED: legacy inserts cannot set lifecycle/admin fields'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_protect_legacy_pedido_insert ON public.pedidos;
CREATE TRIGGER a_protect_legacy_pedido_insert
  BEFORE INSERT ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION private.protect_legacy_pedido_insert();

CREATE OR REPLACE FUNCTION private.create_legacy_pedido_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF current_setting('phc.pedido_v2_insert', true) = 'on' THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.pedido_items (
    pedido_id, material_name_snapshot, requested_quantity, unit_snapshot, state
  ) VALUES (
    NEW.id,
    COALESCE(NULLIF(btrim(NEW.material), ''), 'Material'),
    greatest(COALESCE(NEW.quantity, 1), 0.000001),
    'unidad',
    'solicitado'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS create_legacy_pedido_item ON public.pedidos;
CREATE TRIGGER create_legacy_pedido_item
  AFTER INSERT ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION private.create_legacy_pedido_item();

CREATE OR REPLACE FUNCTION private.recompute_pedido_status(p_pedido_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer;
  v_requested integer;
  v_approved integer;
  v_in_delivery integer;
  v_terminal integer;
  v_rejected integer;
  v_status text;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE state = 'solicitado'),
    count(*) FILTER (WHERE state = 'aprobado'),
    count(*) FILTER (WHERE state = 'parcial'),
    count(*) FILTER (WHERE state IN ('recibido', 'rechazado', 'no_recibido')),
    count(*) FILTER (WHERE state = 'rechazado')
  INTO v_total, v_requested, v_approved, v_in_delivery, v_terminal, v_rejected
  FROM public.pedido_items WHERE pedido_id = p_pedido_id;

  v_status := CASE
    WHEN v_total = 0 OR v_requested = v_total THEN 'Pendiente'
    WHEN v_terminal = v_total THEN 'Cerrado'
    WHEN v_in_delivery > 0 THEN 'En entrega'
    WHEN v_approved > 0 THEN 'Aprobado'
    WHEN v_rejected > 0 AND v_requested > 0 THEN 'Decisión parcial'
    ELSE 'Pendiente'
  END;
  UPDATE public.pedidos SET status = v_status, updated_at = now() WHERE id = p_pedido_id;
END;
$$;

REVOKE ALL ON FUNCTION private.recompute_pedido_status(bigint)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_pedido_v2(
  p_project_id bigint,
  p_kind text,
  p_items jsonb,
  p_client_entry_id text,
  p_justification text DEFAULT NULL,
  p_priority text DEFAULT 'Normal',
  p_needed_by date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.pedidos;
  v_pedido public.pedidos;
  v_item jsonb;
  v_first jsonb;
  v_item_count integer := 0;
  v_total_quantity real := 0;
  v_variant public.catalog_variants;
  v_material public.catalog_materials;
  v_name text;
  v_unit text;
  v_quantity real;
  v_request_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_field_work(p_project_id) THEN
    RAISE EXCEPTION 'Project is not open for pedidos' USING ERRCODE = '55000';
  END IF;
  IF p_kind NOT IN ('empresa', 'personal') THEN
    RAISE EXCEPTION 'Tipo de pedido inválido' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'empresa' AND length(btrim(COALESCE(p_justification, ''))) < 3 THEN
    RAISE EXCEPTION 'Justificación requerida para pedidos de empresa'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'El pedido debe contener al menos un ítem' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;

  v_request_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'kind', p_kind, 'items', p_items,
    'justification', NULLIF(btrim(COALESCE(p_justification, '')), ''),
    'priority', COALESCE(p_priority, 'Normal'), 'needed_by', p_needed_by,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
  ));

  SELECT * INTO v_existing
  FROM public.pedidos
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.kind IS DISTINCT FROM p_kind
       OR v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'pedido', to_jsonb(v_existing),
      'items', (SELECT COALESCE(jsonb_agg(to_jsonb(pi) ORDER BY pi.id), '[]'::jsonb)
                FROM public.pedido_items pi WHERE pi.pedido_id = v_existing.id),
      'idempotent_replay', true
    );
  END IF;

  v_first := p_items -> 0;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_quantity := COALESCE((v_item ->> 'requested_quantity')::real, 0);
    IF v_quantity <= 0 THEN
      RAISE EXCEPTION 'Cada cantidad solicitada debe ser positiva' USING ERRCODE = '22023';
    END IF;
    v_total_quantity := v_total_quantity + v_quantity;
    v_item_count := v_item_count + 1;
  END LOOP;

  PERFORM set_config('phc.pedido_v2_insert', 'on', true);
  INSERT INTO public.pedidos (
    client_entry_id, project_id, operator_id, kind, justification,
    priority, needed_by, reason, notes, pedido_type, material, quantity, status,
    request_payload
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), p_kind,
    NULLIF(btrim(COALESCE(p_justification, '')), ''),
    COALESCE(p_priority, 'Normal'), p_needed_by, p_justification, p_notes,
    p_kind,
    COALESCE(v_first ->> 'material_name', v_first ->> 'name', 'Pedido de ' || v_item_count || ' ítems'),
    v_total_quantity, 'Pendiente', v_request_payload
  ) RETURNING * INTO v_pedido;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_variant := NULL;
    v_material := NULL;
    IF NULLIF(v_item ->> 'catalog_variant_id', '') IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.catalog_variants
      WHERE id = (v_item ->> 'catalog_variant_id')::bigint AND active IS TRUE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variante de catálogo no encontrada' USING ERRCODE = 'P0002';
      END IF;
      SELECT * INTO v_material
      FROM public.catalog_materials
      WHERE id = v_variant.material_id AND active IS TRUE;
    END IF;
    v_name := COALESCE(
      NULLIF(btrim(v_item ->> 'material_name'), ''),
      CASE WHEN v_material.id IS NOT NULL THEN
        CASE WHEN public.normalize_catalog_name(v_variant.display_name) = 'estandar'
          THEN v_material.name ELSE v_material.name || ' · ' || v_variant.display_name END
      END
    );
    v_unit := COALESCE(NULLIF(btrim(v_item ->> 'unit'), ''), v_material.unit, 'unidad');
    v_quantity := (v_item ->> 'requested_quantity')::real;
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'Nombre o variante requerida para cada ítem' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.pedido_items (
      client_entry_id, pedido_id, catalog_variant_id, material_name_snapshot,
      requested_quantity, unit_snapshot, layer
    ) VALUES (
      NULLIF(v_item ->> 'client_entry_id', ''), v_pedido.id, v_variant.id, v_name,
      v_quantity, v_unit, COALESCE(NULLIF(v_item ->> 'layer', ''), 'extras')
    );
  END LOOP;

  RETURN jsonb_build_object(
    'pedido', to_jsonb(v_pedido),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(pi) ORDER BY pi.id), '[]'::jsonb)
              FROM public.pedido_items pi WHERE pi.pedido_id = v_pedido.id),
    'idempotent_replay', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_pedido_item(
  p_item_id bigint,
  p_decision text,
  p_approved_quantity real DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_layer text DEFAULT 'extras'
)
RETURNS public.pedido_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item public.pedido_items;
  v_pedido public.pedidos;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('aprobado', 'rechazado') THEN
    RAISE EXCEPTION 'Decisión inválida' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.pedido_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = v_item.pedido_id FOR UPDATE;
  IF v_item.state <> 'solicitado' THEN
    RAISE EXCEPTION 'El ítem ya fue decidido (estado: %)', v_item.state USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'rechazado' AND length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo de rechazo requerido' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'aprobado'
     AND COALESCE(p_approved_quantity, v_item.requested_quantity) <= 0 THEN
    RAISE EXCEPTION 'Cantidad aprobada inválida' USING ERRCODE = '22023';
  END IF;
  IF p_layer NOT IN ('presupuesto', 'extras') THEN
    RAISE EXCEPTION 'Capa inválida' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('phc.audit_reason', COALESCE(p_reason, 'Decisión de ítem'), true);
  UPDATE public.pedido_items
  SET state = p_decision,
      approved_quantity = CASE WHEN p_decision = 'aprobado'
        THEN COALESCE(p_approved_quantity, requested_quantity) ELSE NULL END,
      decision_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
      layer = p_layer,
      decided_by = auth.uid(),
      decided_at = now(),
      closed_at = CASE WHEN p_decision = 'rechazado' THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  PERFORM private.recompute_pedido_status(v_item.pedido_id);
  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_pedido_item_receipt(
  p_item_id bigint,
  p_client_entry_id text,
  p_outcome text,
  p_quantity_received real DEFAULT 0,
  p_incident_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item public.pedido_items;
  v_pedido public.pedidos;
  v_existing public.pedido_receipts;
  v_receipt public.pedido_receipts;
  v_variant public.catalog_variants;
  v_material public.catalog_materials;
  v_assignment public.project_materials;
  v_new_received real;
  v_new_state text;
  v_epsilon real;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('recibido', 'parcial', 'no_recibido') THEN
    RAISE EXCEPTION 'Resultado de recepción inválido' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_item FROM public.pedido_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = v_item.pedido_id FOR UPDATE;
  IF v_pedido.operator_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the requesting operator can confirm receipt'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_closure_change(v_pedido.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite recepciones en su estado actual'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_existing
  FROM public.pedido_receipts
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.pedido_item_id IS DISTINCT FROM p_item_id
       OR v_existing.outcome IS DISTINCT FROM p_outcome
       OR v_existing.quantity_received IS DISTINCT FROM COALESCE(p_quantity_received, 0) THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('receipt', to_jsonb(v_existing), 'item', to_jsonb(v_item), 'idempotent_replay', true);
  END IF;

  IF v_item.state NOT IN ('aprobado', 'parcial') THEN
    RAISE EXCEPTION 'El ítem no espera recepción (estado: %)', v_item.state USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'no_recibido' THEN
    IF COALESCE(p_quantity_received, 0) <> 0 OR length(btrim(COALESCE(p_incident_note, ''))) < 3 THEN
      RAISE EXCEPTION 'No recibido requiere cantidad 0 y una explicación'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_quantity_received IS NULL OR p_quantity_received <= 0 THEN
      RAISE EXCEPTION 'Cantidad recibida debe ser positiva' USING ERRCODE = '22023';
    END IF;
    IF p_outcome = 'parcial' AND length(btrim(COALESCE(p_incident_note, ''))) < 3 THEN
      RAISE EXCEPTION 'Una entrega parcial requiere una nota' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_received := v_item.received_quantity + COALESCE(p_quantity_received, 0);
  v_epsilon := greatest(abs(COALESCE(v_item.approved_quantity, 0)) * 0.000001, 0.00001);
  IF v_new_received > COALESCE(v_item.approved_quantity, 0) + v_epsilon THEN
    RAISE EXCEPTION 'La recepción supera la cantidad aprobada' USING ERRCODE = '22023';
  END IF;
  IF abs(v_new_received - COALESCE(v_item.approved_quantity, 0)) <= v_epsilon THEN
    v_new_received := v_item.approved_quantity;
  END IF;
  IF p_outcome = 'recibido' AND v_new_received < v_item.approved_quantity - v_epsilon THEN
    RAISE EXCEPTION 'Usa parcial hasta completar exactamente la cantidad aprobada'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('phc.audit_reason', COALESCE(p_incident_note, 'Recepción de pedido'), true);

  INSERT INTO public.pedido_receipts (
    client_entry_id, pedido_item_id, outcome, quantity_received,
    incident_note, confirmed_by
  ) VALUES (
    p_client_entry_id, p_item_id, p_outcome, COALESCE(p_quantity_received, 0),
    NULLIF(btrim(COALESCE(p_incident_note, '')), ''), auth.uid()
  ) RETURNING * INTO v_receipt;

  -- Personal pedidos are deliberately inventory-neutral. Company inventory
  -- changes happen here and nowhere in the approval path.
  IF v_pedido.kind = 'empresa' AND COALESCE(p_quantity_received, 0) > 0 THEN
    IF v_item.catalog_variant_id IS NOT NULL THEN
      SELECT * INTO v_variant FROM public.catalog_variants WHERE id = v_item.catalog_variant_id;
      SELECT * INTO v_material FROM public.catalog_materials WHERE id = v_variant.material_id;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'pedido-receipt-material:' || v_pedido.project_id::text || ':' || v_item.layer || ':' ||
        COALESCE(v_item.catalog_variant_id::text, public.normalize_catalog_name(v_item.material_name_snapshot)),
        0
      )
    );
    SELECT * INTO v_assignment
    FROM public.project_materials pm
    WHERE pm.project_id = v_pedido.project_id
      AND pm.layer = v_item.layer
      AND pm.active IS TRUE
      AND (
        (v_item.catalog_variant_id IS NOT NULL AND pm.catalog_variant_id = v_item.catalog_variant_id)
        OR (
          v_item.catalog_variant_id IS NULL
          AND public.normalize_catalog_name(pm.material_name) =
              public.normalize_catalog_name(v_item.material_name_snapshot)
        )
      )
    LIMIT 1 FOR UPDATE;

    IF FOUND THEN
      UPDATE public.project_materials
      SET initial_quantity = COALESCE(initial_quantity, 0) + p_quantity_received,
          quantity_allocated = COALESCE(quantity_allocated, initial_quantity, 0) + p_quantity_received,
          current_quantity = COALESCE(current_quantity, 0) + p_quantity_received,
          updated_at = now()
      WHERE id = v_assignment.id;
    ELSE
      INSERT INTO public.project_materials (
        project_id, catalog_variant_id, material_name, quantity_allocated,
        initial_quantity, current_quantity, unit, layer, assigned_date, notes, active
      ) VALUES (
        v_pedido.project_id, v_item.catalog_variant_id, v_item.material_name_snapshot,
        p_quantity_received, p_quantity_received, p_quantity_received,
        v_item.unit_snapshot, v_item.layer, now(),
        'Recepción pedido ' || COALESCE(v_pedido.pedido_number, v_pedido.id::text), true
      );
    END IF;
  END IF;

  v_new_state := CASE
    WHEN p_outcome = 'no_recibido' THEN 'no_recibido'
    WHEN v_new_received = v_item.approved_quantity THEN 'recibido'
    ELSE 'parcial'
  END;
  UPDATE public.pedido_items
  SET received_quantity = v_new_received,
      state = v_new_state,
      incident_note = CASE
        WHEN p_incident_note IS NULL THEN incident_note
        ELSE concat_ws(' · ', incident_note, btrim(p_incident_note))
      END,
      closed_at = CASE WHEN v_new_state IN ('recibido', 'no_recibido') THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_item_id
  RETURNING * INTO v_item;
  PERFORM private.recompute_pedido_status(v_item.pedido_id);

  PERFORM private.write_audit(
    v_pedido.project_id, 'pedido_item.received', 'pedido_items', v_item.id::text,
    NULL, to_jsonb(v_item), p_incident_note,
    jsonb_build_object('receipt_id', v_receipt.id, 'kind', v_pedido.kind)
  );
  RETURN jsonb_build_object('receipt', to_jsonb(v_receipt), 'item', to_jsonb(v_item), 'idempotent_replay', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_pedido_manually(
  p_pedido_id bigint,
  p_reason text
)
RETURNS public.pedidos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pedido public.pedidos;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('phc.audit_reason', p_reason, true);
  UPDATE public.pedido_items
  SET state = CASE WHEN state = 'solicitado' THEN 'rechazado' ELSE 'no_recibido' END,
      decision_reason = CASE WHEN state = 'solicitado' THEN p_reason ELSE decision_reason END,
      incident_note = CASE WHEN state <> 'solicitado' THEN p_reason ELSE incident_note END,
      closed_at = now(), updated_at = now()
  WHERE pedido_id = p_pedido_id
    AND state IN ('solicitado', 'aprobado', 'parcial');
  UPDATE public.pedidos
  SET status = 'Cerrado', closed_manually = true, closed_by = auth.uid(),
      closed_at = now(), admin_notes = concat_ws(' · ', admin_notes, p_reason),
      updated_at = now()
  WHERE id = p_pedido_id
  RETURNING * INTO v_pedido;
  RETURN v_pedido;
END;
$$;

-- Old whole-pedido approval is intentionally retired. The current installed
-- APK receives a clear upgrade-required error and inventory is never changed.
DROP FUNCTION IF EXISTS public.approve_pedido(bigint, bigint, real, text);
DROP FUNCTION IF EXISTS public.approve_pedido(bigint, real, text);
CREATE FUNCTION public.approve_pedido(
  p_pedido_id bigint,
  p_quantity_override real DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.pedidos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'PEDIDOS_V2_REQUIRED: actualiza la aplicación y decide cada ítem; aprobar ya no modifica inventario'
    USING ERRCODE = '0A000';
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_pedido(
  p_pedido_id bigint,
  p_reason text DEFAULT NULL
)
RETURNS public.pedidos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pedido public.pedidos;
  v_item record;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo de rechazo requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pedido_items
    WHERE pedido_id = p_pedido_id AND state <> 'solicitado'
  ) THEN
    RAISE EXCEPTION 'El pedido ya tiene decisiones/recepciones; usa el cierre manual auditado'
      USING ERRCODE = '55000';
  END IF;
  FOR v_item IN SELECT id FROM public.pedido_items WHERE pedido_id = p_pedido_id AND state = 'solicitado' LOOP
    PERFORM public.decide_pedido_item(v_item.id, 'rechazado', NULL, p_reason, 'extras');
  END LOOP;
  UPDATE public.pedidos
  SET status = 'Rechazado', rejection_reason = p_reason, admin_notes = p_reason,
      approved_by = auth.uid(), approved_at = now(), closed_at = now(), updated_at = now()
  WHERE id = p_pedido_id
  RETURNING * INTO v_pedido;
  RETURN v_pedido;
END;
$$;
CREATE OR REPLACE FUNCTION private.validate_completion_final_fields(p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_static real;
  v_dynamic real;
  v_flow real;
  v_maximum real;
  v_pump_depth real;
  v_exploration real;
  v_widening real;
  v_casing_total real;
  v_above real;
  v_blind real;
  v_filter real;
  v_trap real;
  v_centralizers integer;
  v_bentonite real;
  v_gravel real;
  v_specific real;
  v_calculated real;
  v_layout_row jsonb;
  v_layout_order integer;
  v_layout_meters real;
  v_layout_sum real := 0;
  v_seen_orders integer[] := ARRAY[]::integer[];
  v_optional_key text;
  v_optional_value real;
  v_override boolean := false;
  v_mismatch boolean := false;
BEGIN
  IF jsonb_typeof(p_fields) <> 'object'
     OR NOT (p_fields ?& ARRAY[
       'static_level', 'dynamic_level', 'flow_rate', 'maximum_flow_rate',
       'pump_depth_m', 'exploration_depth_m', 'widening_depth_m',
       'casing_total_m', 'casing_above_ground_m', 'blind_casing_m',
       'filter_casing_m', 'sediment_trap_m', 'centralizer_count',
       'bottom_plug_details', 'bentonite_quantity', 'gravel_quantity',
       'casing_layout'
     ]) THEN
    RAISE EXCEPTION 'Faltan campos finales obligatorios de la Ficha'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_static := NULLIF(btrim(p_fields ->> 'static_level'), '')::real;
    v_dynamic := NULLIF(btrim(p_fields ->> 'dynamic_level'), '')::real;
    v_flow := NULLIF(btrim(p_fields ->> 'flow_rate'), '')::real;
    v_maximum := NULLIF(btrim(p_fields ->> 'maximum_flow_rate'), '')::real;
    v_pump_depth := NULLIF(btrim(p_fields ->> 'pump_depth_m'), '')::real;
    v_exploration := NULLIF(btrim(p_fields ->> 'exploration_depth_m'), '')::real;
    v_widening := NULLIF(btrim(p_fields ->> 'widening_depth_m'), '')::real;
    v_casing_total := NULLIF(btrim(p_fields ->> 'casing_total_m'), '')::real;
    v_above := NULLIF(btrim(p_fields ->> 'casing_above_ground_m'), '')::real;
    v_blind := NULLIF(btrim(p_fields ->> 'blind_casing_m'), '')::real;
    v_filter := NULLIF(btrim(p_fields ->> 'filter_casing_m'), '')::real;
    v_trap := NULLIF(btrim(p_fields ->> 'sediment_trap_m'), '')::real;
    v_centralizers := NULLIF(btrim(p_fields ->> 'centralizer_count'), '')::integer;
    v_bentonite := NULLIF(btrim(p_fields ->> 'bentonite_quantity'), '')::real;
    v_gravel := NULLIF(btrim(p_fields ->> 'gravel_quantity'), '')::real;
    v_specific := NULLIF(btrim(p_fields ->> 'specific_flow_rate'), '')::real;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Los campos numéricos de la Ficha contienen un valor inválido'
      USING ERRCODE = '22023';
  END;

  IF v_static IS NULL OR v_dynamic IS NULL OR v_flow IS NULL OR v_maximum IS NULL
     OR v_pump_depth IS NULL OR v_exploration IS NULL OR v_widening IS NULL
     OR v_casing_total IS NULL OR v_above IS NULL OR v_blind IS NULL
     OR v_filter IS NULL OR v_trap IS NULL OR v_centralizers IS NULL
     OR v_bentonite IS NULL OR v_gravel IS NULL THEN
    RAISE EXCEPTION 'Los campos finales obligatorios no pueden estar vacíos'
      USING ERRCODE = '22023';
  END IF;
  IF v_static::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_dynamic::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_flow::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_maximum::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_pump_depth::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_exploration::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_widening::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_casing_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'La Ficha no admite NaN ni valores infinitos' USING ERRCODE = '22023';
  END IF;
  IF v_static < 0 OR v_static > 10000 OR v_dynamic <= v_static OR v_dynamic > 10000
     OR v_flow <= 0 OR v_flow > 10000000
     OR v_maximum < v_flow OR v_maximum > 10000000 THEN
    RAISE EXCEPTION 'Datos hidráulicos fuera de rango; dinámico > estático y caudal máximo >= bombeado'
      USING ERRCODE = '22023';
  END IF;
  IF v_exploration <= 0 OR v_exploration > 10000
     OR v_widening <= 0 OR v_widening > v_exploration
     OR v_pump_depth <= 0 OR v_pump_depth > v_exploration THEN
    RAISE EXCEPTION 'Profundidades finales fuera de rango' USING ERRCODE = '22023';
  END IF;
  IF v_casing_total <= 0 OR v_casing_total > v_exploration + v_above
     OR v_above < 0 OR v_blind < 0 OR v_filter < 0 OR v_trap < 0
     OR v_centralizers < 0 OR v_bentonite < 0 OR v_gravel < 0
     OR length(btrim(COALESCE(p_fields ->> 'bottom_plug_details', ''))) = 0 THEN
    RAISE EXCEPTION 'Desglose de entubado incompleto o fuera de rango'
      USING ERRCODE = '22023';
  END IF;
  IF v_specific IS NOT NULL AND (v_specific <= 0 OR v_specific::text IN ('NaN', 'Infinity', '-Infinity')) THEN
    RAISE EXCEPTION 'Caudal específico inválido' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_fields -> 'casing_layout') <> 'array'
     OR jsonb_array_length(p_fields -> 'casing_layout') = 0 THEN
    RAISE EXCEPTION 'El esquema de entubado debe contener al menos un tramo'
      USING ERRCODE = '22023';
  END IF;
  FOR v_layout_row IN SELECT value FROM jsonb_array_elements(p_fields -> 'casing_layout') LOOP
    IF jsonb_typeof(v_layout_row) <> 'object'
       OR length(btrim(COALESCE(v_layout_row ->> 'type', ''))) = 0 THEN
      RAISE EXCEPTION 'Cada tramo requiere tipo, orden y metros' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_layout_order := NULLIF(btrim(v_layout_row ->> 'order'), '')::integer;
      v_layout_meters := NULLIF(btrim(v_layout_row ->> 'meters'), '')::real;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Orden o metros inválidos en el esquema de entubado'
        USING ERRCODE = '22023';
    END;
    IF v_layout_order IS NULL OR v_layout_order <= 0
       OR v_layout_meters IS NULL OR v_layout_meters <= 0
       OR v_layout_meters::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'Cada tramo requiere orden positivo y metros positivos'
        USING ERRCODE = '22023';
    END IF;
    IF v_layout_order = ANY(v_seen_orders) THEN
      RAISE EXCEPTION 'El orden de los tramos no puede repetirse' USING ERRCODE = '22023';
    END IF;
    v_seen_orders := array_append(v_seen_orders, v_layout_order);
    v_layout_sum := v_layout_sum + v_layout_meters;
  END LOOP;
  IF abs(v_layout_sum - v_casing_total) > greatest(v_casing_total * 0.001, 0.05) THEN
    RAISE EXCEPTION 'Los metros del esquema (%) no coinciden con el entubado total (%)',
      v_layout_sum, v_casing_total USING ERRCODE = '22023';
  END IF;

  FOREACH v_optional_key IN ARRAY ARRAY[
    'compressor_hours', 'pump_hours', 'installed_meters', 'perforated_meters'
  ] LOOP
    IF NULLIF(btrim(p_fields ->> v_optional_key), '') IS NOT NULL THEN
      BEGIN
        v_optional_value := (p_fields ->> v_optional_key)::real;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Valor opcional inválido: %', v_optional_key USING ERRCODE = '22023';
      END;
      IF v_optional_value < 0 OR v_optional_value::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'El valor % no puede ser negativo/no finito', v_optional_key
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  v_calculated := v_flow / (v_dynamic - v_static);
  v_override := v_specific IS NOT NULL;
  IF v_specific IS NULL THEN v_specific := v_calculated; END IF;
  v_mismatch := v_override
    AND abs(v_specific - v_calculated) > greatest(abs(v_calculated) * 0.10, 0.01);

  RETURN p_fields || jsonb_build_object(
    'static_level', v_static, 'dynamic_level', v_dynamic, 'flow_rate', v_flow,
    'maximum_flow_rate', v_maximum, 'pump_depth_m', v_pump_depth,
    'exploration_depth_m', v_exploration, 'widening_depth_m', v_widening,
    'casing_total_m', v_casing_total, 'casing_above_ground_m', v_above,
    'blind_casing_m', v_blind, 'filter_casing_m', v_filter,
    'sediment_trap_m', v_trap, 'centralizer_count', v_centralizers,
    'bentonite_quantity', v_bentonite, 'gravel_quantity', v_gravel,
    'specific_flow_rate', v_specific,
    '_specific_flow_calculated', v_calculated,
    '_specific_flow_overridden', v_override,
    '_hydraulic_mismatch', v_mismatch
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_completion_v2(
  p_project_id bigint,
  p_client_entry_id text,
  p_final_fields jsonb,
  p_operator_signature text,
  p_completion_notes text DEFAULT NULL,
  p_pdf_url text DEFAULT NULL
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects;
  v_existing public.completion_reports;
  v_result public.completion_reports;
  v_fields jsonb;
  v_submission_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_closing_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the responsible closing operator may submit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(btrim(COALESCE(p_operator_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Identificador y firma del operador requeridos' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'La Ficha solo puede enviarse desde un proyecto activo'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shifts
    WHERE project_id = p_project_id AND status IN ('open', 'report_pending')
  ) THEN
    RAISE EXCEPTION 'Todos los turnos deben estar cerrados y reportados antes de la Ficha'
      USING ERRCODE = '55000';
  END IF;

  v_fields := private.validate_completion_final_fields(p_final_fields);
  IF p_pdf_url IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'phc-reports'
      AND o.name = p_pdf_url
      AND o.name LIKE p_project_id::text || '/%'
      AND lower(o.name) LIKE '%.pdf'
      AND COALESCE(o.metadata ->> 'mimetype', '') = 'application/pdf'
  ) THEN
    RAISE EXCEPTION 'The supplied Ficha PDF is not a project-scoped PDF object'
      USING ERRCODE = '22023';
  END IF;
  v_submission_payload := jsonb_build_object(
    'final_fields', v_fields - ARRAY['_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'],
    'operator_signature', btrim(p_operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
    'pdf_url', p_pdf_url
  );

  SELECT * INTO v_existing
  FROM public.completion_reports
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.submission_payload IS DISTINCT FROM v_submission_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.completion_reports
    WHERE project_id = p_project_id AND format_version >= 2
  ) THEN
    RAISE EXCEPTION 'El proyecto ya tiene una Ficha v2; usa el flujo de devolución y reenvío'
      USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('phc.completion_v2_insert', 'on', true);
  INSERT INTO public.completion_reports (
    client_entry_id, project_id, operator_id, format_version,
    static_level, dynamic_level, flow_rate, specific_flow_rate,
    maximum_flow_rate, pump_depth_m, specific_flow_overridden,
    hydraulic_mismatch, exploration_depth_m, widening_depth_m,
    casing_total_m, casing_above_ground_m, blind_casing_m,
    filter_casing_m, sediment_trap_m, centralizer_count,
    bottom_plug_details, bentonite_quantity, gravel_quantity,
    casing_layout, compressor_hours, pump_hours, water_quality,
    installed_meters, perforated_meters, completion_notes,
    operator_signature, status, pdf_url, submitted_at, submission_payload
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), 2,
    (v_fields ->> 'static_level')::real, (v_fields ->> 'dynamic_level')::real,
    (v_fields ->> 'flow_rate')::real, (v_fields ->> 'specific_flow_rate')::real,
    (v_fields ->> 'maximum_flow_rate')::real, (v_fields ->> 'pump_depth_m')::real,
    (v_fields ->> '_specific_flow_overridden')::boolean,
    (v_fields ->> '_hydraulic_mismatch')::boolean,
    (v_fields ->> 'exploration_depth_m')::real, (v_fields ->> 'widening_depth_m')::real,
    (v_fields ->> 'casing_total_m')::real, (v_fields ->> 'casing_above_ground_m')::real,
    (v_fields ->> 'blind_casing_m')::real, (v_fields ->> 'filter_casing_m')::real,
    (v_fields ->> 'sediment_trap_m')::real, (v_fields ->> 'centralizer_count')::integer,
    btrim(v_fields ->> 'bottom_plug_details'), (v_fields ->> 'bentonite_quantity')::real,
    (v_fields ->> 'gravel_quantity')::real, v_fields -> 'casing_layout',
    NULLIF(v_fields ->> 'compressor_hours', '')::real,
    NULLIF(v_fields ->> 'pump_hours', '')::real,
    NULLIF(btrim(v_fields ->> 'water_quality'), ''),
    NULLIF(v_fields ->> 'installed_meters', '')::real,
    NULLIF(v_fields ->> 'perforated_meters', '')::real,
    NULLIF(btrim(COALESCE(p_completion_notes, '')), ''), btrim(p_operator_signature),
    'submitted', p_pdf_url, now(), v_submission_payload
  ) RETURNING * INTO v_result;

  PERFORM set_config('phc.project_closure_submit', 'on', true);
  UPDATE public.projects
  SET status = 'closure_submitted', updated_at = now()
  WHERE id = p_project_id;

  PERFORM private.write_audit(
    p_project_id, 'ficha.submitted', 'completion_reports', v_result.id::text,
    NULL, to_jsonb(v_result), NULL,
    jsonb_build_object('format_version', 2,
      'specific_flow_calculated', (v_fields ->> '_specific_flow_calculated')::real)
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.return_completion_v2(
  p_report_id bigint,
  p_reason text
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_report public.completion_reports;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo de devolución requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_report.format_version < 2 THEN
    RAISE EXCEPTION 'Ficha v2 no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.finalized_at IS NOT NULL OR v_report.admin_signature IS NOT NULL THEN
    RAISE EXCEPTION 'Una Ficha firmada no puede devolverse' USING ERRCODE = '55000';
  END IF;
  IF v_report.status <> 'submitted' THEN
    RAISE EXCEPTION 'La Ficha no está pendiente de revisión (estado: %)', v_report.status
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_allows_closure_change(v_report.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite devolución de Ficha' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('phc.audit_reason', p_reason, true);
  UPDATE public.completion_reports
  SET status = 'returned', return_reason = btrim(p_reason),
      returned_by = auth.uid(), returned_at = now(), updated_at = now()
  WHERE id = p_report_id
  RETURNING * INTO v_report;
  PERFORM private.write_audit(
    v_report.project_id, 'ficha.returned', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), p_reason, '{}'::jsonb
  );
  RETURN v_report;
END;
$$;

CREATE OR REPLACE FUNCTION public.resubmit_completion_v2(
  p_report_id bigint,
  p_client_entry_id text,
  p_final_fields jsonb,
  p_operator_signature text,
  p_completion_notes text DEFAULT NULL,
  p_pdf_url text DEFAULT NULL
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_report public.completion_reports;
  v_fields jsonb;
  v_submission_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(btrim(COALESCE(p_operator_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Identificador y firma del operador requeridos' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_report.format_version < 2 THEN
    RAISE EXCEPTION 'Ficha v2 no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_closing_operator(v_report.project_id)
     OR v_report.operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the responsible closing operator may resubmit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_closure_change(v_report.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite reenvío de Ficha' USING ERRCODE = '55000';
  END IF;
  v_fields := private.validate_completion_final_fields(p_final_fields);
  IF p_pdf_url IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'phc-reports'
      AND o.name = p_pdf_url
      AND o.name LIKE v_report.project_id::text || '/%'
      AND lower(o.name) LIKE '%.pdf'
      AND COALESCE(o.metadata ->> 'mimetype', '') = 'application/pdf'
  ) THEN
    RAISE EXCEPTION 'The supplied Ficha PDF is not a project-scoped PDF object'
      USING ERRCODE = '22023';
  END IF;
  v_submission_payload := jsonb_build_object(
    'final_fields', v_fields - ARRAY['_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'],
    'operator_signature', btrim(p_operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
    'pdf_url', p_pdf_url
  );

  IF v_report.last_resubmission_id = p_client_entry_id THEN
    IF v_report.submission_payload IS DISTINCT FROM v_submission_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_report;
  END IF;
  IF v_report.status <> 'returned' THEN
    RAISE EXCEPTION 'La Ficha debe estar devuelta antes de reenviarla (estado: %)', v_report.status
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.completion_discrepancies d
    WHERE d.project_id = v_report.project_id AND d.status = 'open'
  ) THEN
    RAISE EXCEPTION 'La administración debe resolver las discrepancias antes del reenvío'
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('phc.audit_reason', 'Reconfirmación del operador tras devolución', true);
  UPDATE public.completion_reports
  SET static_level = (v_fields ->> 'static_level')::real,
      dynamic_level = (v_fields ->> 'dynamic_level')::real,
      flow_rate = (v_fields ->> 'flow_rate')::real,
      specific_flow_rate = (v_fields ->> 'specific_flow_rate')::real,
      maximum_flow_rate = (v_fields ->> 'maximum_flow_rate')::real,
      pump_depth_m = (v_fields ->> 'pump_depth_m')::real,
      specific_flow_overridden = (v_fields ->> '_specific_flow_overridden')::boolean,
      hydraulic_mismatch = (v_fields ->> '_hydraulic_mismatch')::boolean,
      exploration_depth_m = (v_fields ->> 'exploration_depth_m')::real,
      widening_depth_m = (v_fields ->> 'widening_depth_m')::real,
      casing_total_m = (v_fields ->> 'casing_total_m')::real,
      casing_above_ground_m = (v_fields ->> 'casing_above_ground_m')::real,
      blind_casing_m = (v_fields ->> 'blind_casing_m')::real,
      filter_casing_m = (v_fields ->> 'filter_casing_m')::real,
      sediment_trap_m = (v_fields ->> 'sediment_trap_m')::real,
      centralizer_count = (v_fields ->> 'centralizer_count')::integer,
      bottom_plug_details = btrim(v_fields ->> 'bottom_plug_details'),
      bentonite_quantity = (v_fields ->> 'bentonite_quantity')::real,
      gravel_quantity = (v_fields ->> 'gravel_quantity')::real,
      casing_layout = v_fields -> 'casing_layout',
      compressor_hours = NULLIF(v_fields ->> 'compressor_hours', '')::real,
      pump_hours = NULLIF(v_fields ->> 'pump_hours', '')::real,
      water_quality = NULLIF(btrim(v_fields ->> 'water_quality'), ''),
      installed_meters = NULLIF(v_fields ->> 'installed_meters', '')::real,
      perforated_meters = NULLIF(v_fields ->> 'perforated_meters', '')::real,
      completion_notes = NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
      operator_signature = btrim(p_operator_signature),
      status = 'submitted', pdf_url = p_pdf_url,
      submitted_at = now(), updated_at = now(),
      submission_payload = v_submission_payload,
      last_resubmission_id = p_client_entry_id
  WHERE id = p_report_id
  RETURNING * INTO v_report;
  PERFORM private.write_audit(
    v_report.project_id, 'ficha.resubmitted', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), NULL,
    jsonb_build_object('resubmission_id', p_client_entry_id)
  );
  RETURN v_report;
END;
$$;

CREATE OR REPLACE FUNCTION public.report_completion_discrepancy(
  p_project_id bigint,
  p_section text,
  p_description text,
  p_completion_report_id bigint DEFAULT NULL
)
RETURNS public.completion_discrepancies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result public.completion_discrepancies;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_closing_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the closer or admin may report a discrepancy'
      USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_section, ''))) = 0
     OR length(btrim(COALESCE(p_description, ''))) < 3 THEN
    RAISE EXCEPTION 'Sección y descripción requeridas' USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_allows_closure_change(p_project_id) THEN
    RAISE EXCEPTION 'No se pueden crear discrepancias después de la firma/cierre'
      USING ERRCODE = '55000';
  END IF;
  IF p_completion_report_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.completion_reports cr
    WHERE cr.id = p_completion_report_id
      AND cr.project_id = p_project_id
      AND cr.finalized_at IS NULL
      AND cr.admin_signature IS NULL
  ) THEN
    RAISE EXCEPTION 'La Ficha indicada no pertenece al proyecto o ya está finalizada'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.completion_discrepancies (
    project_id, completion_report_id, section, description, reported_by
  ) VALUES (
    p_project_id, p_completion_report_id, btrim(p_section), btrim(p_description), auth.uid()
  ) RETURNING * INTO v_result;
  PERFORM private.write_audit(
    p_project_id, 'ficha.discrepancy_reported', 'completion_discrepancies', v_result.id::text,
    NULL, to_jsonb(v_result), p_description, '{}'::jsonb
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_completion_discrepancy(
  p_discrepancy_id bigint,
  p_resolution_note text
)
RETURNS public.completion_discrepancies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result public.completion_discrepancies;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_resolution_note, ''))) < 3 THEN
    RAISE EXCEPTION 'Nota de resolución requerida' USING ERRCODE = '22023';
  END IF;
  UPDATE public.completion_discrepancies
  SET status = 'resolved', resolved_by = auth.uid(),
      resolution_note = btrim(p_resolution_note), resolved_at = now()
  WHERE id = p_discrepancy_id AND status = 'open'
  RETURNING * INTO v_result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Discrepancia no encontrada o ya resuelta' USING ERRCODE = 'P0002';
  END IF;
  PERFORM private.write_audit(
    v_result.project_id, 'ficha.discrepancy_resolved', 'completion_discrepancies', v_result.id::text,
    NULL, to_jsonb(v_result), p_resolution_note, '{}'::jsonb
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_water_sample(
  p_project_id bigint,
  p_client_entry_id text,
  p_taken_at timestamptz,
  p_depth_m real DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_bottle_photo_path text DEFAULT NULL,
  p_sample_number integer DEFAULT NULL,
  p_timestamp_local timestamptz DEFAULT NULL
)
RETURNS public.water_samples
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects;
  v_existing public.water_samples;
  v_result public.water_samples;
  v_number integer;
  v_request_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 OR p_taken_at IS NULL THEN
    RAISE EXCEPTION 'client_entry_id and taken_at required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'Project is closed for new samples' USING ERRCODE = '55000';
  END IF;
  v_request_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'taken_at', p_taken_at,
    'depth_m', p_depth_m, 'stage', NULLIF(btrim(COALESCE(p_stage, '')), ''),
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'bottle_photo_path', p_bottle_photo_path,
    'sample_number', p_sample_number, 'timestamp_local', p_timestamp_local
  ));
  SELECT * INTO v_existing FROM public.water_samples WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  IF p_bottle_photo_path IS NOT NULL
     AND p_bottle_photo_path NOT LIKE p_project_id::text || '/%' THEN
    RAISE EXCEPTION 'Photo path must stay inside the project folder'
      USING ERRCODE = '22023';
  END IF;
  IF p_bottle_photo_path IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.photos ph
    WHERE ph.project_id = p_project_id
      AND ph.storage_path = p_bottle_photo_path
      AND ph.evidence_kind = 'water_sample'
      AND ph.uploaded_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Bottle photo metadata is missing or not marked as water-sample evidence'
      USING ERRCODE = '22023';
  END IF;
  IF p_depth_m IS NOT NULL AND p_depth_m < 0 THEN
    RAISE EXCEPTION 'Depth cannot be negative' USING ERRCODE = '22023';
  END IF;
  -- The server is authoritative for the per-well sequence. A client-supplied
  -- number is retained only in request_payload for reconciliation/debugging.
  SELECT COALESCE(max(sample_number), 0) + 1 INTO v_number
  FROM public.water_samples WHERE project_id = p_project_id;

  INSERT INTO public.water_samples (
    client_entry_id, project_id, sample_number, depth_m, stage,
    operator_id, notes, bottle_photo_path, taken_at, timestamp_local,
    device_time_flag, request_payload
  ) VALUES (
    p_client_entry_id, p_project_id, v_number, p_depth_m,
    NULLIF(btrim(COALESCE(p_stage, '')), ''), auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), ''), p_bottle_photo_path,
    p_taken_at, p_timestamp_local,
    p_timestamp_local IS NOT NULL AND abs(extract(epoch FROM (now() - p_timestamp_local))) > 900,
    v_request_payload
  ) RETURNING * INTO v_result;
  PERFORM private.write_audit(
    p_project_id, 'sample.registered', 'water_samples', v_result.id::text,
    NULL, to_jsonb(v_result), NULL, '{}'::jsonb
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_project_attachment(
  p_project_id bigint,
  p_kind text,
  p_storage_path text,
  p_filename text DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_water_sample_id bigint DEFAULT NULL
)
RETURNS public.project_attachments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result public.project_attachments;
  v_storage_mime text;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('analisis_agua', 'otro') THEN
    RAISE EXCEPTION 'Tipo de adjunto inválido' USING ERRCODE = '22023';
  END IF;
  IF p_storage_path NOT LIKE p_project_id::text || '/attachments/%' THEN
    RAISE EXCEPTION 'Attachment path must be <project>/attachments/<file>'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT o.metadata ->> 'mimetype' INTO v_storage_mime
  FROM storage.objects o
  WHERE o.bucket_id = 'phc-reports' AND o.name = p_storage_path;
  IF NOT FOUND OR v_storage_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png') THEN
    RAISE EXCEPTION 'Attachment object is missing or has an unsupported type'
      USING ERRCODE = '22023';
  END IF;
  IF p_mime_type IS NOT NULL AND p_mime_type IS DISTINCT FROM v_storage_mime THEN
    RAISE EXCEPTION 'Attachment MIME does not match the stored object'
      USING ERRCODE = '22023';
  END IF;
  IF p_water_sample_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.water_samples
    WHERE id = p_water_sample_id AND project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'Water sample does not belong to project' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.project_attachments (
    project_id, water_sample_id, kind, storage_path, filename,
    mime_type, notes, uploaded_by
  ) VALUES (
    p_project_id, p_water_sample_id, p_kind, p_storage_path, p_filename,
    v_storage_mime, p_notes, auth.uid()
  ) RETURNING * INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_project_attachment(
  p_attachment_id bigint,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attachment public.project_attachments;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_attachment
  FROM public.project_attachments WHERE id = p_attachment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM private.write_audit(
    v_attachment.project_id, 'attachment.deleted', 'project_attachments', v_attachment.id::text,
    to_jsonb(v_attachment), NULL, p_reason, '{}'::jsonb
  );
  DELETE FROM storage.objects
  WHERE bucket_id = 'phc-reports' AND name = v_attachment.storage_path;
  DELETE FROM public.project_attachments WHERE id = p_attachment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_completion_pdf(
  p_report_id bigint,
  p_storage_path text
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result public.completion_reports;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_result FROM public.completion_reports WHERE id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_result.finalized_at IS NULL OR v_result.admin_signature IS NULL THEN
    RAISE EXCEPTION 'The signed PDF can be attached only after the database signature'
      USING ERRCODE = '55000';
  END IF;
  IF v_result.signed_pdf_attached_at IS NOT NULL THEN
    RAISE EXCEPTION 'A signed PDF is already attached and cannot be replaced'
      USING ERRCODE = '55000';
  END IF;
  IF p_storage_path NOT LIKE v_result.project_id::text || '/%'
     OR lower(p_storage_path) NOT LIKE '%.pdf'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects o
       WHERE o.bucket_id = 'phc-reports'
         AND o.name = p_storage_path
         AND COALESCE(o.metadata ->> 'mimetype', '') = 'application/pdf'
     ) THEN
    RAISE EXCEPTION 'PDF path must reference a stored project-scoped PDF'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.completion_reports
  SET pdf_url = p_storage_path, signed_pdf_attached_at = now(), updated_at = now()
  WHERE id = p_report_id
  RETURNING * INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_record_corrections(
  p_row jsonb,
  p_entity_type text,
  p_entity_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb := COALESCE(p_row, '{}'::jsonb);
  v_correction public.record_corrections;
  v_fields text[] := ARRAY[]::text[];
  v_markers jsonb := '[]'::jsonb;
BEGIN
  FOR v_correction IN
    SELECT * FROM public.record_corrections c
    WHERE c.entity_type = p_entity_type AND c.entity_id = p_entity_id
    ORDER BY c.created_at, c.id
  LOOP
    v_result := jsonb_set(v_result, ARRAY[v_correction.field_name], v_correction.corrected_value, true);
    IF NOT v_correction.field_name = ANY(v_fields) THEN
      v_fields := array_append(v_fields, v_correction.field_name);
    END IF;
    v_markers := v_markers || jsonb_build_array(jsonb_build_object(
      'id', v_correction.id,
      'field', v_correction.field_name,
      'reason', v_correction.reason,
      'corrected_by', v_correction.corrected_by,
      'corrected_at', v_correction.created_at
    ));
  END LOOP;
  IF cardinality(v_fields) > 0 THEN
    v_result := v_result || jsonb_build_object(
      '_corrected_fields', to_jsonb(v_fields),
      '_corrections', v_markers
    );
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_closing_ficha_preview(p_project_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() AND NOT public.is_closing_operator(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to Ficha preview' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'project', (SELECT to_jsonb(p) FROM public.projects p WHERE p.id = p_project_id),
    'bars', (SELECT COALESCE(jsonb_agg(
               private.apply_record_corrections(to_jsonb(b), 'drilling_bars', b.id::text)
               ORDER BY b.bar_number), '[]'::jsonb)
             FROM public.drilling_bars b WHERE b.project_id = p_project_id),
    'shifts', (SELECT COALESCE(jsonb_agg(
                 private.apply_record_corrections(to_jsonb(s), 'shifts', s.id::text)
                 ORDER BY s.started_at), '[]'::jsonb)
               FROM public.shifts s WHERE s.project_id = p_project_id),
    'materials', (SELECT COALESCE(jsonb_agg(to_jsonb(pm) ORDER BY pm.layer, pm.material_name), '[]'::jsonb)
                  FROM public.project_materials pm WHERE pm.project_id = p_project_id AND pm.active IS TRUE),
    'consumption', (SELECT COALESCE(jsonb_agg(
                      private.apply_record_corrections(to_jsonb(mc), 'material_consumption', mc.id::text)
                      ORDER BY mc.created_at), '[]'::jsonb)
                    FROM public.material_consumption mc WHERE mc.project_id = p_project_id),
    'samples', (SELECT COALESCE(jsonb_agg(
                  private.apply_record_corrections(to_jsonb(ws), 'water_samples', ws.id::text)
                  ORDER BY ws.sample_number), '[]'::jsonb)
                FROM public.water_samples ws WHERE ws.project_id = p_project_id),
    'company_pedidos', (
      SELECT COALESCE(jsonb_agg(
        to_jsonb(p) || jsonb_build_object(
          'items', (SELECT COALESCE(jsonb_agg(to_jsonb(pi) ORDER BY pi.id), '[]'::jsonb)
                    FROM public.pedido_items pi WHERE pi.pedido_id = p.id)
        ) ORDER BY p.created_at
      ), '[]'::jsonb)
      FROM public.pedidos p WHERE p.project_id = p_project_id AND p.kind = 'empresa'
    ),
    'corrections', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at), '[]'::jsonb)
                    FROM public.record_corrections c WHERE c.project_id = p_project_id),
    'discrepancies', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]'::jsonb)
                      FROM public.completion_discrepancies d WHERE d.project_id = p_project_id),
    'completion', (SELECT private.apply_record_corrections(
                     to_jsonb(cr), 'completion_reports', cr.id::text)
                   FROM public.completion_reports cr
                   WHERE cr.project_id = p_project_id ORDER BY cr.created_at DESC LIMIT 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_project_dossier(p_project_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_base jsonb;
  v_snapshot jsonb;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT cr.finalized_snapshot INTO v_snapshot
  FROM public.completion_reports cr
  WHERE cr.project_id = p_project_id
    AND cr.finalized_at IS NOT NULL
    AND cr.finalized_snapshot IS NOT NULL
  ORDER BY cr.finalized_at DESC
  LIMIT 1;
  IF v_snapshot IS NOT NULL THEN
    -- Core operational evidence is the exact signing-time snapshot. Only the
    -- explicitly post-completion attachment/audit appendices remain live.
    RETURN v_snapshot || jsonb_build_object(
      'attachments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at), '[]'::jsonb)
                      FROM public.project_attachments a WHERE a.project_id = p_project_id),
      'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(al) ORDER BY al.created_at), '[]'::jsonb)
                FROM public.audit_log al WHERE al.project_id = p_project_id),
      'signed_snapshot', true
    );
  END IF;

  v_base := public.get_closing_ficha_preview(p_project_id);
  RETURN v_base || jsonb_build_object(
    'attachments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at), '[]'::jsonb)
                    FROM public.project_attachments a WHERE a.project_id = p_project_id),
    'reconciliations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
                        FROM public.material_reconciliations r WHERE r.project_id = p_project_id),
    'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(al) ORDER BY al.created_at), '[]'::jsonb)
              FROM public.audit_log al WHERE al.project_id = p_project_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_accountability_metrics(
  p_operator_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_operator_id uuid := COALESCE(p_operator_id, auth.uid());
  v_last_activity timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF v_operator_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to operator metrics' USING ERRCODE = '42501';
  END IF;
  SELECT max(activity_at) INTO v_last_activity FROM (
    SELECT max(created_at) activity_at FROM public.drilling_bars WHERE operator_id = v_operator_id
    UNION ALL SELECT max(created_at) FROM public.material_consumption WHERE operator_id = v_operator_id
    UNION ALL SELECT max(created_at) FROM public.pedidos WHERE operator_id = v_operator_id
    UNION ALL SELECT max(updated_at) FROM public.shifts WHERE operator_id = v_operator_id
  ) a;

  RETURN jsonb_build_object(
    'operator_id', v_operator_id,
    'current_project', (SELECT to_jsonb(p) FROM public.projects p
                        WHERE p.assigned_operator_id = v_operator_id
                          AND public.project_status_key(p.status) IN ('planning', 'active', 'closure_submitted')
                        ORDER BY p.updated_at DESC LIMIT 1),
    'current_shift', (SELECT to_jsonb(s) FROM public.shifts s
                      WHERE s.operator_id = v_operator_id AND s.status IN ('open', 'report_pending')
                      ORDER BY s.started_at DESC LIMIT 1),
    'shifts_completed', (SELECT count(*) FROM public.shifts s
                         WHERE s.operator_id = v_operator_id AND s.status = 'closed'),
    'hours_worked', (SELECT COALESCE(round((sum(extract(epoch FROM (s.ended_at - s.started_at))) / 3600)::numeric, 2), 0)
                     FROM public.shifts s WHERE s.operator_id = v_operator_id AND s.ended_at IS NOT NULL),
    'bars_registered', (SELECT count(*) FROM public.drilling_bars b WHERE b.operator_id = v_operator_id),
    'average_bar_minutes', (SELECT COALESCE(round(avg(b.duration_minutes)::numeric, 1), 0)
                            FROM public.drilling_bars b WHERE b.operator_id = v_operator_id AND b.duration_minutes IS NOT NULL),
    'material_reports_submitted', (SELECT count(*) FROM public.shifts s
                                   WHERE s.operator_id = v_operator_id AND s.usage_report_submitted IS TRUE),
    'missing_or_late_reports', (SELECT count(*) FROM public.shifts s
                                WHERE s.operator_id = v_operator_id
                                  AND (s.status = 'report_pending' OR s.end_type = 'auto'
                                       OR (s.status = 'open' AND s.started_at <= now() - interval '12 hours'))),
    'active_pedidos', (SELECT count(*) FROM public.pedidos p
                       WHERE p.operator_id = v_operator_id AND p.status NOT IN ('Cerrado', 'Rechazado')),
    'last_activity', v_last_activity,
    'account_active', (SELECT is_active FROM public.profiles WHERE id = v_operator_id)
  );
END;
$$;

DROP FUNCTION IF EXISTS public.sign_completion_report(bigint, text, boolean);
DROP FUNCTION IF EXISTS public.sign_completion_report(bigint, text, boolean, boolean);
CREATE FUNCTION public.sign_completion_report(
  p_report_id bigint,
  p_admin_signature text,
  p_complete_project boolean DEFAULT true,
  p_acknowledge_open_pedidos boolean DEFAULT false
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_report public.completion_reports;
  v_open_pedidos integer;
  v_snapshot jsonb;
  v_finalized_at timestamptz;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_admin_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Firma del administrador requerida' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.admin_signature IS NOT NULL AND btrim(v_report.admin_signature) <> '' THEN
    RAISE EXCEPTION 'El informe ya fue firmado' USING ERRCODE = '22023';
  END IF;

  IF v_report.format_version >= 2 THEN
    IF v_report.status <> 'submitted' OR v_report.submitted_at IS NULL THEN
      RAISE EXCEPTION 'La Ficha debe estar reenviada y pendiente de firma (estado: %)', v_report.status
        USING ERRCODE = '55000';
    END IF;
    IF p_complete_project IS NOT TRUE THEN
      RAISE EXCEPTION 'Una Ficha v2 firmada siempre debe completar el proyecto'
        USING ERRCODE = '22023';
    END IF;
    IF NOT public.project_allows_closure_change(v_report.project_id) THEN
      RAISE EXCEPTION 'El proyecto no está en un estado de cierre válido'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.completion_discrepancies
      WHERE project_id = v_report.project_id AND status = 'open'
    ) THEN
      RAISE EXCEPTION 'Resolve las discrepancias abiertas antes de firmar'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.shifts s
      WHERE s.project_id = v_report.project_id
        AND s.status IN ('open', 'report_pending')
    ) THEN
      RAISE EXCEPTION 'Todos los turnos deben permanecer cerrados hasta la firma'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.project_materials pm
      LEFT JOIN public.material_reconciliations r
        ON r.project_id = pm.project_id AND r.project_material_id = pm.id
      WHERE pm.project_id = v_report.project_id
        AND pm.active IS TRUE
        AND (
          r.id IS NULL
          OR abs(r.sent_quantity - COALESCE(pm.initial_quantity, 0)) > 0.00001
          OR abs(r.consumed_quantity - greatest(
               COALESCE(pm.initial_quantity, 0) - COALESCE(pm.current_quantity, 0), 0
             )) > 0.00001
          OR r.returned_quantity > greatest(
               COALESCE(pm.initial_quantity, 0) - greatest(
                 COALESCE(pm.initial_quantity, 0) - COALESCE(pm.current_quantity, 0), 0
               ), 0
             ) + 0.00001
        )
    ) THEN
      RAISE EXCEPTION 'Completa o actualiza la reconciliación de cada material activo antes de firmar'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT count(*) INTO v_open_pedidos
  FROM public.pedidos
  WHERE project_id = v_report.project_id
    AND kind = 'empresa'
    AND status NOT IN ('Cerrado', 'Rechazado');
  IF v_report.format_version >= 2 AND v_open_pedidos > 0
     AND p_acknowledge_open_pedidos IS NOT TRUE THEN
    RAISE EXCEPTION 'OPEN_PEDIDOS_ACK_REQUIRED: hay % pedido(s) abiertos; cerrá o reconocé que quedarán congelados al firmar',
      v_open_pedidos USING ERRCODE = 'P0001';
  END IF;

  v_finalized_at := now();
  v_snapshot := public.get_admin_project_dossier(v_report.project_id);
  v_snapshot := jsonb_set(
    v_snapshot,
    ARRAY['completion'],
    to_jsonb(v_report) || jsonb_build_object(
      'admin_signature', btrim(p_admin_signature),
      'status', 'approved',
      'finalized_at', v_finalized_at
    ),
    true
  );
  PERFORM set_config('phc.audit_reason', 'Firma administrativa de Ficha', true);
  UPDATE public.completion_reports
  SET admin_signature = btrim(p_admin_signature), status = 'approved',
      finalized_at = v_finalized_at, finalized_snapshot = v_snapshot,
      updated_at = v_finalized_at
  WHERE id = p_report_id
  RETURNING * INTO v_report;

  IF p_complete_project THEN
    PERFORM set_config('phc.project_completion', 'on', true);
    UPDATE public.projects
    SET status = 'completed', updated_at = now(), end_date = COALESCE(end_date, CURRENT_DATE)
    WHERE id = v_report.project_id;
  END IF;

  PERFORM private.write_audit(
    v_report.project_id, 'ficha.signed', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), NULL,
    jsonb_build_object('open_pedidos_warning_count', v_open_pedidos)
  );
  RETURN v_report;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_notification_event(
  p_event_type text,
  p_entity_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_event_type NOT IN ('pedido_created', 'low_stock', 'completion_signed')
     OR p_entity_id IS NULL OR p_entity_id <= 0 THEN
    RAISE EXCEPTION 'Invalid notification event' USING ERRCODE = '22023';
  END IF;
  IF p_event_type = 'pedido_created' AND NOT public.is_admin() AND NOT EXISTS (
    SELECT 1 FROM public.pedidos p
    WHERE p.id = p_entity_id AND p.operator_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized for this pedido event' USING ERRCODE = '42501';
  ELSIF p_event_type IN ('low_stock', 'completion_signed') AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required for this event' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.notification_event_claims (
    event_type, entity_id, claimed_by, claimed_at
  ) VALUES (
    p_event_type, p_entity_id, auth.uid(), now()
  )
  ON CONFLICT (event_type, entity_id) DO UPDATE
    SET claimed_by = EXCLUDED.claimed_by, claimed_at = EXCLUDED.claimed_at
    WHERE public.notification_event_claims.sent_at IS NULL
      AND public.notification_event_claims.claimed_at < now() - interval '15 minutes'
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_notification_event_sent(
  p_event_type text,
  p_entity_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.notification_event_claims
  SET sent_at = now()
  WHERE event_type = p_event_type AND entity_id = p_entity_id
    AND claimed_by = auth.uid() AND sent_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_notification_event_claim(
  p_event_type text,
  p_entity_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.notification_event_claims
  WHERE event_type = p_event_type AND entity_id = p_entity_id
    AND claimed_by = auth.uid() AND sent_at IS NULL;
END;
$$;

-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "Assigned operators closers and admins read project photos" ON storage.objects;
DROP POLICY IF EXISTS "Active operators and admins upload constrained project photos" ON storage.objects;
DROP POLICY IF EXISTS "Authorized users read reports and admins read attachments" ON storage.objects;
DROP POLICY IF EXISTS "Authorized users upload constrained reports and attachments" ON storage.objects;

-- Storage isolation and evidence immutability
-- --------------------------------------------------------------------------

DROP POLICY IF EXISTS "Assigned operators and admins can read project photos" ON storage.objects;
CREATE POLICY "Assigned operators closers and admins read project photos"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'phc-photos'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND (
    public.is_admin()
    OR public.is_project_operator(public.storage_project_id(objects.name))
    OR public.is_closing_operator(public.storage_project_id(objects.name))
  )
);

DROP POLICY IF EXISTS "Assigned operators and admins can upload project photos" ON storage.objects;
CREATE POLICY "Active operators and admins upload constrained project photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-photos'
  AND objects.name ~ '^[1-9][0-9]*/[^/]+\.(jpg|jpeg|png|webp)$'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND COALESCE((objects.metadata ->> 'mimetype') IN ('image/jpeg', 'image/png', 'image/webp'), false)
  AND public.safe_bigint(objects.metadata ->> 'size') BETWEEN 1 AND 10485760
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = public.storage_project_id(objects.name)
      AND public.project_status_key(p.status) = 'active'
  )
  AND (
    public.is_admin()
    OR public.is_project_operator(public.storage_project_id(objects.name))
  )
);

DROP POLICY IF EXISTS "Only admins can delete project photos" ON storage.objects;

DROP POLICY IF EXISTS "Assigned operators and admins can read report PDFs" ON storage.objects;
CREATE POLICY "Authorized users read reports and admins read attachments"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'phc-reports'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND (
    public.is_admin()
    OR (
      COALESCE((storage.foldername(objects.name))[2], '') <> 'attachments'
      AND (
        public.is_project_operator(public.storage_project_id(objects.name))
        OR public.is_closing_operator(public.storage_project_id(objects.name))
      )
    )
  )
);

DROP POLICY IF EXISTS "Assigned operators and admins can upload report PDFs" ON storage.objects;
CREATE POLICY "Authorized users upload constrained reports and attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-reports'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND public.safe_bigint(objects.metadata ->> 'size') BETWEEN 1 AND 20971520
  AND EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = public.storage_project_id(objects.name)
  )
  AND (
    (
      COALESCE((storage.foldername(objects.name))[2], '') = 'attachments'
      AND public.is_admin()
      AND objects.name ~ '^[1-9][0-9]*/attachments/[^/]+\.(pdf|jpg|jpeg|png)$'
      AND COALESCE((objects.metadata ->> 'mimetype') IN ('application/pdf', 'image/jpeg', 'image/png'), false)
    )
    OR (
      COALESCE((storage.foldername(objects.name))[2], '') <> 'attachments'
      AND objects.name ~ '^[1-9][0-9]*/[^/]+\.pdf$'
      AND COALESCE(objects.metadata ->> 'mimetype', '') = 'application/pdf'
      AND (
        public.is_admin()
        OR (
          EXISTS (
            SELECT 1 FROM public.projects p
            WHERE p.id = public.storage_project_id(objects.name)
              AND public.project_status_key(p.status) IN ('active', 'closure_submitted')
          )
          AND (
            public.is_project_operator(public.storage_project_id(objects.name))
            OR public.is_closing_operator(public.storage_project_id(objects.name))
          )
        )
      )
    )
  )
);

DROP POLICY IF EXISTS "Admins can update report PDFs" ON storage.objects;
DROP POLICY IF EXISTS "Only admins can delete report PDFs" ON storage.objects;
DROP POLICY IF EXISTS "Admins delete attachment objects only" ON storage.objects;
-- No direct authenticated DELETE policy: delete_project_attachment() is the
-- only path and atomically records a mandatory reason before removing object
-- + metadata. Signed report PDFs and field photos cannot be deleted.

-- --------------------------------------------------------------------------
-- Explicit Data API grants and function exposure
-- --------------------------------------------------------------------------

GRANT SELECT ON TABLE
  public.profiles, public.projects, public.project_materials,
  public.material_consumption, public.drilling_bars, public.photos,
  public.pedidos, public.completion_reports
TO authenticated;
GRANT INSERT ON TABLE public.pedidos, public.completion_reports, public.photos TO authenticated;
GRANT INSERT, UPDATE ON TABLE public.projects TO authenticated;
GRANT UPDATE ON TABLE public.profiles TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

REVOKE UPDATE, DELETE ON public.completion_reports FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.photos FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.pedidos FROM anon, authenticated;

-- Supabase/PostgREST does not support overloaded RPCs reliably. All public
-- callable names above have one signature. Default PUBLIC execution is
-- removed, then the allow-list is granted to authenticated callers.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'is_admin', 'is_active_user', 'is_project_operator', 'is_closing_operator',
        'normalize_catalog_name', 'project_status_key',
        'project_allows_field_work', 'project_allows_planning_change',
        'project_allows_closure_change', 'storage_project_id', 'safe_bigint',
        'create_drilling_bar', 'record_material_consumption',
        'upsert_catalog_material', 'upsert_catalog_variant',
        'set_project_closing_operator', 'assign_catalog_material_to_project',
        'update_project_material_assignment', 'deactivate_project_material_assignment',
        'import_project_materials', 'save_material_reconciliation',
        'record_admin_correction', 'start_shift', 'confirm_shift_handover', 'end_shift',
        'create_pedido_v2', 'decide_pedido_item', 'confirm_pedido_item_receipt',
        'close_pedido_manually', 'approve_pedido', 'reject_pedido',
        'submit_completion_v2', 'return_completion_v2', 'resubmit_completion_v2',
        'report_completion_discrepancy',
        'resolve_completion_discrepancy', 'register_water_sample',
        'register_project_attachment', 'delete_project_attachment',
        'attach_completion_pdf', 'get_closing_ficha_preview',
        'get_admin_project_dossier', 'get_operator_accountability_metrics',
        'sign_completion_report', 'claim_notification_event',
        'mark_notification_event_sent', 'release_notification_event_claim'
      ])
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_function);
  END LOOP;
END;
$$;

-- Trigger-only helpers remain unavailable as RPC endpoints.
REVOKE ALL ON FUNCTION private.create_legacy_pedido_item() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_legacy_pedido_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reject_append_only_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_operational_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_closed_shift() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_finalized_completion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_completion_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_completed_project() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_project_lifecycle_transition() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_finalized_project_child() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_finalized_pedido_child() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_catalog_code_namespace() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_completion_final_fields(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.apply_record_corrections(jsonb, text, text) FROM PUBLIC, anon, authenticated;
