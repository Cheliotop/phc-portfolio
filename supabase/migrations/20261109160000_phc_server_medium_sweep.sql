-- Medium/Low sweep of docs/audits/2026-11-08-full-audit/SRV.md, server side.
-- Items: SRV-5, SRV-6, SRV-7, SRV-8, SRV-9 (lock order), SRV-10, SRV-11, SRV-12 (D3), SRV-13,
-- SRV-15, SRV-16, SRV-4 (closing operator), and the force-close pay decision.
-- Each function body is the newest definition in the database plus the edits marked in place.


-- ======================================================================
-- Helpers: exception-safe timestamp parse (used for arrived_late)
CREATE OR REPLACE FUNCTION private.try_timestamptz(p_value text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF NULLIF(btrim(COALESCE(p_value, '')), '') IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN btrim(p_value)::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
  RETURN NULL;
END;
$function$;

-- ======================================================================
-- Helpers: hours a shift is paid for (SRV-11). An auto-closed shift counts up to its last recorded activity.
CREATE OR REPLACE FUNCTION private.shift_paid_end(p_shift_id uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone, p_end_type text)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_ended_at IS NULL OR p_end_type IS DISTINCT FROM 'auto' THEN p_ended_at
    ELSE GREATEST(p_started_at, LEAST(p_ended_at, COALESCE((
      SELECT max(a.at) FROM (
        SELECT max(b.created_at) AS at FROM public.drilling_bars b WHERE b.shift_id = p_shift_id
        UNION ALL SELECT max(c.created_at) FROM public.material_consumption c WHERE c.shift_id = p_shift_id
        UNION ALL SELECT max(h.created_at) FROM public.shift_handovers h WHERE h.shift_id = p_shift_id
      ) a
    ), p_started_at)))
  END;
$function$;

-- ======================================================================
-- SRV-13: a bar recorded on the device before the well's previous bar is marked arrived_late
ALTER TABLE public.drilling_bars ADD COLUMN IF NOT EXISTS arrived_late boolean NOT NULL DEFAULT false;

-- ======================================================================
-- SRV-13: create_drilling_bar body (marks late bars; numbering unchanged)
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
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
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
        RAISE EXCEPTION 'timestamp_local must be an ISO timestamp'
          USING ERRCODE = '22023';
      END;
    END IF;
    IF (v_shift.status IN ('report_pending', 'closed')
        OR v_shift.started_at <= now() - interval '12 hours')
       AND v_captured_at IS NULL THEN
      RAISE EXCEPTION 'A delayed/offline bar requires its captured timestamp'
        USING ERRCODE = '22023';
    END IF;
    IF v_shift.status = 'closed' THEN
      -- A force-closed shift has no report and never will, but its bars really happened.
      -- The time window below still sends anything recorded after the close to review.
      IF v_shift.ended_at IS NULL
         OR (v_shift.usage_report_submitted IS NOT TRUE AND v_shift.end_type IS DISTINCT FROM 'admin') THEN
        RAISE EXCEPTION 'A closed shift must have its usage report before offline evidence can replay'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.completion_reports
        WHERE project_id = p_project_id AND format_version >= 2
      ) THEN
        RAISE EXCEPTION 'Offline drilling evidence cannot be added after Ficha submission'
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

-- ======================================================================
-- SRV-13: apply_rejected_work body (accepted late bars are marked too)
CREATE OR REPLACE FUNCTION private.apply_rejected_work(p_report rejected_work_reports)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_payload jsonb := p_report.payload;
  v_project public.projects;
  v_entry text;
  v_last_bar integer;
  v_depth real;
  v_length real;
  v_shift uuid;
  v_photos text;
  v_photo_list jsonb;
  v_number integer;
  v_taken timestamptz;
  v_timestamp_local timestamptz;
  v_photo text;
  v_duration integer;
  v_water_level real;
  v_depth_m real;
  v_last_bar_local text;
  v_last_captured timestamptz;
