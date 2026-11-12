-- B2 and the no-overlap rule. Decisions: docs/audits/PHC_HANDOFF_AUDIT_2026-11-05.md.
--
-- Shifts on a well never overlap, because the admin pays hours from them:
--   * start_shift refuses while any shift on the well is open or report_pending,
--     and refuses a backdated start that reaches into an earlier shift.
--   * shifts_one_unresolved_per_project enforces it under concurrent starts. It
--     cannot be built if a well already holds two unresolved shifts, so the whole
--     migration fails safely: resolve those shifts first.
--
-- A start now uses the server's time when the phone sends none. The phone's time is
-- kept in start_device_time, and a difference over 15 minutes sets device_time_flag.
-- A start time in the future is no longer refused; it becomes the server's time.
--
-- An operator removed from a well while a shift is unresolved can finish that
-- shift: is_project_team_member also covers their own unresolved shift, which is
-- what the bar, consumption, water sample, material and photo rules all check.
-- Access ends when the shift closes. Moving a well flags its unresolved shifts.

ALTER TABLE public.shifts
  ADD COLUMN reassigned_during_shift boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX shifts_one_unresolved_per_project
  ON public.shifts(project_id)
  WHERE status IN ('open', 'report_pending');

CREATE OR REPLACE FUNCTION public.is_project_team_member(p_project_id bigint)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $function$
  SELECT public.is_project_operator(p_project_id)
      OR public.is_project_secondary_operator(p_project_id)
      OR (public.is_active_user() AND EXISTS (
            SELECT 1 FROM public.shifts s
            WHERE s.project_id = p_project_id
              AND s.operator_id = auth.uid()
              AND s.status IN ('open', 'report_pending')
          ));
$function$;

CREATE OR REPLACE FUNCTION private.flag_shifts_on_reassignment()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.shifts
  SET reassigned_during_shift = true, updated_at = now()
  WHERE project_id = NEW.id
    AND status IN ('open', 'report_pending')
    AND operator_id IS DISTINCT FROM NEW.assigned_operator_id;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION private.flag_shifts_on_reassignment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER flag_shifts_on_reassignment
  AFTER UPDATE OF assigned_operator_id ON public.projects
  FOR EACH ROW
  WHEN (OLD.assigned_operator_id IS DISTINCT FROM NEW.assigned_operator_id)
  EXECUTE FUNCTION private.flag_shifts_on_reassignment();

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
  v_started timestamptz := LEAST(v_requested, now());
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
    -- Returning the unresolved shift (instead of raising) commits the
    -- auto-close. The client must inspect status and finish its usage report.
    RETURN v_existing;
  END IF;

  -- One start at a time per well, so a losing start gets the message below rather
  -- than a bare unique violation from shifts_one_unresolved_per_project.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('start_shift:project:' || p_project_id::text, 0)
  );

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
    abs(extract(epoch FROM (now() - v_requested))) > 900
      OR (p_device_started_at IS NOT NULL AND abs(extract(epoch FROM (v_requested - p_device_started_at))) > 900)
      OR EXISTS (
        SELECT 1 FROM public.shifts prior
        WHERE prior.operator_id = auth.uid()
          AND COALESCE(prior.ended_at, prior.started_at + interval '12 hours') > v_started
      ),
    v_payload
  ) RETURNING * INTO v_result;

  RETURN v_result;
END;
$function$;

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
      IF v_shift.ended_at IS NULL OR v_shift.usage_report_submitted IS NOT TRUE THEN
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
