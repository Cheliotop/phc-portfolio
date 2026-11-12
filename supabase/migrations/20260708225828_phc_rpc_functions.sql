-- =====================================================================
-- Migration: phc_rpc_functions  (version 20260708225828)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- =====================================================
-- PHC: atomic RPC functions to replace Express business logic
-- =====================================================

-- Helper: check current caller's app role without relying on JWT claims
-- (no custom access token hook is configured on this project, so
-- auth.jwt() ->> 'role' only ever returns the Postgres/PostgREST role,
-- never 'admin'/'operator'. This checks the profiles table instead,
-- running as the caller so it only ever reads the caller's own row
-- via the existing "Users can view own profile" policy.)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- 1. create_drilling_bar: atomic bar numbering + depth chaining + idempotency
CREATE OR REPLACE FUNCTION public.create_drilling_bar(
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
  p_timestamp_local text DEFAULT NULL
)
RETURNS public.drilling_bars
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project public.projects;
  v_existing public.drilling_bars;
  v_last_bar integer;
  v_current_depth real;
  v_length real;
  v_depth_start real;
  v_depth_end real;
  v_bar_number integer;
  v_result public.drilling_bars;
  v_progress integer;
BEGIN
  IF p_client_entry_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.drilling_bars WHERE client_entry_id = p_client_entry_id;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock the project row so concurrent bar creations for the same project serialize.
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_admin() AND v_project.assigned_operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;

  IF p_soil_type IS NULL OR btrim(p_soil_type) = '' THEN
    RAISE EXCEPTION 'soil_type is required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(bar_number), 0), COALESCE(MAX(depth_end), 0)
    INTO v_last_bar, v_current_depth
    FROM public.drilling_bars WHERE project_id = p_project_id;

  v_bar_number := v_last_bar + 1;
  v_length := COALESCE(p_length, v_project.default_bar_length, 3);
  v_depth_start := v_current_depth;
  v_depth_end := v_depth_start + v_length;

  IF v_depth_end <= v_depth_start THEN
    RAISE EXCEPTION 'depth_end must be greater than depth_start' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.drilling_bars (
    client_entry_id, project_id, operator_id, bar_number, depth_start, depth_end,
    length, diameter, soil_type, start_time, end_time, duration_minutes,
    water_level, notes, photo_paths, timestamp_local
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), v_bar_number, v_depth_start, v_depth_end,
    v_length, COALESCE(p_diameter, v_project.default_bar_diameter), btrim(p_soil_type),
    p_start_time, p_end_time, p_duration_minutes, p_water_level, p_notes,
    p_photo_paths, COALESCE(p_timestamp_local, now()::text)
  )
  RETURNING * INTO v_result;

  IF v_project.target_depth IS NOT NULL AND v_project.target_depth > 0 THEN
    v_progress := LEAST(100, ROUND((v_depth_end / v_project.target_depth) * 100));
    UPDATE public.projects SET progress_percentage = v_progress, updated_at = now() WHERE id = p_project_id;
  ELSE
    UPDATE public.projects SET updated_at = now() WHERE id = p_project_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_drilling_bar FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_drilling_bar TO authenticated;

