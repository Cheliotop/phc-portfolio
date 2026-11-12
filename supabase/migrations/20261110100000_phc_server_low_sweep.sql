-- Low sweep of docs/audits/2026-11-08-full-audit (ADM-10, SEC-11, SEC-12, SEC-15, SRV-14, SRV-18, SRV-19).
-- Every function body is the newest definition in the database plus the edits marked in place.
-- Messages a client matches on are unchanged (see the SRV-14 note above the message edits in the suite).


-- ======================================================================
-- ADM-10: a well's operator must be an active operator. Checked only when the column is set or changed,
-- so existing rows that are not touched never block.
CREATE OR REPLACE FUNCTION private.check_project_operator_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.assigned_operator_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_operator_id IS NOT DISTINCT FROM OLD.assigned_operator_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = NEW.assigned_operator_id AND p.role = 'operator' AND p.is_active IS TRUE
  ) THEN
    RAISE EXCEPTION 'El operador asignado al pozo debe ser un operador activo' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.check_project_operator_assignment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS check_project_operator_assignment ON public.projects;
CREATE TRIGGER check_project_operator_assignment
  BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION private.check_project_operator_assignment();


-- ======================================================================
-- SEC-11: dead policies. Each table lacks the matching grant for authenticated and anon, so these never
-- applied. Writes to these tables go through the RPCs only.
DROP POLICY IF EXISTS "Admins can update any drilling bar" ON public.drilling_bars;
DROP POLICY IF EXISTS "Only admins can update pedidos status" ON public.pedidos;
DROP POLICY IF EXISTS "Only admins can update completion reports" ON public.completion_reports;
DROP POLICY IF EXISTS "Only admins can insert materials" ON public.materials;
DROP POLICY IF EXISTS "Only admins can update materials" ON public.materials;
DROP POLICY IF EXISTS "Only admins can manage project materials" ON public.project_materials;
DROP POLICY IF EXISTS "Only admins can update project materials" ON public.project_materials;
DROP POLICY IF EXISTS "Only admins can delete project materials" ON public.project_materials;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.material_transactions;
DROP POLICY IF EXISTS "Operators can submit reports" ON public.progress_reports;


-- ======================================================================
-- SEC-12: true when a photo_paths entry that names a file is outside this well's folder.
-- Text that is not a JSON list is not checked here (it was never a photo list).
CREATE OR REPLACE FUNCTION private.photo_paths_outside_project(p_project_id bigint, p_photo_paths text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_photos jsonb;
BEGIN
  IF p_photo_paths IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    v_photos := p_photo_paths::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  IF jsonb_typeof(v_photos) <> 'array' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_photos) AS e(entry)
    WHERE jsonb_typeof(e.entry) = 'object'
      AND jsonb_typeof(e.entry -> 'filename') = 'string'
      AND NOT starts_with(e.entry ->> 'filename', p_project_id::text || '/')
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.photo_paths_outside_project(bigint, text) FROM PUBLIC, anon, authenticated;

-- SEC-12: client_errors free text is cut to 8000 characters on insert (refused never).
CREATE OR REPLACE FUNCTION private.cap_client_error_text()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.message := left(NEW.message, 8000);
  NEW.stack := left(NEW.stack, 8000);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.cap_client_error_text() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cap_client_error_text ON public.client_errors;
CREATE TRIGGER cap_client_error_text
  BEFORE INSERT ON public.client_errors
  FOR EACH ROW EXECUTE FUNCTION private.cap_client_error_text();


