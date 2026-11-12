-- =====================================================================
-- Migration: phc_idempotency_columns  (version 20260708232125)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- Only drilling_bars had client_entry_id/idempotency support. Extending the
-- offline outbox to pedidos, material_consumption, and completion_reports
-- means their submissions can also be retried after a dropped response, so
-- they need the same replay-safety.

ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS client_entry_id text UNIQUE;
ALTER TABLE public.completion_reports ADD COLUMN IF NOT EXISTS client_entry_id text UNIQUE;
ALTER TABLE public.material_consumption ADD COLUMN IF NOT EXISTS client_entry_id text UNIQUE;

-- Rebuild record_material_consumption with idempotency (check client_entry_id
-- first, same pattern as create_drilling_bar).
CREATE OR REPLACE FUNCTION public.record_material_consumption(
  p_project_id bigint,
  p_quantity_used real,
  p_client_entry_id text DEFAULT NULL,
  p_project_material_id bigint DEFAULT NULL,
  p_material_id bigint DEFAULT NULL,
  p_material_name text DEFAULT NULL,
  p_unit text DEFAULT NULL,
  p_date date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.material_consumption
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project public.projects;
  v_assigned public.project_materials;
  v_existing public.material_consumption;
  v_result public.material_consumption;
BEGIN
  IF p_client_entry_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.material_consumption WHERE client_entry_id = p_client_entry_id;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_admin() AND v_project.assigned_operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF p_quantity_used IS NULL OR p_quantity_used <= 0 THEN
    RAISE EXCEPTION 'quantity_used must be positive' USING ERRCODE = '22023';
  END IF;

  IF p_project_material_id IS NOT NULL THEN
    SELECT * INTO v_assigned FROM public.project_materials
      WHERE id = p_project_material_id AND project_id = p_project_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assigned material not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(v_assigned.current_quantity, 0) < p_quantity_used THEN
      RAISE EXCEPTION 'Insufficient assigned material quantity' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.material_consumption (
    client_entry_id, project_id, operator_id, project_material_id, material_id, material_name,
    quantity_used, unit, date, notes
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), p_project_material_id,
    COALESCE(p_material_id, v_assigned.material_id),
    COALESCE(p_material_name, v_assigned.material_name, 'Material'),
    p_quantity_used, COALESCE(p_unit, v_assigned.unit),
    COALESCE(p_date, CURRENT_DATE), p_notes
  )
  RETURNING * INTO v_result;

  IF v_assigned.id IS NOT NULL THEN
    UPDATE public.project_materials
      SET current_quantity = current_quantity - p_quantity_used, updated_at = now()
      WHERE id = v_assigned.id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text) TO authenticated;

-- The old 8-arg overload is now shadowed; drop it so PostgREST doesn't have
-- two ambiguous /rpc/record_material_consumption signatures.
DROP FUNCTION IF EXISTS public.record_material_consumption(bigint, real, bigint, bigint, text, text, date, text);