-- 2. assign_material_to_project: atomic stock decrement + allocation upsert
CREATE OR REPLACE FUNCTION public.assign_material_to_project(
  p_project_id bigint,
  p_material_id bigint,
  p_quantity real,
  p_notes text DEFAULT NULL
)
RETURNS public.project_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_material public.materials;
  v_existing public.project_materials;
  v_result public.project_materials;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_material FROM public.materials WHERE id = p_material_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Material not found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_material.current_stock, 0) < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.project_materials
    WHERE project_id = p_project_id AND material_id = p_material_id FOR UPDATE;

  IF FOUND THEN
    UPDATE public.project_materials SET
      quantity_allocated = COALESCE(quantity_allocated, 0) + p_quantity,
      initial_quantity = COALESCE(initial_quantity, 0) + p_quantity,
      current_quantity = COALESCE(current_quantity, 0) + p_quantity,
      material_name = COALESCE(material_name, v_material.name),
      unit = COALESCE(unit, v_material.unit),
      notes = COALESCE(p_notes, notes),
      updated_at = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.project_materials (
      project_id, material_id, material_name, quantity_allocated,
      initial_quantity, current_quantity, unit, assigned_date, notes
    ) VALUES (
      p_project_id, p_material_id, v_material.name, p_quantity,
      p_quantity, p_quantity, v_material.unit, now(), p_notes
    )
    RETURNING * INTO v_result;
  END IF;

  UPDATE public.materials
    SET current_stock = COALESCE(current_stock, 0) - p_quantity,
        quantity = COALESCE(quantity, 0) - p_quantity,
        updated_at = now()
    WHERE id = p_material_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_material_to_project FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_material_to_project TO authenticated;

-- 3. record_material_consumption: atomic allocation decrement + insufficient-qty check
CREATE OR REPLACE FUNCTION public.record_material_consumption(
  p_project_id bigint,
  p_quantity_used real,
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
  v_result public.material_consumption;
BEGIN
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
    project_id, operator_id, project_material_id, material_id, material_name,
    quantity_used, unit, date, notes
  ) VALUES (
    p_project_id, auth.uid(), p_project_material_id,
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

REVOKE ALL ON FUNCTION public.record_material_consumption FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_material_consumption TO authenticated;

-- 4. adjust_material_stock: atomic stock adjustment + transaction log + low-stock alert
CREATE OR REPLACE FUNCTION public.adjust_material_stock(
  p_material_id bigint,
  p_quantity real,
  p_reason text DEFAULT NULL
)
RETURNS public.materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_material public.materials;
  v_new_stock real;
  v_type text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_material FROM public.materials WHERE id = p_material_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Material not found' USING ERRCODE = 'P0002';
  END IF;

  v_new_stock := COALESCE(v_material.current_stock, 0) + p_quantity;
  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for this adjustment' USING ERRCODE = '22023';
  END IF;

  UPDATE public.materials
    SET current_stock = v_new_stock, quantity = v_new_stock, updated_at = now()
    WHERE id = p_material_id;

  v_type := CASE WHEN p_quantity > 0 THEN 'purchase' ELSE 'adjustment' END;
  INSERT INTO public.material_transactions (material_id, transaction_type, type, quantity, notes, created_by)
    VALUES (p_material_id, v_type, v_type, p_quantity, p_reason, auth.uid());

  IF v_new_stock <= COALESCE(v_material.minimum_stock, 0) THEN
    INSERT INTO public.notifications (user_id, title, message, type, related_material)
      SELECT id, 'Low Stock Alert',
             v_material.name || ' inventory is below minimum threshold (' || v_new_stock || ' ' || COALESCE(v_material.unit, '') || ' remaining)',
             'warning', p_material_id
      FROM public.profiles WHERE role = 'admin';
  END IF;

  SELECT * INTO v_material FROM public.materials WHERE id = p_material_id;
  RETURN v_material;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_material_stock FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_material_stock TO authenticated;

-- 5. pedido_number auto-generation (matches old backend's PHC-YYYYMMDD-### format)
CREATE OR REPLACE FUNCTION public.generate_pedido_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_date_str text;
  v_count integer;
BEGIN
  IF NEW.pedido_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  v_date_str := to_char(now(), 'YYYYMMDD');
  SELECT COUNT(*) + 1 INTO v_count FROM public.pedidos WHERE created_at::date = CURRENT_DATE;
  NEW.pedido_number := 'PHC-' || v_date_str || '-' || lpad(v_count::text, 3, '0');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_pedido_number ON public.pedidos;
CREATE TRIGGER set_pedido_number BEFORE INSERT ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION public.generate_pedido_number();
