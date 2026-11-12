-- Recovered from remote supabase_migrations.schema_migrations on 2026-07-11:
-- this migration was applied directly to the live project on 2026-07-10 and
-- never committed as a file. Recorded here verbatim so local history matches
-- the remote. Do NOT edit or re-apply; superseded in part by
-- 20260711102930_phc_product_plan_v2.sql.

-- Once a project is completed (cierre signed) or cancelled, non-admin
-- operators should no longer be able to add new drilling bars, log material
-- consumption, or submit new pedidos against it. Nothing previously enforced
-- this at any layer -- found during manual QA on 2026-07-10 when the
-- operator flow kept working normally against an already-completed test
-- project. Admins are exempt (may need to correct/append records).

CREATE OR REPLACE FUNCTION public.create_drilling_bar(p_project_id bigint, p_soil_type text, p_client_entry_id text DEFAULT NULL::text, p_length real DEFAULT NULL::real, p_diameter text DEFAULT NULL::text, p_start_time text DEFAULT NULL::text, p_end_time text DEFAULT NULL::text, p_duration_minutes integer DEFAULT NULL::integer, p_water_level real DEFAULT NULL::real, p_notes text DEFAULT NULL::text, p_photo_paths text DEFAULT NULL::text, p_timestamp_local text DEFAULT NULL::text)
 RETURNS drilling_bars
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF NOT public.is_admin() AND v_project.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Este pozo ya fue completado. No se puede registrar mas progreso.' USING ERRCODE = '22023';
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
$function$;

CREATE OR REPLACE FUNCTION public.record_material_consumption(p_project_id bigint, p_quantity_used real, p_client_entry_id text DEFAULT NULL::text, p_project_material_id bigint DEFAULT NULL::bigint, p_material_id bigint DEFAULT NULL::bigint, p_material_name text DEFAULT NULL::text, p_unit text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text)
 RETURNS material_consumption
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF NOT public.is_admin() AND v_project.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Este pozo ya fue completado. No se puede registrar uso de material.' USING ERRCODE = '22023';
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
$function$;

DROP POLICY IF EXISTS "Operators can create pedidos" ON public.pedidos;
CREATE POLICY "Operators can create pedidos"
ON public.pedidos FOR INSERT TO public
WITH CHECK (
  auth.uid() = operator_id
  AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = pedidos.project_id
      AND projects.status NOT IN ('completed', 'cancelled')
    )
  )
);