BEGIN
  IF p_report.entity NOT IN ('drilling_bar', 'water_sample') THEN
    RETURN false;
  END IF;
  IF p_report.project_id IS NULL THEN
    RAISE EXCEPTION 'Este registro no indica un pozo válido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_report.project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Este registro no indica un pozo válido' USING ERRCODE = '22023';
  END IF;
  IF public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'El pozo no está activo, así que no admite registros nuevos' USING ERRCODE = '22023';
  END IF;

  IF p_report.entity = 'drilling_bar' THEN
    v_entry := v_payload ->> 'client_entry_id';
    IF length(btrim(COALESCE(v_entry, ''))) = 0
       OR length(btrim(COALESCE(v_payload ->> 'soil_type', ''))) = 0 THEN
      RAISE EXCEPTION 'No podés aceptar la barra: faltan datos obligatorios' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_length := COALESCE((v_payload ->> 'length')::real, v_project.default_bar_length, 3);
      v_duration := (v_payload ->> 'duration_minutes')::integer;
      v_water_level := (v_payload ->> 'water_level')::real;
      IF NULLIF(btrim(COALESCE(v_payload ->> 'timestamp_local', '')), '') IS NOT NULL THEN
        v_timestamp_local := (v_payload ->> 'timestamp_local')::timestamptz;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
                  OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'No podés aceptar la barra: sus datos no tienen un formato válido'
        USING ERRCODE = '22023';
    END;
    IF v_length <= 0 OR v_length > 50 THEN
      RAISE EXCEPTION 'No podés aceptar la barra: la longitud debe estar entre 0 y 50 m' USING ERRCODE = '22023';
    END IF;
    IF v_duration IS NOT NULL AND (v_duration < 0 OR v_duration > 1440) THEN
      RAISE EXCEPTION 'No podés aceptar la barra: la duración debe estar entre 0 y 1440 minutos' USING ERRCODE = '22023';
    END IF;
    IF v_water_level IS NOT NULL AND v_water_level < 0 THEN
      RAISE EXCEPTION 'No podés aceptar la barra: el nivel de agua no puede ser negativo' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = v_entry) THEN
      RETURN false;
    END IF;

    -- Photos. The phone sends photo_paths as a JSON array, or as text holding one:
    -- uploaded photos as objects carrying their public.photos id, photos that never
    -- uploaded as phone paths (file://, content://). Keep only what provably belongs
    -- to this well: a photo row of this well, or a storage path in its folder.
    -- Everything else is dropped, as before, so a report can't point the bar at
    -- another well's evidence, and a bar whose photos never uploaded can still be
    -- accepted (Sergio's 2026-11-08 decision on bars from a force-closed shift).
    v_photo_list := v_payload -> 'photo_paths';
    IF jsonb_typeof(v_photo_list) = 'string' THEN
      BEGIN
        v_photo_list := (v_photo_list #>> '{}')::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        v_photo_list := jsonb_build_array(v_photo_list #>> '{}');
      END;
    END IF;
    IF jsonb_typeof(v_photo_list) IN ('string', 'object') THEN
      v_photo_list := jsonb_build_array(v_photo_list);
    END IF;
    v_photos := NULL;
    IF jsonb_typeof(v_photo_list) = 'array' THEN
      SELECT jsonb_agg(e.item ORDER BY e.ord)::text INTO v_photos
      FROM jsonb_array_elements(v_photo_list) WITH ORDINALITY AS e(item, ord)
      WHERE (jsonb_typeof(e.item) = 'string'
             AND (e.item #>> '{}') LIKE p_report.project_id::text || '/%'
             AND (e.item #>> '{}') NOT LIKE '%..%')
         OR (jsonb_typeof(e.item) = 'object' AND EXISTS (
               SELECT 1 FROM public.photos ph
               WHERE ph.id = public.safe_bigint(e.item ->> 'id')
                 AND ph.project_id = p_report.project_id));
    END IF;

    SELECT COALESCE(max(bar_number), 0), COALESCE(max(depth_end), 0)
    INTO v_last_bar, v_depth
    FROM public.drilling_bars WHERE project_id = p_report.project_id;
    SELECT db.timestamp_local INTO v_last_bar_local
    FROM public.drilling_bars db
    WHERE db.project_id = p_report.project_id AND db.bar_number = v_last_bar;
    v_last_captured := private.try_timestamptz(v_last_bar_local);

    SELECT id INTO v_shift FROM public.shifts
    WHERE id = public.safe_uuid(v_payload ->> 'shift_id')
      AND project_id = p_report.project_id;

    INSERT INTO public.drilling_bars (
      client_entry_id, project_id, operator_id, shift_id, bar_number,
      depth_start, depth_end, length, diameter, soil_type, start_time, end_time,
      duration_minutes, water_level, notes, photo_paths, timestamp_local,
      request_payload, accepted_review_id, arrived_late
    ) VALUES (
      v_entry, p_report.project_id, p_report.operator_id, v_shift, v_last_bar + 1,
      v_depth, v_depth + v_length, v_length,
      COALESCE(v_payload ->> 'diameter', v_project.default_bar_diameter),
      btrim(v_payload ->> 'soil_type'),
      v_payload ->> 'start_time', v_payload ->> 'end_time',
      v_duration, v_water_level, v_payload ->> 'notes', v_photos,
      v_payload ->> 'timestamp_local', v_payload, p_report.id,
      (v_timestamp_local IS NOT NULL AND v_last_captured IS NOT NULL AND v_timestamp_local < v_last_captured)
    );
    RETURN true;
  END IF;

  v_entry := v_payload ->> 'clientEntryId';
  BEGIN
    v_taken := (v_payload ->> 'takenAt')::timestamptz;
    v_depth_m := (v_payload ->> 'depthM')::real;
    IF v_payload ? 'timestampLocal' AND v_payload -> 'timestampLocal' <> 'null'::jsonb THEN
      v_timestamp_local := (v_payload ->> 'timestampLocal')::timestamptz;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
                OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'No podés aceptar la muestra: sus datos no tienen un formato válido'
      USING ERRCODE = '22023';
  END;
  IF length(btrim(COALESCE(v_entry, ''))) = 0 OR v_taken IS NULL THEN
    RAISE EXCEPTION 'No podés aceptar la muestra: faltan datos obligatorios' USING ERRCODE = '22023';
  END IF;
  IF v_depth_m IS NOT NULL AND v_depth_m < 0 THEN
    RAISE EXCEPTION 'No podés aceptar la muestra: la profundidad no puede ser negativa' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.water_samples WHERE client_entry_id = v_entry) THEN
    RETURN false;
  END IF;

  -- The bottle photo is kept only when it is an uploaded photo of this well
  -- (it uploads before the sample is sent). Otherwise it is dropped, as before.
  -- Who uploaded it doesn't matter: on a shared tablet the reporter may not be
  -- the operator who took it.
  v_photo := v_payload ->> 'bottlePhotoPath';
  IF v_photo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.photos ph
    WHERE ph.project_id = p_report.project_id
      AND ph.storage_path = v_photo
      AND ph.evidence_kind = 'water_sample'
  ) THEN
    v_photo := NULL;
  END IF;

  SELECT COALESCE(max(sample_number), 0) + 1 INTO v_number
  FROM public.water_samples WHERE project_id = p_report.project_id;

  INSERT INTO public.water_samples (
    client_entry_id, project_id, sample_number, depth_m, stage, operator_id,
    notes, bottle_photo_path, taken_at, timestamp_local, device_time_flag,
    request_payload, accepted_review_id
  ) VALUES (
    v_entry, p_report.project_id, v_number, v_depth_m,
    NULLIF(btrim(COALESCE(v_payload ->> 'stage', '')), ''), p_report.operator_id,
    NULLIF(btrim(COALESCE(v_payload ->> 'notes', '')), ''), v_photo, v_taken,
    v_timestamp_local, true, v_payload, p_report.id
  );
  RETURN true;
END;
$function$;

-- ======================================================================
-- SRV-5: submit_completion_v2 impl keeps the operator's override flag
CREATE OR REPLACE FUNCTION private.submit_completion_v2_20260712_impl(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text DEFAULT NULL::text, p_pdf_url text DEFAULT NULL::text)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  IF NOT public.is_closing_operator(p_project_id) AND NOT public.is_project_crew(p_project_id)
     AND NOT public.is_admin() THEN
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

  -- The strict pass already filled specific_flow_rate, so this second pass would mark every
  -- Ficha as overridden. The override and mismatch flags are the caller's, kept by the strict pass.
  v_fields := private.validate_completion_final_fields(p_final_fields) || jsonb_build_object(
    '_specific_flow_overridden', COALESCE(p_final_fields -> '_specific_flow_overridden', 'false'::jsonb),
    '_hydraulic_mismatch', COALESCE(p_final_fields -> '_hydraulic_mismatch', 'false'::jsonb));
  IF p_pdf_url IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'phc-reports'
      AND o.name = p_pdf_url
      AND o.owner_id = auth.uid()::text
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
$function$;

-- ======================================================================
-- SRV-5 + SRV-7: resubmit_completion_v2 impl (override flags; locks the well for review)
CREATE OR REPLACE FUNCTION private.resubmit_completion_v2_20260712_impl(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text DEFAULT NULL::text, p_pdf_url text DEFAULT NULL::text)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     AND NOT public.is_project_crew(v_report.project_id) THEN
    RAISE EXCEPTION 'Only the responsible closing operator may resubmit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_closure_change(v_report.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite reenvío de Ficha' USING ERRCODE = '22023';
  END IF;
  -- Same as submit: keep the caller's override and mismatch flags from the strict pass.
  v_fields := private.validate_completion_final_fields(p_final_fields) || jsonb_build_object(
    '_specific_flow_overridden', COALESCE(p_final_fields -> '_specific_flow_overridden', 'false'::jsonb),
    '_hydraulic_mismatch', COALESCE(p_final_fields -> '_hydraulic_mismatch', 'false'::jsonb));
  IF p_pdf_url IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'phc-reports'
      AND o.name = p_pdf_url
      AND o.owner_id = auth.uid()::text
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
      USING ERRCODE = '22023';
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
  -- SRV-7: a Ficha that comes back in on a reactivated well locks the well for review again.
  IF public.project_status_key((SELECT p.status FROM public.projects p WHERE p.id = v_report.project_id)) = 'active' THEN
    PERFORM set_config('phc.project_closure_submit', 'on', true);
    UPDATE public.projects SET status = 'closure_submitted', updated_at = now()
    WHERE id = v_report.project_id;
  END IF;
  PERFORM private.write_audit(
    v_report.project_id, 'ficha.resubmitted', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), NULL,
    jsonb_build_object('resubmission_id', p_client_entry_id)
  );
  RETURN v_report;
END;
$function$;

-- ======================================================================
-- SRV-7: protect_project_lifecycle_transition (no cancel or reactivation under a submitted Ficha)
CREATE OR REPLACE FUNCTION private.protect_project_lifecycle_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  -- SRV-7: a submitted Ficha must be returned first. Otherwise a cancel and a reactivation
  -- leave it signable while field work resumes.
  IF v_old = 'closure_submitted' AND v_new IN ('active', 'cancelled') AND EXISTS (
    SELECT 1 FROM public.completion_reports r
    WHERE r.project_id = NEW.id AND r.format_version >= 2 AND r.status = 'submitted'
  ) THEN
    RAISE EXCEPTION 'Devolvé la Ficha antes de cambiar el estado de un proyecto en cierre'
      USING ERRCODE = '55000';
  END IF;
  IF v_old = 'closure_submitted' AND v_new NOT IN ('completed', 'active', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid transition from closure_submitted to %', v_new
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

-- ======================================================================
-- SRV-7 + SRV-16: sign_completion_report impl (signs only a closure_submitted well; Asunción date)
CREATE OR REPLACE FUNCTION private.sign_completion_report_20260712_impl(p_report_id bigint, p_admin_signature text, p_complete_project boolean DEFAULT true, p_acknowledge_open_pedidos boolean DEFAULT false)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF public.project_status_key((SELECT p.status FROM public.projects p WHERE p.id = v_report.project_id)) IS DISTINCT FROM 'closure_submitted' THEN
      RAISE EXCEPTION 'El proyecto no está en un estado de cierre válido'
        USING ERRCODE = '22023';
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
        USING ERRCODE = '22023';
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
    SET status = 'completed', updated_at = now(), end_date = COALESCE(end_date, (now() AT TIME ZONE 'America/Asuncion')::date)
    WHERE id = v_report.project_id;
  END IF;

  PERFORM private.write_audit(
    v_report.project_id, 'ficha.signed', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), NULL,
    jsonb_build_object('open_pedidos_warning_count', v_open_pedidos)
  );
  RETURN v_report;
END;
$function$;

-- ======================================================================
-- SRV-16: end_shift_core (default usage date in Asunción)
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
    RAISE EXCEPTION 'Invalid shift end type' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_usage) <> 'array' THEN
    RAISE EXCEPTION 'usage must be an array' USING ERRCODE = '22023';
  END IF;
  v_end_payload := jsonb_strip_nulls(jsonb_build_object(
    'usage', v_usage,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'device_ended_at', p_device_ended_at,
    'requested_end_type', p_end_type
  ));

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002'; END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid()
     AND NOT private.is_project_crew_for(auth.uid(), v_shift.project_id) THEN
    RAISE EXCEPTION 'Access denied to this shift' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'Each usage line needs a valid project_material_id'
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
      RAISE EXCEPTION 'Usage quantity is invalid' USING ERRCODE = '22023';
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
      RAISE EXCEPTION 'Assigned material not found in shift project'
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

-- ======================================================================
-- SRV-16: record_material_consumption impl (default date in Asunción)
CREATE OR REPLACE FUNCTION private.record_material_consumption_20260712_impl(p_project_id bigint, p_quantity_used real, p_client_entry_id text DEFAULT NULL::text, p_project_material_id bigint DEFAULT NULL::bigint, p_material_id bigint DEFAULT NULL::bigint, p_material_name text DEFAULT NULL::text, p_unit text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid, p_approximate boolean DEFAULT false)
 RETURNS material_consumption
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND OR public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'Project is not open for consumption' USING ERRCODE = '55000';
  END IF;
  IF p_quantity_used IS NULL OR p_quantity_used <= 0 OR p_quantity_used > 1000000 THEN
    RAISE EXCEPTION 'La cantidad consumida debe estar entre 0 y 1.000.000' USING ERRCODE = '22023';
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
        AND (operator_id = auth.uid() OR private.is_project_crew_for(auth.uid(), p_project_id))
        AND status IN ('open', 'report_pending')
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
    p_quantity_used, COALESCE(p_unit, v_assignment.unit), COALESCE(p_date, (now() AT TIME ZONE 'America/Asuncion')::date),
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
$function$;

-- ======================================================================
-- SRV-6: confirm_shift_handover_core (materials added or removed during the shift)
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
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid()
     AND NOT private.is_project_crew_for(auth.uid(), v_shift.project_id) THEN
    RAISE EXCEPTION 'Only the operator can confirm this shift handover'
      USING ERRCODE = '42501';
  END IF;
  PERFORM private.add_shift_participant(v_shift.id, auth.uid());
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'items must be an array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) item
    WHERE public.safe_bigint(item ->> 'project_material_id') IS NULL
       OR public.safe_bigint(item ->> 'project_material_id') <= 0
  ) THEN
    RAISE EXCEPTION 'Each handover item needs a valid project_material_id'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) item
    GROUP BY public.safe_bigint(item ->> 'project_material_id')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Each handover material may appear only once'
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
    RAISE EXCEPTION 'The handover must explicitly include every active project material'
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
    RAISE EXCEPTION 'Only an unresolved shift can confirm a handover'
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_was_confirmed
     AND NOT public.project_allows_field_work(v_shift.project_id) THEN
    RAISE EXCEPTION 'Project is not open for field work' USING ERRCODE = '55000';
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
      RAISE EXCEPTION 'Invalid handover status' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_observed := NULLIF(v_item ->> 'observed_quantity', '')::real;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Observed handover quantity is invalid' USING ERRCODE = '22023';
    END;
    IF v_observed IS NOT NULL
       AND (private.is_finite_real(v_observed) IS NOT TRUE OR v_observed < 0) THEN
      RAISE EXCEPTION 'Observed handover quantity must be finite and nonnegative'
        USING ERRCODE = '22023';
    END IF;
    IF v_status = 'flagged' AND v_observed IS NULL THEN
      RAISE EXCEPTION 'A flagged handover requires the observed quantity'
        USING ERRCODE = '22023';
    END IF;
    v_note := NULLIF(v_item ->> 'note', '');
    v_photo_path := NULLIF(v_item ->> 'photo_path', '');
    IF v_status = 'flagged' AND length(btrim(COALESCE(v_note, ''))) < 3 THEN
      RAISE EXCEPTION 'A flagged handover requires an explanatory note'
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
      RAISE EXCEPTION 'Handover photo is missing or outside this shift'
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
        RAISE EXCEPTION 'Confirmed handover testimony is incomplete'
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

