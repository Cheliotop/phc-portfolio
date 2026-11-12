-- SEC-1 (full audit 2026-11-08): any signed-in account, even a deactivated one,
-- could file a "refused work" report for any well under any operator's name, and
-- accepting it put the bar in the well without create_drilling_bar's checks.
--
-- Now, when the payload names a well, both the reporter and the operator it
-- claims must be on that well's team: its operator, a secondary operator, or
-- someone with a shift there (a removed operator's old work must still reach
-- review). A deactivated operator may still report their own well's work, as B1
-- decided; the audit's fix allowed keeping that. Accepting a bar or sample checks its values
-- (length, duration, water level, depth, dates) and leaves the report pending
-- when they are wrong. Photos that don't provably belong to the well are dropped.

CREATE OR REPLACE FUNCTION private.is_project_team_member_for(
  p_user_id uuid,
  p_project_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p_user_id IS NOT NULL
     AND p_project_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.projects p
         WHERE p.id = p_project_id AND p.assigned_operator_id = p_user_id
       )
       OR EXISTS (
         SELECT 1 FROM public.project_secondary_operators s
         WHERE s.project_id = p_project_id AND s.operator_id = p_user_id
       )
       OR EXISTS (
         SELECT 1 FROM public.shifts s
         WHERE s.project_id = p_project_id AND s.operator_id = p_user_id
       )
     );
$function$;
REVOKE ALL ON FUNCTION private.is_project_team_member_for(uuid, bigint)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.report_rejected_work(
  p_client_entry_id text,
  p_operator_id uuid,
  p_entity text,
  p_entity_id text,
  p_op text,
  p_payload jsonb,
  p_rejection_reason text DEFAULT NULL,
  p_rejected_at timestamptz DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_operator uuid;
  v_project bigint;
  v_project_value text;
  v_id bigint;
BEGIN
  -- A deactivated operator may still report: work recorded before the
  -- deactivation must reach the admin, not die on the phone (B1). The crew check
  -- below keeps that to wells the operator actually worked on.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No podés reportar trabajo de este pozo'
      USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(p_client_entry_id) > 200
     OR length(btrim(COALESCE(p_entity, ''))) = 0
     OR length(p_entity) > 60
     OR p_payload IS NULL
     OR pg_column_size(p_payload) > 262144 THEN
    RAISE EXCEPTION 'Invalid rejected work report' USING ERRCODE = '22023';
  END IF;

  -- A retry of a report already filed gets the same id back, as before, even if
  -- the reporter's crew changed since (the phone may not have seen the reply).
  SELECT id INTO v_id FROM public.rejected_work_reports
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    RETURN v_id;
  END IF;

  SELECT id INTO v_operator FROM public.profiles WHERE id = p_operator_id;
  v_operator := COALESCE(v_operator, v_uid);

  v_project_value := COALESCE(p_payload ->> 'project_id', p_payload ->> 'projectId');
  IF v_project_value IS NOT NULL THEN
    v_project := public.safe_bigint(v_project_value);
    IF v_project IS NULL
       OR NOT private.is_project_team_member_for(v_uid, v_project)
       OR NOT private.is_project_team_member_for(v_operator, v_project) THEN
      RAISE EXCEPTION 'No podés reportar trabajo de este pozo'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT p.id INTO v_project FROM public.projects p
    WHERE p.id = public.safe_bigint(v_project_value);
  END IF;

  INSERT INTO public.rejected_work_reports (
    client_entry_id, operator_id, reported_by, project_id, entity, entity_id,
    op, payload, rejection_reason, rejected_at
  ) VALUES (
    p_client_entry_id, v_operator, v_uid, v_project, p_entity, p_entity_id,
    p_op, p_payload, left(p_rejection_reason, 2000), p_rejected_at
  )
  ON CONFLICT (client_entry_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.rejected_work_reports
    WHERE client_entry_id = p_client_entry_id;
  END IF;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.report_rejected_work(text, uuid, text, text, text, jsonb, text, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_rejected_work(text, uuid, text, text, text, jsonb, text, timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.apply_rejected_work(p_report public.rejected_work_reports)
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

    SELECT id INTO v_shift FROM public.shifts
    WHERE id = public.safe_uuid(v_payload ->> 'shift_id')
      AND project_id = p_report.project_id;

    INSERT INTO public.drilling_bars (
      client_entry_id, project_id, operator_id, shift_id, bar_number,
      depth_start, depth_end, length, diameter, soil_type, start_time, end_time,
      duration_minutes, water_level, notes, photo_paths, timestamp_local,
      request_payload, accepted_review_id
    ) VALUES (
      v_entry, p_report.project_id, p_report.operator_id, v_shift, v_last_bar + 1,
      v_depth, v_depth + v_length, v_length,
      COALESCE(v_payload ->> 'diameter', v_project.default_bar_diameter),
      btrim(v_payload ->> 'soil_type'),
      v_payload ->> 'start_time', v_payload ->> 'end_time',
      v_duration, v_water_level, v_payload ->> 'notes', v_photos,
      v_payload ->> 'timestamp_local', v_payload, p_report.id
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
REVOKE ALL ON FUNCTION private.apply_rejected_work(public.rejected_work_reports)
  FROM PUBLIC, anon, authenticated;
