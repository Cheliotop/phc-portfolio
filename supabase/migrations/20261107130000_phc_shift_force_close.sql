-- H4: an admin can force-close a shift its operator can't close. Decision:
-- docs/audits/PHC_HANDOFF_AUDIT_2026-11-05.md. Since 20261106120000 such a shift blocks
-- the whole well, including one auto-closed at 12 hours whose report was never filed,
-- so this has to ship with that migration.
--
-- The end time is now, capped at the 12-hour limit, and a shift that was already
-- auto-closed keeps its end. Closed shifts are immutable, so the operator can't file a
-- report afterwards: a close the phone had queued is refused and reaches the admin
-- through the review list, with its usage figures. Bars recorded before the close are
-- still accepted. It counts as a missing report for the operator.

ALTER TABLE public.shifts DROP CONSTRAINT shifts_end_type_check;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_end_type_check
  CHECK (end_type IS NULL OR end_type = ANY (ARRAY['manual'::text, 'auto'::text, 'admin'::text]));

CREATE FUNCTION public.force_close_shift(p_shift_id uuid, p_reason text)
  RETURNS public.shifts
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
DECLARE
  v_shift public.shifts;
  v_before jsonb;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
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
  v_before := to_jsonb(v_shift);

  PERFORM set_config('phc.audit_reason', v_reason, true);
  UPDATE public.shifts
  SET status = 'closed',
      ended_at = COALESCE(ended_at,
        GREATEST(started_at, LEAST(now(), started_at + interval '12 hours'))),
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
REVOKE ALL ON FUNCTION public.force_close_shift(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.force_close_shift(uuid, text) TO authenticated, service_role;

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
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
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
      AND operator_id = auth.uid()
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
$function$;

CREATE OR REPLACE FUNCTION public.get_operator_accountability_metrics(p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'hours_worked', (
      SELECT COALESCE(round((sum(extract(epoch FROM (island.ended_at - island.started_at))) / 3600)::numeric, 2), 0)
      FROM (
        SELECT min(marked.started_at) AS started_at, max(marked.ended_at) AS ended_at
        FROM (
          SELECT ordered.started_at, ordered.ended_at,
                 sum(ordered.starts_island) OVER (ORDER BY ordered.started_at, ordered.ended_at) AS island_id
          FROM (
            SELECT s.started_at, s.ended_at,
                   CASE WHEN s.started_at < max(s.ended_at) OVER (
                          ORDER BY s.started_at, s.ended_at
                          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                        THEN 0 ELSE 1 END AS starts_island
            FROM public.shifts s
            WHERE s.operator_id = v_operator_id AND s.ended_at IS NOT NULL
          ) ordered
        ) marked
        GROUP BY marked.island_id
      ) island
    ),
    'flagged_shifts', (SELECT count(*) FROM public.shifts s
                       WHERE s.operator_id = v_operator_id AND s.device_time_flag IS TRUE),
    'bars_registered', (SELECT count(*) FROM public.drilling_bars b WHERE b.operator_id = v_operator_id),
    'average_bar_minutes', (SELECT COALESCE(round(avg(b.duration_minutes)::numeric, 1), 0)
                            FROM public.drilling_bars b WHERE b.operator_id = v_operator_id AND b.duration_minutes IS NOT NULL),
    'material_reports_submitted', (SELECT count(*) FROM public.shifts s
                                   WHERE s.operator_id = v_operator_id AND s.usage_report_submitted IS TRUE),
    'missing_or_late_reports', (SELECT count(*) FROM public.shifts s
                                WHERE s.operator_id = v_operator_id
                                  AND (s.status = 'report_pending' OR s.end_type IN ('auto', 'admin')
                                       OR (s.status = 'open' AND s.started_at <= now() - interval '12 hours'))),
    'active_pedidos', (SELECT count(*) FROM public.pedidos p
                       WHERE p.operator_id = v_operator_id AND p.status NOT IN ('Cerrado', 'Rechazado')),
    'last_activity', v_last_activity,
    'account_active', (SELECT is_active FROM public.profiles WHERE id = v_operator_id)
  );
END;
$function$;