-- ======================================================================
-- SRV-9: confirm_pedido_item_receipt impl takes the pedido lock first, and a receipt the crew
-- confirmed before the tablet learned of a manual close still lands and books its stock.
CREATE OR REPLACE FUNCTION private.confirm_pedido_item_receipt_20260712_impl(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real DEFAULT 0, p_incident_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_pedido_id bigint;
  v_after_manual_close boolean := false;
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

  -- Lock order as in close_pedido_manually and reject: the pedido first, then its items.
  SELECT pi.pedido_id INTO v_pedido_id FROM public.pedido_items pi WHERE pi.id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = v_pedido_id FOR UPDATE;
  SELECT * INTO v_item FROM public.pedido_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_pedido.operator_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND NOT (public.is_project_crew(v_pedido.project_id) AND v_pedido.kind = 'empresa') THEN
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

  -- SRV-9: the manual close turned this awaited item into no_recibido (same closed_at as the
  -- pedido), not the crew. A receipt arriving now was confirmed on the tablet before it saw the
  -- close (a closed item is no longer offered), so the material is on site: book it.
  v_after_manual_close := v_item.state = 'no_recibido'
    AND v_pedido.closed_manually IS TRUE
    AND v_item.closed_at IS NOT DISTINCT FROM v_pedido.closed_at;
  IF v_item.state NOT IN ('aprobado', 'parcial') AND NOT v_after_manual_close THEN
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
    -- After a manual close nothing more is awaited, so the item stays closed and the pedido
    -- stays Cerrado: recibido when this completes it, otherwise still no_recibido.
    WHEN v_after_manual_close AND v_new_received = v_item.approved_quantity THEN 'recibido'
    WHEN v_after_manual_close THEN 'no_recibido'
    WHEN p_outcome = 'no_recibido' THEN 'no_recibido'
    WHEN v_new_received = v_item.approved_quantity THEN 'recibido'
    ELSE 'parcial'
  END;
  UPDATE public.pedido_items
  SET received_quantity = v_new_received,
      state = v_new_state,
      incident_note = NULLIF(concat_ws(' · ', incident_note,
        CASE WHEN v_after_manual_close THEN 'Recepción confirmada en el equipo antes del cierre manual' END,
        NULLIF(btrim(COALESCE(p_incident_note, '')), '')), ''),
      closed_at = CASE
        WHEN v_after_manual_close THEN v_item.closed_at
        WHEN v_new_state IN ('recibido', 'no_recibido') THEN now()
        ELSE NULL
      END,
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
$function$;

-- ======================================================================
-- SRV-12 (D3) + SRV-15: start_shift impl (server clock; the other well's open shift is refused)
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

-- ======================================================================
-- SRV-10: idempotency for assign_catalog_material_to_project
CREATE TABLE IF NOT EXISTS private.catalog_assignment_attempts (
  client_entry_id text PRIMARY KEY,
  project_material_id bigint NOT NULL REFERENCES public.project_materials(id) ON DELETE RESTRICT,
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE private.catalog_assignment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.catalog_assignment_attempts FROM PUBLIC, anon, authenticated;

-- ======================================================================
-- SRV-10: assign_catalog_material_to_project gets an optional p_client_entry_id (drops the old 5-argument overload)
DROP FUNCTION public.assign_catalog_material_to_project(bigint, bigint, real, text, text);
CREATE FUNCTION public.assign_catalog_material_to_project(p_project_id bigint, p_catalog_variant_id bigint, p_quantity real, p_layer text DEFAULT 'extras'::text, p_notes text DEFAULT NULL::text, p_client_entry_id text DEFAULT NULL::text)
 RETURNS project_materials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_variant public.catalog_variants;
  v_material public.catalog_materials;
  v_existing public.project_materials;
  v_result public.project_materials;
  v_snapshot text;
  v_attempt private.catalog_assignment_attempts;
  v_payload jsonb;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  v_payload := jsonb_build_object(
    'project_id', p_project_id, 'catalog_variant_id', p_catalog_variant_id,
    'quantity', p_quantity, 'layer', p_layer, 'notes', p_notes);
  -- A retry with the same key returns the first result instead of adding the quantity again.
  IF NULLIF(btrim(COALESCE(p_client_entry_id, '')), '') IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('assign-catalog-material:' || p_client_entry_id, 0));
    SELECT * INTO v_attempt FROM private.catalog_assignment_attempts
    WHERE client_entry_id = p_client_entry_id;
    IF FOUND THEN
      IF v_attempt.project_id IS DISTINCT FROM p_project_id
         OR v_attempt.actor_id IS DISTINCT FROM auth.uid()
         OR v_attempt.request_payload IS DISTINCT FROM v_payload THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      SELECT * INTO v_result FROM public.project_materials WHERE id = v_attempt.project_material_id;
      RETURN v_result;
    END IF;
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

  IF NULLIF(btrim(COALESCE(p_client_entry_id, '')), '') IS NOT NULL THEN
    INSERT INTO private.catalog_assignment_attempts (
      client_entry_id, project_material_id, project_id, actor_id, request_payload)
    VALUES (p_client_entry_id, v_result.id, p_project_id, auth.uid(), v_payload);
  END IF;
  RETURN v_result;
END;
$function$;

-- ======================================================================
-- Pay decision: force_close_shift may take the real end time (default: now, capped at 12 hours after the start)
DROP FUNCTION public.force_close_shift(p_shift_id uuid, p_reason text);
CREATE FUNCTION public.force_close_shift(p_shift_id uuid, p_reason text, p_ended_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_shift public.shifts;
  v_before jsonb;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ended timestamptz;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(COALESCE(v_reason, '')) < 3 THEN
    RAISE EXCEPTION 'Indicá el motivo del cierre' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turno no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.status = 'closed' THEN
    RAISE EXCEPTION 'Este turno ya está cerrado' USING ERRCODE = '22023';
  END IF;

  IF p_ended_at IS NULL THEN
    v_ended := COALESCE(v_shift.ended_at,
      GREATEST(v_shift.started_at, LEAST(now(), v_shift.started_at + interval '12 hours')));
  ELSE
    IF p_ended_at <= v_shift.started_at THEN
      RAISE EXCEPTION 'La hora de cierre debe ser posterior al inicio del turno' USING ERRCODE = '22023';
    END IF;
    IF p_ended_at > now() THEN
      RAISE EXCEPTION 'La hora de cierre no puede estar en el futuro' USING ERRCODE = '22023';
    END IF;
    IF p_ended_at > v_shift.started_at + interval '12 hours' THEN
      RAISE EXCEPTION 'Un turno no puede durar más de 12 horas' USING ERRCODE = '22023';
    END IF;
    v_ended := p_ended_at;
  END IF;
  v_before := to_jsonb(v_shift);

  PERFORM set_config('phc.audit_reason', v_reason, true);
  UPDATE public.shifts
  SET status = 'closed',
      ended_at = v_ended,
      end_type = 'admin',
      notes = v_reason,
      updated_at = now()
  WHERE id = p_shift_id
  RETURNING * INTO v_shift;

  PERFORM private.write_audit(
    v_shift.project_id, 'shift.force_closed', 'shifts', v_shift.id::text,
    v_before, to_jsonb(v_shift), v_reason,
    jsonb_build_object('operator_id', v_shift.operator_id)
  );
  RETURN v_shift;
END;
$function$;

-- ======================================================================
-- SRV-11: get_operator_accountability_metrics (auto-closed shifts pay to their last activity; abandoned_shifts)
CREATE OR REPLACE FUNCTION public.get_operator_accountability_metrics(p_operator_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_operator_id uuid := COALESCE(p_operator_id, auth.uid());
  v_last_activity timestamptz;
  v_from timestamptz := CASE WHEN p_from IS NULL THEN '-infinity'::timestamptz
                             ELSE (p_from::timestamp AT TIME ZONE 'America/Asuncion') END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN 'infinity'::timestamptz
                           ELSE ((p_to + 1)::timestamp AT TIME ZONE 'America/Asuncion') END;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF v_operator_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to operator metrics' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_to < p_from THEN
    RAISE EXCEPTION 'El período termina antes de empezar' USING ERRCODE = '22023';
  END IF;
  SELECT max(activity_at) INTO v_last_activity FROM (
    SELECT max(created_at) activity_at FROM public.drilling_bars WHERE operator_id = v_operator_id
    UNION ALL SELECT max(created_at) FROM public.material_consumption WHERE operator_id = v_operator_id
    UNION ALL SELECT max(created_at) FROM public.pedidos WHERE operator_id = v_operator_id
    UNION ALL SELECT max(s.updated_at) FROM public.shifts s
              JOIN public.shift_participants sp ON sp.shift_id = s.id
              WHERE sp.operator_id = v_operator_id
  ) a;

  RETURN jsonb_build_object(
    'operator_id', v_operator_id,
    'period_from', p_from,
    'period_to', p_to,
    'current_project', (SELECT to_jsonb(p) FROM public.projects p
                        WHERE (p.assigned_operator_id = v_operator_id
                               OR EXISTS (SELECT 1 FROM public.project_secondary_operators so
                                          WHERE so.project_id = p.id AND so.operator_id = v_operator_id))
                          AND public.project_status_key(p.status) IN ('planning', 'active', 'closure_submitted')
                        ORDER BY p.updated_at DESC LIMIT 1),
    'current_shift', (SELECT to_jsonb(s) FROM public.shifts s
                      JOIN public.shift_participants sp ON sp.shift_id = s.id
                      WHERE sp.operator_id = v_operator_id AND s.status IN ('open', 'report_pending')
                      ORDER BY s.started_at DESC LIMIT 1),
    'shifts_completed', (SELECT count(*) FROM public.shifts s
                         JOIN public.shift_participants sp ON sp.shift_id = s.id
                         WHERE sp.operator_id = v_operator_id AND s.status = 'closed'
                           AND s.started_at >= v_from AND s.started_at < v_to),
    'hours_worked', (
      SELECT COALESCE(round((sum(extract(epoch FROM (island.ended_at - island.started_at))) / 3600)::numeric, 2), 0)
      FROM (
        SELECT min(marked.started_at) AS started_at, max(marked.ended_at) AS ended_at
        FROM (
          SELECT ordered.started_at, ordered.ended_at,
                 sum(ordered.starts_island) OVER (ORDER BY ordered.started_at, ordered.ended_at) AS island_id
          FROM (
            SELECT s.started_at, pe.paid_end AS ended_at,
                   CASE WHEN s.started_at < max(pe.paid_end) OVER (
                          ORDER BY s.started_at, pe.paid_end
                          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                        THEN 0 ELSE 1 END AS starts_island
            FROM public.shifts s
            JOIN public.shift_participants sp ON sp.shift_id = s.id
            CROSS JOIN LATERAL (SELECT private.shift_paid_end(s.id, s.started_at, s.ended_at, s.end_type) AS paid_end) pe
            WHERE sp.operator_id = v_operator_id AND s.ended_at IS NOT NULL
              AND s.started_at >= v_from AND s.started_at < v_to
          ) ordered
        ) marked
        GROUP BY marked.island_id
      ) island
    ),
    'flagged_shifts', (SELECT count(*) FROM public.shifts s
                       JOIN public.shift_participants sp ON sp.shift_id = s.id
                       WHERE sp.operator_id = v_operator_id AND s.device_time_flag IS TRUE
                         AND s.started_at >= v_from AND s.started_at < v_to),
    'abandoned_shifts', (SELECT count(*) FROM public.shifts s
                         JOIN public.shift_participants sp ON sp.shift_id = s.id
                         WHERE sp.operator_id = v_operator_id AND s.end_type = 'auto'
                           AND s.started_at >= v_from AND s.started_at < v_to),
    'bars_registered', (SELECT count(*) FROM public.drilling_bars b
                        WHERE b.operator_id = v_operator_id
                          AND b.created_at >= v_from AND b.created_at < v_to),
    'average_bar_minutes', (SELECT COALESCE(round(avg(b.duration_minutes)::numeric, 1), 0)
                            FROM public.drilling_bars b
                            WHERE b.operator_id = v_operator_id AND b.duration_minutes IS NOT NULL
                              AND b.created_at >= v_from AND b.created_at < v_to),
    'material_reports_submitted', (SELECT count(*) FROM public.shifts s
                                   JOIN public.shift_participants sp ON sp.shift_id = s.id
                                   WHERE sp.operator_id = v_operator_id AND s.usage_report_submitted IS TRUE
                                     AND s.started_at >= v_from AND s.started_at < v_to),
    'missing_or_late_reports', (SELECT count(*) FROM public.shifts s
                                JOIN public.shift_participants sp ON sp.shift_id = s.id
                                WHERE sp.operator_id = v_operator_id
                                  AND s.started_at >= v_from AND s.started_at < v_to
                                  AND (s.status = 'report_pending' OR s.end_type IN ('auto', 'admin')
                                       OR (s.status = 'open' AND s.started_at <= now() - interval '12 hours'))),
    'active_pedidos', (SELECT count(*) FROM public.pedidos p
                       WHERE p.operator_id = v_operator_id AND p.status NOT IN ('Cerrado', 'Rechazado')),
    'last_activity', v_last_activity,
    'account_active', (SELECT is_active FROM public.profiles WHERE id = v_operator_id)
  );
END;
$function$;

-- ======================================================================
-- SRV-8: mark_rejected_work_sent (the operator whose work it is can mark it too)
CREATE OR REPLACE FUNCTION public.mark_rejected_work_sent(p_client_entry_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.rejected_work_reports
  SET sent_later_at = COALESCE(sent_later_at, now())
  WHERE client_entry_id = p_client_entry_id
    AND (reported_by = v_uid OR operator_id = v_uid)
    AND status = 'pending';

  -- True when the entry is known, whatever its state, so the phone stops
  -- retrying; an entry the admin already decided needs nothing more.
  RETURN EXISTS (
    SELECT 1 FROM public.rejected_work_reports
    WHERE client_entry_id = p_client_entry_id AND (reported_by = v_uid OR operator_id = v_uid)
  );
END;
$function$;

-- ======================================================================
-- SRV-4: set_project_closing_operator (also while a returned Ficha is pending)
CREATE OR REPLACE FUNCTION public.set_project_closing_operator(p_project_id bigint, p_operator_id uuid)
 RETURNS project_closing_assignments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- SRV-4: while the Ficha is back with the operator, the admin can hand it to someone else.
  IF public.project_status_key(v_project.status) NOT IN ('planning', 'active')
     AND NOT (public.project_status_key(v_project.status) = 'closure_submitted' AND EXISTS (
       SELECT 1 FROM public.completion_reports r
       WHERE r.project_id = p_project_id AND r.format_version >= 2 AND r.status = 'returned')) THEN
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
$function$;

-- Grants: every re-created function (REVOKE first, then GRANT to clients).
REVOKE ALL ON FUNCTION private.try_timestamptz(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.shift_paid_end(uuid, timestamp with time zone, timestamp with time zone, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.create_drilling_bar_20260712_impl(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.apply_rejected_work(rejected_work_reports) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.submit_completion_v2_20260712_impl(bigint, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.resubmit_completion_v2_20260712_impl(bigint, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_project_lifecycle_transition() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sign_completion_report_20260712_impl(bigint, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.end_shift_core(uuid, jsonb, text, timestamp with time zone, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_material_consumption_20260712_impl(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.confirm_shift_handover_core(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.confirm_pedido_item_receipt_20260712_impl(bigint, text, text, real, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.start_shift_20260712_impl(bigint, uuid, text, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_catalog_material_to_project(p_project_id bigint, p_catalog_variant_id bigint, p_quantity real, p_layer text, p_notes text, p_client_entry_id text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_catalog_material_to_project(p_project_id bigint, p_catalog_variant_id bigint, p_quantity real, p_layer text, p_notes text, p_client_entry_id text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.force_close_shift(p_shift_id uuid, p_reason text, p_ended_at timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.force_close_shift(p_shift_id uuid, p_reason text, p_ended_at timestamp with time zone) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_operator_accountability_metrics(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_accountability_metrics(uuid, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_rejected_work_sent(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_rejected_work_sent(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_project_closing_operator(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_project_closing_operator(bigint, uuid) TO authenticated, service_role;

REVOKE ALL ON private.catalog_assignment_attempts FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