-- ======================================================================
-- SEC-15: the project_allows_* helpers are called only by SECURITY DEFINER functions (owner rights),
-- and neither app calls them through .rpc(). Clients lose EXECUTE; service_role keeps it.
REVOKE ALL ON FUNCTION public.project_allows_field_work(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_allows_closure_change(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_allows_planning_change(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_allows_field_work(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_allows_closure_change(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_allows_planning_change(bigint) TO service_role;


-- ======================================================================
-- SRV-19: client JSON casts that answer with a Spanish 22023 instead of a raw cast error.
CREATE OR REPLACE FUNCTION private.pedido_item_real(p_value text)
 RETURNS real
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_result real;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  v_result := p_value::real;
  IF NOT private.is_finite_real(v_result) THEN
    RAISE EXCEPTION 'La cantidad solicitada de un ítem no es válida' USING ERRCODE = '22023';
  END IF;
  RETURN v_result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'La cantidad solicitada de un ítem no es válida' USING ERRCODE = '22023';
END;
$function$;
REVOKE ALL ON FUNCTION private.pedido_item_real(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.pedido_item_bigint(p_value text)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN p_value::bigint;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'El identificador de la variante de un ítem no es válido' USING ERRCODE = '22023';
END;
$function$;
REVOKE ALL ON FUNCTION private.pedido_item_bigint(text) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.create_drilling_bar_core (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.create_drilling_bar_core(p_project_id bigint, p_soil_type text, p_client_entry_id text DEFAULT NULL::text, p_length real DEFAULT NULL::real, p_diameter text DEFAULT NULL::text, p_start_time text DEFAULT NULL::text, p_end_time text DEFAULT NULL::text, p_duration_minutes integer DEFAULT NULL::integer, p_water_level real DEFAULT NULL::real, p_notes text DEFAULT NULL::text, p_photo_paths text DEFAULT NULL::text, p_timestamp_local text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS drilling_bars
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.drilling_bars;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin()
     AND NOT private.owns_force_closed_shift(p_project_id, p_shift_id) THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF p_client_entry_id IS NOT NULL
     AND length(btrim(p_client_entry_id)) = 0 THEN
    RAISE EXCEPTION 'Falta el identificador del registro' USING ERRCODE = '22023';
  END IF;
  IF p_shift_id IS NOT NULL AND p_client_entry_id IS NULL THEN
    RAISE EXCEPTION 'Una barra de turno requiere el identificador del registro' USING ERRCODE = '22023';
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'soil_type', btrim(p_soil_type),
    'length', p_length, 'diameter', p_diameter,
    'start_time', p_start_time, 'end_time', p_end_time,
    'duration_minutes', p_duration_minutes, 'water_level', p_water_level,
    'notes', p_notes, 'photo_paths', p_photo_paths,
    'timestamp_local', p_timestamp_local, 'shift_id', p_shift_id
  ));
  IF p_client_entry_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('create_drilling_bar:' || p_client_entry_id, 0)
    );
    SELECT * INTO v_existing
    FROM public.drilling_bars
    WHERE client_entry_id = p_client_entry_id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.operator_id IS DISTINCT FROM auth.uid()
         OR v_existing.project_id IS DISTINCT FROM p_project_id
         OR v_existing.request_payload IS DISTINCT FROM v_payload THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;
  RETURN private.create_drilling_bar_20260712_impl(
    p_project_id, p_soil_type, p_client_entry_id, p_length, p_diameter,
    p_start_time, p_end_time, p_duration_minutes, p_water_level, p_notes,
    p_photo_paths, p_timestamp_local, p_shift_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.create_drilling_bar_core(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.create_drilling_bar_20260712_impl (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.create_drilling_bar_20260712_impl(p_project_id bigint, p_soil_type text, p_client_entry_id text DEFAULT NULL::text, p_length real DEFAULT NULL::real, p_diameter text DEFAULT NULL::text, p_start_time text DEFAULT NULL::text, p_end_time text DEFAULT NULL::text, p_duration_minutes integer DEFAULT NULL::integer, p_water_level real DEFAULT NULL::real, p_notes text DEFAULT NULL::text, p_photo_paths text DEFAULT NULL::text, p_timestamp_local text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS drilling_bars
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_captured_server_time timestamptz;
  v_last_bar_local text;
  v_new_captured timestamptz;
  v_last_captured timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin()
     AND NOT private.owns_force_closed_shift(p_project_id, p_shift_id) THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pozo no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'Project is not active' USING ERRCODE = '55000';
  END IF;
  IF p_shift_id IS NOT NULL THEN
    SELECT * INTO v_shift
    FROM public.shifts
    WHERE id = p_shift_id AND project_id = p_project_id
      AND (operator_id = auth.uid() OR private.is_project_crew_for(auth.uid(), p_project_id))
      AND status IN ('open', 'report_pending', 'closed')
      AND handover_confirmed IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A handover-confirmed shift for this project is required'
        USING ERRCODE = '55000';
    END IF;
    IF NULLIF(btrim(COALESCE(p_timestamp_local, '')), '') IS NOT NULL THEN
      BEGIN
        v_captured_at := p_timestamp_local::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'La hora local de la barra no tiene un formato válido'
          USING ERRCODE = '22023';
      END;
    END IF;
    IF (v_shift.status IN ('report_pending', 'closed')
        OR v_shift.started_at <= now() - interval '12 hours')
       AND v_captured_at IS NULL THEN
      RAISE EXCEPTION 'Una barra cargada sin conexión necesita su hora de captura'
        USING ERRCODE = '22023';
    END IF;
    IF v_shift.status = 'closed' THEN
      -- A force-closed shift has no report and never will, but its bars really happened.
      -- The time window below still sends anything recorded after the close to review.
      IF v_shift.ended_at IS NULL
         OR (v_shift.usage_report_submitted IS NOT TRUE AND v_shift.end_type IS DISTINCT FROM 'admin') THEN
        RAISE EXCEPTION 'El turno cerrado necesita su informe de consumo antes de reenviar barras sin conexión'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.completion_reports
        WHERE project_id = p_project_id AND format_version >= 2
      ) THEN
        RAISE EXCEPTION 'No se pueden agregar barras sin conexión después de enviar la Ficha'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    -- The phone stamps a bar with its own clock, while a shift now starts on the
    -- server's. Convert with the difference seen at the start, so a wrong clock
    -- does not push a real bar outside its own shift.
    v_captured_server_time := v_captured_at
      - COALESCE(v_shift.start_device_time - v_shift.started_at, interval '0');
    IF v_captured_at IS NOT NULL AND (
      v_captured_server_time < v_shift.started_at - interval '15 minutes'
      OR v_captured_server_time > v_shift.started_at + interval '12 hours 15 minutes'
      OR (v_shift.status = 'closed'
          AND v_captured_server_time > v_shift.ended_at + interval '15 minutes')
    ) THEN
      RAISE EXCEPTION 'La hora de la barra cae fuera del horario del turno'
        USING ERRCODE = '22023';
    END IF;
  ELSIF now() >= timestamptz '2026-08-01 00:00:00+00'
     OR v_project.created_at >= timestamptz '2026-07-11 10:29:30+00' THEN
    RAISE EXCEPTION 'SHIFT_REQUIRED: actualizá la app e iniciá un turno primero'
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
  -- SEC-12: a photo is evidence for this well only; its object lives under '<project_id>/'.
  IF private.photo_paths_outside_project(p_project_id, p_photo_paths) THEN
    RAISE EXCEPTION 'Una foto no pertenece a este pozo' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(COALESCE(p_soil_type, ''))) = 0 THEN
    RAISE EXCEPTION 'Falta el tipo de suelo' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(bar_number), 0), COALESCE(MAX(depth_end), 0)
  INTO v_last_bar, v_current_depth
  FROM public.drilling_bars WHERE project_id = p_project_id;
  SELECT db.timestamp_local INTO v_last_bar_local
  FROM public.drilling_bars db
  WHERE db.project_id = p_project_id AND db.bar_number = v_last_bar;
  v_new_captured := private.try_timestamptz(p_timestamp_local);
  v_last_captured := private.try_timestamptz(v_last_bar_local);
  v_length := COALESCE(p_length, v_project.default_bar_length, 3);
  IF v_length <= 0 OR v_length > 50 THEN
    RAISE EXCEPTION 'La longitud de barra debe estar entre 0 y 50 m' USING ERRCODE = '22023';
  END IF;
  IF p_duration_minutes IS NOT NULL
     AND (p_duration_minutes < 0 OR p_duration_minutes > 1440) THEN
    RAISE EXCEPTION 'La duración de barra debe estar entre 0 y 1440 minutos' USING ERRCODE = '22023';
  END IF;
  IF p_water_level IS NOT NULL AND p_water_level < 0 THEN
    RAISE EXCEPTION 'El nivel de agua no puede ser negativo' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.drilling_bars (
    client_entry_id, project_id, operator_id, shift_id, bar_number,
    depth_start, depth_end, length, diameter, soil_type, start_time,
    end_time, duration_minutes, water_level, notes, photo_paths, timestamp_local,
    request_payload, arrived_late
  ) VALUES (
    p_client_entry_id, p_project_id, auth.uid(), p_shift_id, v_last_bar + 1,
    v_current_depth, v_current_depth + v_length, v_length,
    COALESCE(p_diameter, v_project.default_bar_diameter), btrim(p_soil_type),
    p_start_time, p_end_time, p_duration_minutes, p_water_level, p_notes,
    p_photo_paths, COALESCE(p_timestamp_local, now()::text), v_request_payload,
    (v_new_captured IS NOT NULL AND v_last_captured IS NOT NULL AND v_new_captured < v_last_captured)
  ) RETURNING * INTO v_result;

  IF v_project.target_depth IS NOT NULL AND v_project.target_depth > 0 THEN
    v_progress := least(100, round((v_result.depth_end / v_project.target_depth) * 100));
    UPDATE public.projects
    SET progress_percentage = v_progress, updated_at = now()
    WHERE id = p_project_id;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION private.create_drilling_bar_20260712_impl(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.end_shift_core (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.end_shift_core(p_shift_id uuid, p_usage jsonb, p_notes text DEFAULT NULL::text, p_device_ended_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_type text DEFAULT 'manual'::text)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_shift public.shifts;
  v_item jsonb;
  v_usage jsonb := COALESCE(p_usage, '[]'::jsonb);
  v_assignment public.project_materials;
  v_existing public.material_consumption;
  v_quantity real;
  v_client_entry_id text;
  v_anomaly boolean;
  v_end_payload jsonb;
  v_line_payload jsonb;
  v_authoritative_end timestamptz;
  v_device_end_server_time timestamptz;
  v_effective_end_type text;
  v_effective_date date;
  v_note text;
  v_approximate boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_end_type NOT IN ('manual', 'auto') THEN
    RAISE EXCEPTION 'Tipo de cierre de turno inválido' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_usage) <> 'array' THEN
    RAISE EXCEPTION 'El consumo del turno debe enviarse como lista' USING ERRCODE = '22023';
  END IF;
  v_end_payload := jsonb_strip_nulls(jsonb_build_object(
    'usage', v_usage,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'device_ended_at', p_device_ended_at,
    'requested_end_type', p_end_type
  ));

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Turno no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid()
     AND NOT private.is_project_crew_for(auth.uid(), v_shift.project_id) THEN
    RAISE EXCEPTION 'No tenés acceso a este turno' USING ERRCODE = '42501';
  END IF;
  PERFORM private.add_shift_participant(v_shift.id, auth.uid());
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
  IF v_shift.handover_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm the shift handover before closing the shift'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_usage) item
    WHERE public.safe_bigint(item ->> 'project_material_id') IS NULL
       OR public.safe_bigint(item ->> 'project_material_id') <= 0
  ) THEN
    RAISE EXCEPTION 'Cada línea de consumo necesita un material válido del pozo'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_usage) item
    GROUP BY public.safe_bigint(item ->> 'project_material_id')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cada material debe aparecer una sola vez en el informe de turno'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id AND pm.active IS TRUE
      -- Added during the shift: the phone may not know it, so it counts as zero.
      AND pm.created_at <= v_shift.started_at
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_usage) item
        WHERE public.safe_bigint(item ->> 'project_material_id') = pm.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_usage) item
    LEFT JOIN public.project_materials pm
      ON pm.id = public.safe_bigint(item ->> 'project_material_id')
     AND pm.project_id = v_shift.project_id
     -- Removed during the shift: still this well's, so its use is recorded.
     AND (pm.active IS TRUE OR pm.updated_at >= v_shift.started_at)
    WHERE pm.id IS NULL
      -- SRV-18: a zero line for a material removed before the shift is ignored (stale tablet list).
      AND COALESCE(item ->> 'quantity_used', '0') !~ '^-?0+(\.0+)?$'
  ) THEN
    RAISE EXCEPTION 'El informe debe incluir exactamente cada material activo del proyecto'
      USING ERRCODE = '22023';
  END IF;

  -- A shift starts on the server's clock, so its end must be on that clock too, or a
  -- wrong phone clock changes the hours the admin pays. Bars convert the same way.
  v_device_end_server_time := p_device_ended_at
    - COALESCE(v_shift.start_device_time - v_shift.started_at, interval '0');
  v_authoritative_end := now();
  IF v_device_end_server_time IS NOT NULL
     AND v_device_end_server_time >= v_shift.started_at
     AND v_device_end_server_time <= now() + interval '15 minutes' THEN
    v_authoritative_end := least(v_device_end_server_time, now());
  END IF;
  -- A shift the 12-hour sweep marked report_pending keeps its 12-hour end, unless
  -- the operator's own close says it ended earlier: closed offline at hour 8 and
  -- synced at hour 13, it ended at hour 8, not 12, and it isn't a missing report.
  IF v_authoritative_end >= v_shift.started_at + interval '12 hours'
     OR (v_shift.status = 'report_pending'
         AND (p_end_type IS DISTINCT FROM 'manual' OR v_device_end_server_time IS NULL
              OR v_device_end_server_time < v_shift.started_at
              OR v_device_end_server_time > now() + interval '15 minutes')) THEN
    v_authoritative_end := v_shift.started_at + interval '12 hours';
    v_effective_end_type := 'auto';
  ELSE
    v_effective_end_type := p_end_type;
  END IF;
  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Cierre de turno'), true);

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_usage) LOOP
    BEGIN
      v_quantity := COALESCE((v_item ->> 'quantity_used')::real, 0);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'La cantidad usada no es válida' USING ERRCODE = '22023';
    END;
    IF private.is_finite_real(v_quantity) IS NOT TRUE OR v_quantity < 0 OR v_quantity > 1000000 THEN
      RAISE EXCEPTION 'Cada consumo debe estar entre 0 y 1.000.000' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = public.safe_bigint(v_item ->> 'project_material_id')
      AND project_id = v_shift.project_id
      AND (active IS TRUE OR updated_at >= v_shift.started_at)
    FOR UPDATE;
    IF NOT FOUND THEN
      -- SRV-18: a zero line for a material removed before the shift is a no-op, not a failed close.
      IF v_quantity = 0 THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'El material no está asignado a este pozo'
        USING ERRCODE = 'P0002';
    END IF;
    IF v_quantity > 0 THEN
      v_client_entry_id := 'shift-usage:' || p_shift_id::text || ':' || v_assignment.id::text;
      v_effective_date := COALESCE((v_item ->> 'date')::date, (now() AT TIME ZONE 'America/Asuncion')::date);
      v_note := NULLIF(v_item ->> 'notes', '');
      v_approximate := COALESCE((v_item ->> 'approximate')::boolean, false);
      -- Use of a material removed during the shift is kept, and flagged for the admin.
      v_anomaly := v_quantity > COALESCE(v_assignment.current_quantity, 0)
        OR v_assignment.active IS NOT TRUE;
      v_line_payload := jsonb_strip_nulls(jsonb_build_object(
        'project_id', v_shift.project_id,
        'quantity_used', v_quantity,
        'project_material_id', v_assignment.id,
        'material_id', v_assignment.material_id,
        'material_name', v_assignment.material_name,
        'unit', v_assignment.unit,
        'date', v_effective_date,
        'notes', v_note,
        'shift_id', v_shift.id,
        'approximate', v_approximate
      ));

      SELECT * INTO v_existing
      FROM public.material_consumption
      WHERE client_entry_id = v_client_entry_id
      FOR UPDATE;
      IF FOUND THEN
        IF v_existing.operator_id IS DISTINCT FROM v_shift.operator_id
           OR v_existing.project_id IS DISTINCT FROM v_shift.project_id
           OR v_existing.shift_id IS DISTINCT FROM v_shift.id
           OR v_existing.project_material_id IS DISTINCT FROM v_assignment.id
           OR v_existing.quantity_used IS DISTINCT FROM v_quantity
           OR v_existing.date IS DISTINCT FROM v_effective_date
           OR v_existing.notes IS DISTINCT FROM v_note
           OR v_existing.approximate IS DISTINCT FROM v_approximate THEN
          RAISE EXCEPTION 'Shift usage idempotency key payload mismatch'
            USING ERRCODE = '23505';
        END IF;
      ELSE
        INSERT INTO public.material_consumption (
          client_entry_id, project_id, operator_id, shift_id,
          project_material_id, material_id, material_name, quantity_used,
          unit, date, notes, approximate, anomaly_flag, request_payload
        ) VALUES (
          v_client_entry_id, v_shift.project_id, v_shift.operator_id, v_shift.id,
          v_assignment.id, v_assignment.material_id, v_assignment.material_name,
          v_quantity, v_assignment.unit, v_effective_date, v_note,
          v_approximate, v_anomaly, v_line_payload
        );
        UPDATE public.project_materials
        SET current_quantity = COALESCE(current_quantity, 0) - v_quantity,
            updated_at = now()
        WHERE id = v_assignment.id;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.shifts
  SET status = 'closed', ended_at = v_authoritative_end,
      end_device_time = COALESCE(p_device_ended_at, end_device_time),
      end_type = v_effective_end_type, usage_report_submitted = true,
      notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
      device_time_flag = device_time_flag OR (
        v_device_end_server_time IS NOT NULL AND (
          v_device_end_server_time < started_at
          OR v_device_end_server_time > now() + interval '15 minutes'
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
    jsonb_build_object('usage_lines', jsonb_array_length(v_usage))
  );
  RETURN v_shift;
END;
$function$;

REVOKE ALL ON FUNCTION private.end_shift_core(uuid, jsonb, text, timestamp with time zone, text) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.confirm_shift_handover_core (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.confirm_shift_handover_core(p_shift_id uuid, p_items jsonb)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_shift public.shifts;
  v_item jsonb;
  v_items jsonb := COALESCE(p_items, '[]'::jsonb);
  v_payload jsonb;
  v_assignment public.project_materials;
  v_existing public.shift_handovers;
  v_status text;
  v_client_entry_id text;
  v_observed real;
  v_note text;
  v_photo_path text;
  v_was_confirmed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turno no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid()
     AND NOT private.is_project_crew_for(auth.uid(), v_shift.project_id) THEN
    RAISE EXCEPTION 'Solo alguien del equipo de este pozo puede confirmar el traspaso'
      USING ERRCODE = '42501';
  END IF;
  PERFORM private.add_shift_participant(v_shift.id, auth.uid());
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'Los materiales del traspaso deben enviarse como lista' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) item
    WHERE public.safe_bigint(item ->> 'project_material_id') IS NULL
       OR public.safe_bigint(item ->> 'project_material_id') <= 0
  ) THEN
    RAISE EXCEPTION 'Cada material del traspaso necesita un identificador válido del pozo'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) item
    GROUP BY public.safe_bigint(item ->> 'project_material_id')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cada material del traspaso puede aparecer una sola vez'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) item
    LEFT JOIN public.project_materials pm
      ON pm.id = public.safe_bigint(item ->> 'project_material_id')
     AND pm.project_id = v_shift.project_id
     -- Deactivated during the shift: still this well's, so the testimony is kept (D5 rule).
     AND (pm.active IS TRUE OR pm.updated_at >= v_shift.started_at)
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'A handover item is not an active material in this project'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id AND pm.active IS TRUE
      -- Added during the shift: the phone may not know it yet, so it may be missing (D5 rule).
      AND pm.created_at <= v_shift.started_at
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_items) item
        WHERE public.safe_bigint(item ->> 'project_material_id') = pm.id
      )
  ) THEN
    RAISE EXCEPTION 'El traspaso debe incluir cada material activo del pozo'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(
    (value - 'project_material_id') || jsonb_build_object(
      'project_material_id', public.safe_bigint(value ->> 'project_material_id')
    ) ORDER BY public.safe_bigint(value ->> 'project_material_id')
  ), '[]'::jsonb)
  INTO v_payload
  FROM jsonb_array_elements(v_items);

  v_was_confirmed := v_shift.handover_confirmed IS TRUE;
  IF v_was_confirmed AND v_shift.request_payload ? 'handover' THEN
    IF v_shift.request_payload -> 'handover' IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency replay does not match the confirmed handover'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_shift;
  END IF;
  IF NOT v_was_confirmed AND v_shift.status NOT IN ('open', 'report_pending') THEN
    RAISE EXCEPTION 'Solo un turno sin cerrar puede confirmar el traspaso'
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_was_confirmed
     AND NOT public.project_allows_field_work(v_shift.project_id) THEN
    RAISE EXCEPTION 'El pozo no está abierto para trabajo de campo' USING ERRCODE = '55000';
  END IF;

  FOR v_assignment IN
    SELECT * FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id
      AND (pm.active IS TRUE
           OR (pm.updated_at >= v_shift.started_at AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(v_items) named
                 WHERE public.safe_bigint(named ->> 'project_material_id') = pm.id)))
    ORDER BY pm.id
    FOR UPDATE
  LOOP
    v_item := NULL;
    SELECT value INTO v_item
    FROM jsonb_array_elements(v_items)
    WHERE public.safe_bigint(value ->> 'project_material_id') = v_assignment.id
    LIMIT 1;
    -- Added during the shift and not named by the phone: no testimony, so no row (not seen).
    IF v_item IS NULL AND v_assignment.created_at > v_shift.started_at THEN
      CONTINUE;
    END IF;
    v_status := COALESCE(v_item ->> 'status', 'confirmed');
    v_client_entry_id := COALESCE(
      NULLIF(v_item ->> 'client_entry_id', ''),
      'handover:' || p_shift_id::text || ':' || v_assignment.id::text
    );
    IF v_status NOT IN ('confirmed', 'flagged') THEN
      RAISE EXCEPTION 'Estado de traspaso inválido' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_observed := NULLIF(v_item ->> 'observed_quantity', '')::real;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'La cantidad observada en el traspaso no es válida' USING ERRCODE = '22023';
    END;
    IF v_observed IS NOT NULL
       AND (private.is_finite_real(v_observed) IS NOT TRUE OR v_observed < 0) THEN
      RAISE EXCEPTION 'La cantidad observada en el traspaso debe ser un número finito y no negativo'
        USING ERRCODE = '22023';
    END IF;
    IF v_status = 'flagged' AND v_observed IS NULL THEN
      RAISE EXCEPTION 'Un traspaso con diferencia requiere la cantidad observada'
        USING ERRCODE = '22023';
    END IF;
    v_note := NULLIF(v_item ->> 'note', '');
    v_photo_path := NULLIF(v_item ->> 'photo_path', '');
    IF v_status = 'flagged' AND length(btrim(COALESCE(v_note, ''))) < 3 THEN
      RAISE EXCEPTION 'Un traspaso con diferencia requiere una nota que lo explique'
        USING ERRCODE = '22023';
    END IF;
    IF v_photo_path IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.photos ph
      WHERE ph.project_id = v_shift.project_id
        AND ph.shift_id = v_shift.id
        AND ph.storage_path = v_photo_path
        AND private.is_project_team_member_for(ph.uploaded_by, v_shift.project_id)
        AND ph.evidence_kind = 'field'
    ) THEN
      RAISE EXCEPTION 'Falta la foto del traspaso o no corresponde a este turno'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_existing
    FROM public.shift_handovers
    WHERE shift_id = p_shift_id AND project_material_id = v_assignment.id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.client_entry_id IS DISTINCT FROM v_client_entry_id
         OR v_existing.status IS DISTINCT FROM v_status
         OR v_existing.observed_quantity IS DISTINCT FROM v_observed
         OR v_existing.note IS DISTINCT FROM v_note
         OR v_existing.photo_path IS DISTINCT FROM v_photo_path
         OR v_existing.confirmed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Idempotency replay does not match handover testimony'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      IF v_was_confirmed THEN
        RAISE EXCEPTION 'El testimonio del traspaso confirmado está incompleto'
          USING ERRCODE = '23505';
      END IF;
      INSERT INTO public.shift_handovers (
        client_entry_id, shift_id, project_material_id, status,
        expected_quantity, observed_quantity, note, photo_path, confirmed_by
      ) VALUES (
        v_client_entry_id, p_shift_id, v_assignment.id, v_status,
        COALESCE(v_assignment.current_quantity, 0), v_observed,
        v_note, v_photo_path, auth.uid()
      );
    END IF;
  END LOOP;

  UPDATE public.shifts
  SET handover_confirmed = true,
      request_payload = COALESCE(request_payload, '{}'::jsonb)
        || jsonb_build_object('handover', v_payload),
      updated_at = now()
  WHERE id = p_shift_id
  RETURNING * INTO v_shift;

  IF NOT v_was_confirmed THEN
    PERFORM private.write_audit(
      v_shift.project_id, 'shift.handover_confirmed', 'shifts', v_shift.id::text,
      NULL, to_jsonb(v_shift), NULL,
      jsonb_build_object('item_count', jsonb_array_length(v_items))
    );
  END IF;
  RETURN v_shift;
END;
$function$;

REVOKE ALL ON FUNCTION private.confirm_shift_handover_core(uuid, jsonb) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.register_water_sample_core (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.register_water_sample_core(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real DEFAULT NULL::real, p_stage text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_bottle_photo_path text DEFAULT NULL::text, p_sample_number integer DEFAULT NULL::integer, p_timestamp_local timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS water_samples
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.water_samples;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 OR p_taken_at IS NULL THEN
    RAISE EXCEPTION 'Faltan el identificador del registro o la hora de toma' USING ERRCODE = '22023';
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'taken_at', p_taken_at,
    'depth_m', p_depth_m, 'stage', NULLIF(btrim(COALESCE(p_stage, '')), ''),
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'bottle_photo_path', p_bottle_photo_path,
    'sample_number', p_sample_number, 'timestamp_local', p_timestamp_local
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('register_water_sample:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_existing
  FROM public.water_samples
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  RETURN private.register_water_sample_20260712_impl(
    p_project_id, p_client_entry_id, p_taken_at, p_depth_m, p_stage,
    p_notes, p_bottle_photo_path, p_sample_number, p_timestamp_local
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.register_water_sample_core(bigint, text, timestamp with time zone, real, text, text, text, integer, timestamp with time zone) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.start_shift_core (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.start_shift_core(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_device_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.shifts;
  v_started timestamptz;
  v_payload jsonb;
  v_existing_start_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF p_shift_id IS NULL OR length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'shift_id and client_entry_id are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('start_shift:' || p_client_entry_id, 0)
  );

  SELECT * INTO v_existing FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_existing
    FROM public.shifts WHERE client_entry_id = p_client_entry_id FOR UPDATE;
  END IF;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM p_shift_id
       OR v_existing.client_entry_id IS DISTINCT FROM p_client_entry_id
       OR v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id THEN
      RAISE EXCEPTION 'Idempotency key: esa clave de inicio de turno pertenece a otro turno'
        USING ERRCODE = '23505';
    END IF;
    v_started := COALESCE(
      p_started_at,
      NULLIF(v_existing.request_payload ->> 'started_at', '')::timestamptz,
      v_existing.started_at
    );
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'project_id', p_project_id,
      'started_at', v_started,
      'device_started_at', p_device_started_at
    ));
    v_existing_start_payload := jsonb_strip_nulls(jsonb_build_object(
      'project_id', v_existing.request_payload -> 'project_id',
      'started_at', v_existing.request_payload -> 'started_at',
      'device_started_at', v_existing.request_payload -> 'device_started_at'
    ));
    IF v_existing_start_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  RETURN private.start_shift_20260712_impl(
    p_project_id, p_shift_id, p_client_entry_id,
    p_started_at, p_device_started_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.start_shift_core(bigint, uuid, text, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.start_shift_20260712_impl (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.start_shift_20260712_impl(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_device_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.shifts;
  v_result public.shifts;
  v_requested timestamptz := COALESCE(p_started_at, now());
  v_started timestamptz := now();
  v_payload jsonb;
  v_other_operator text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_field_work(p_project_id) THEN
    RAISE EXCEPTION 'Project is not open for a new shift' USING ERRCODE = '55000';
  END IF;
  IF p_shift_id IS NULL OR length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'shift_id and client_entry_id are required' USING ERRCODE = '22023';
  END IF;
  -- The requested time, not the corrected one: a retry sends the same request and
  -- public.start_shift compares it with this.
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id,
    'started_at', v_requested,
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
      RAISE EXCEPTION 'Idempotency key: esa clave de inicio de turno pertenece a otro turno' USING ERRCODE = '23505';
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
    -- Was an inline UPDATE duplicating the 12-hour rule; now the one shared
    -- definition. Scoped to this operator, and shifts_one_unresolved_per_operator
    -- guarantees v_existing is their only unresolved row, so the reap can only
    -- touch the row already locked FOR UPDATE above. Re-read to pick up the
    -- change the function made.
    IF private.reap_expired_shifts(v_existing.operator_id) > 0 THEN
      SELECT * INTO v_existing FROM public.shifts WHERE id = v_existing.id;
    END IF;
    -- SRV-15: an open shift on another well is not this start's shift.
    IF v_existing.project_id IS DISTINCT FROM p_project_id
       AND v_existing.status IN ('open', 'report_pending') THEN
      RAISE EXCEPTION 'Tenés un turno abierto en otro pozo (%). Cerralo antes de iniciar uno aquí.',
        COALESCE((SELECT NULLIF(btrim(pr.name), '') FROM public.projects pr WHERE pr.id = v_existing.project_id), 'sin nombre')
        USING ERRCODE = '55000';
    END IF;
    -- Returning the unresolved shift (instead of raising) commits the
    -- auto-close. The client must inspect status and finish its usage report.
    RETURN v_existing;
  END IF;

  -- One start at a time per well, so a losing start gets the message below rather
  -- than a bare unique violation from shifts_one_unresolved_per_project.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('start_shift:project:' || p_project_id::text, 0)
  );

  -- Shared tablet: the well's open shift, started by its crew, is the equipo's.
  -- A crew member starting while it runs joins it instead of being refused.
  IF public.is_project_crew(p_project_id) THEN
    SELECT s.* INTO v_existing
    FROM public.shifts s
    WHERE s.project_id = p_project_id AND s.status = 'open'
      AND private.is_project_crew_for(s.operator_id, p_project_id)
    ORDER BY s.started_at DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
      PERFORM private.add_shift_participant(v_existing.id, auth.uid());
      RETURN v_existing;
    END IF;
  END IF;

  -- The caller has no unresolved shift here, so this one is someone else's. The
  -- phone shows this text as it is; startShift.ts matches its first words.
  SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), pr.username, 'otro operador')
  INTO v_other_operator
  FROM public.shifts s
  LEFT JOIN public.profiles pr ON pr.id = s.operator_id
  WHERE s.project_id = p_project_id AND s.status IN ('open', 'report_pending')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Todavía no podés iniciar: el turno de % en este pozo sigue sin cerrar. Cuando lo cierre vas a poder iniciar el tuyo. Si no puede cerrarlo, avisale al administrador.', v_other_operator
      USING ERRCODE = '55000';
  END IF;

  -- Only a start queued by an older app can reach back in time like this.
  IF EXISTS (
    SELECT 1 FROM public.shifts prior
    WHERE prior.project_id = p_project_id
      AND COALESCE(prior.ended_at, prior.started_at + interval '12 hours') > v_started
  ) THEN
    RAISE EXCEPTION 'Este inicio de turno se superpone con otro turno del pozo.'
      USING ERRCODE = '55000';
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
    abs(extract(epoch FROM (now() - v_requested))) > 600
      OR (p_device_started_at IS NOT NULL AND abs(extract(epoch FROM (now() - p_device_started_at))) > 600)
      OR EXISTS (
        SELECT 1 FROM public.shifts prior
        WHERE prior.operator_id = auth.uid()
          AND COALESCE(prior.ended_at, prior.started_at + interval '12 hours') > v_started
      ),
    v_payload
  ) RETURNING * INTO v_result;

  PERFORM private.add_shift_participant(v_result.id, v_result.operator_id);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION private.start_shift_20260712_impl(bigint, uuid, text, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.record_material_consumption_core (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.record_material_consumption_core(p_project_id bigint, p_quantity_used real, p_client_entry_id text DEFAULT NULL::text, p_project_material_id bigint DEFAULT NULL::bigint, p_material_id bigint DEFAULT NULL::bigint, p_material_name text DEFAULT NULL::text, p_unit text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid, p_approximate boolean DEFAULT false)
 RETURNS material_consumption
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.material_consumption;
  v_assignment public.project_materials;
  v_payload jsonb;
  v_legacy_payload jsonb;
  v_material_id bigint := p_material_id;
  v_material_name text := p_material_name;
  v_unit text := p_unit;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF p_client_entry_id IS NOT NULL AND length(btrim(p_client_entry_id)) = 0 THEN
    RAISE EXCEPTION 'Falta el identificador del registro' USING ERRCODE = '22023';
  END IF;
  IF p_shift_id IS NOT NULL AND p_client_entry_id IS NULL THEN
    RAISE EXCEPTION 'Un consumo de turno requiere el identificador del registro'
      USING ERRCODE = '22023';
  END IF;
  IF p_project_material_id IS NOT NULL THEN
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = p_project_material_id AND project_id = p_project_id;
    IF FOUND THEN
      v_material_id := v_assignment.material_id;
      v_material_name := v_assignment.material_name;
      v_unit := v_assignment.unit;
    END IF;
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'quantity_used', p_quantity_used,
    'project_material_id', p_project_material_id, 'material_id', v_material_id,
    'material_name', v_material_name, 'unit', v_unit, 'date', p_date,
    'notes', p_notes, 'shift_id', p_shift_id,
    'approximate', COALESCE(p_approximate, false)
  ));
  v_legacy_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'quantity_used', p_quantity_used,
    'project_material_id', p_project_material_id, 'material_id', p_material_id,
    'material_name', p_material_name, 'unit', p_unit, 'date', p_date,
    'notes', p_notes, 'shift_id', p_shift_id,
    'approximate', COALESCE(p_approximate, false)
  ));
  IF p_client_entry_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('record_material_consumption:' || p_client_entry_id, 0)
    );
    SELECT * INTO v_existing
    FROM public.material_consumption
    WHERE client_entry_id = p_client_entry_id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.operator_id IS DISTINCT FROM auth.uid()
         OR v_existing.project_id IS DISTINCT FROM p_project_id
         OR (
           v_existing.request_payload IS DISTINCT FROM v_payload
           AND v_existing.request_payload IS DISTINCT FROM v_legacy_payload
         ) THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  RETURN private.record_material_consumption_20260712_impl(
    p_project_id, p_quantity_used, p_client_entry_id, p_project_material_id,
    v_material_id, v_material_name, v_unit, p_date, p_notes,
    p_shift_id, p_approximate
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.record_material_consumption_core(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- private.create_pedido_v2_20260712_impl (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION private.create_pedido_v2_20260712_impl(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text DEFAULT NULL::text, p_priority text DEFAULT 'Normal'::text, p_needed_by date DEFAULT NULL::date, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  IF NOT public.is_project_crew(p_project_id) AND NOT public.is_admin() THEN
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
    v_quantity := COALESCE(private.pedido_item_real(v_item ->> 'requested_quantity'), 0);
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
      WHERE id = private.pedido_item_bigint(v_item ->> 'catalog_variant_id') AND active IS TRUE;
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
    v_quantity := private.pedido_item_real(v_item ->> 'requested_quantity');
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
$function$;

REVOKE ALL ON FUNCTION private.create_pedido_v2_20260712_impl(bigint, text, jsonb, text, text, text, date, text) FROM PUBLIC, anon, authenticated;


-- ======================================================================
-- public.join_shift (re-created with the low-sweep edits)
CREATE OR REPLACE FUNCTION public.join_shift(p_shift_id uuid, p_entered_by uuid DEFAULT NULL::uuid)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_shift public.shifts;
  v_actor uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turno no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_project_crew(v_shift.project_id) THEN
    RAISE EXCEPTION 'No sos del equipo de este pozo' USING ERRCODE = '42501';
  END IF;
  v_actor := COALESCE(p_entered_by, auth.uid());
  IF v_actor <> auth.uid()
     AND NOT private.is_project_team_member_for(v_actor, v_shift.project_id) THEN
    RAISE EXCEPTION 'Ese operador no es del equipo de este pozo' USING ERRCODE = '42501';
  END IF;
  IF v_shift.status = 'open' THEN
    PERFORM private.add_shift_participant(v_shift.id, v_actor);
  END IF;
  RETURN v_shift;
END;
$function$;

REVOKE ALL ON FUNCTION public.join_shift(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_shift(uuid, uuid) TO authenticated, service_role;


-- ======================================================================
-- public.decide_pedido_item (re-created with the low-sweep edits)
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
  -- SRV-19: a retry of the decision already stored (lost response) returns the item.
  IF v_item.state = p_decision
     AND v_item.layer = p_layer
     AND v_item.decision_reason IS NOT DISTINCT FROM NULLIF(btrim(COALESCE(p_reason, '')), '')
     AND v_item.approved_quantity IS NOT DISTINCT FROM
       (CASE WHEN p_decision = 'aprobado' THEN COALESCE(p_approved_quantity, v_item.requested_quantity) END) THEN
    RETURN v_item;
  END IF;
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

  -- ADM-10: approving an item on a paused, cancelled or closed well leaves it with no receipt.
  IF p_decision = 'aprobado' AND v_pedido.project_id IS NOT NULL
     AND NOT public.project_allows_closure_change(v_pedido.project_id) THEN
    RAISE EXCEPTION 'El pozo de este pedido no está activo: no se puede aprobar el ítem'
      USING ERRCODE = '55000';
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

REVOKE ALL ON FUNCTION public.decide_pedido_item(bigint, text, real, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_pedido_item(bigint, text, real, text, text) TO authenticated, service_role;


NOTIFY pgrst, 'reload schema';
