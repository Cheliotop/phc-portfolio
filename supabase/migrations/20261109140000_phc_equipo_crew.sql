-- Shared tablet per equipo (decided 2026-11-09; full audit section 2, T1-T9).
--
-- Each equipo is two operators sharing one tablet at the well:
--   * Crew of a well = its assigned operator (operador 1) + its secondary operators
--     (operador 2). The old subcontractor role is that second operator, now a full
--     crew member: pedidos, empresa receipts, the Ficha, shifts.
--   * One shift for the equipo: any crew member records on the well's open shift,
--     confirms its handover, ends it; shift_participants says who was on it, and
--     both get its hours.
--   * Each record is attributed to the operator who typed it: the field RPCs take
--     p_entered_by. The caller must be crew of the well and the named operator on
--     its team; the call then runs as that operator (private.begin_acting), so every
--     existing check and attribution applies to them. The uploader is kept in the
--     audit rows' metadata.
--   * Audit rows for role/activation and crew changes (SEC-4); deactivation ends
--     the user's sessions (AUTH-5/SEC-5); a returned Ficha can be resubmitted by
--     any crew member (SRV-4).
--
-- Generated from the live definitions by an asserted text-edit script; every
-- function body below is its previous definition plus the edits named above it.

-- ---------------------------------------------------------------- crew helpers
CREATE OR REPLACE FUNCTION public.is_project_crew(p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT public.is_active_user()
     AND (public.is_project_operator(p_project_id)
          OR public.is_project_secondary_operator(p_project_id));
$function$;
REVOKE ALL ON FUNCTION public.is_project_crew(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_project_crew(bigint) TO authenticated, service_role;

-- Crew membership of any user (no active check): for checks about someone other
-- than the caller, and inside begin_acting where auth.uid() is the actor.
CREATE OR REPLACE FUNCTION private.is_project_crew_for(p_user_id uuid, p_project_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p_user_id IS NOT NULL AND p_project_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.projects p
            WHERE p.id = p_project_id AND p.assigned_operator_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.project_secondary_operators s
               WHERE s.project_id = p_project_id AND s.operator_id = p_user_id));
$function$;
REVOKE ALL ON FUNCTION private.is_project_crew_for(uuid, bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- shift participants
CREATE TABLE public.shift_participants (
  shift_id uuid NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES public.profiles(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, operator_id)
);
CREATE INDEX shift_participants_operator_idx ON public.shift_participants (operator_id);
ALTER TABLE public.shift_participants ENABLE ROW LEVEL SECURITY;
INSERT INTO public.shift_participants (shift_id, operator_id, joined_at)
SELECT id, operator_id, started_at FROM public.shifts
ON CONFLICT (shift_id, operator_id) DO NOTHING;
REVOKE ALL ON public.shift_participants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shift_participants TO authenticated;
GRANT ALL ON public.shift_participants TO service_role;
CREATE POLICY "Admins and the well's crew read shift participants"
  ON public.shift_participants FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (public.is_active_user() AND (
      operator_id = (SELECT auth.uid())
      OR EXISTS (SELECT 1 FROM public.shifts s
                 WHERE s.id = shift_participants.shift_id
                   AND public.is_project_crew(s.project_id))))
  );

CREATE OR REPLACE FUNCTION private.add_shift_participant(p_shift_id uuid, p_operator_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  INSERT INTO public.shift_participants (shift_id, operator_id)
  SELECT p_shift_id, p_operator_id
  WHERE p_shift_id IS NOT NULL AND p_operator_id IS NOT NULL
  ON CONFLICT (shift_id, operator_id) DO NOTHING;
$function$;
REVOKE ALL ON FUNCTION private.add_shift_participant(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.track_shift_participant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.shift_id IS NOT NULL THEN
    PERFORM private.add_shift_participant(NEW.shift_id, NEW.operator_id);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.track_shift_participant() FROM PUBLIC, anon, authenticated;
-- Whoever starts a shift is on it, whatever path inserted the row.
CREATE OR REPLACE FUNCTION private.track_shift_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  PERFORM private.add_shift_participant(NEW.id, NEW.operator_id);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.track_shift_owner() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER shifts_track_owner_participant
  AFTER INSERT ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION private.track_shift_owner();
CREATE TRIGGER drilling_bars_track_shift_participant
  AFTER INSERT ON public.drilling_bars
  FOR EACH ROW EXECUTE FUNCTION private.track_shift_participant();
CREATE TRIGGER material_consumption_track_shift_participant
  AFTER INSERT ON public.material_consumption
  FOR EACH ROW EXECUTE FUNCTION private.track_shift_participant();

-- ---------------------------------------------------------------- acting for the typist
-- p_entered_by: the operator who typed the record on the shared tablet, possibly
-- uploaded later while the partner is signed in. Validates, then makes auth.uid()
-- return that operator until private.end_acting(), so the existing bodies attribute
-- and check everything for the typist. A deactivated typist then meets the existing
-- active-user checks and the work goes to the review list, as before (B1).
CREATE OR REPLACE FUNCTION private.begin_acting(p_project_id bigint, p_entered_by uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_claims jsonb;
BEGIN
  IF p_entered_by IS NULL OR p_entered_by = auth.uid() THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR NOT public.is_project_crew(p_project_id) THEN
    RAISE EXCEPTION 'No sos del equipo de este pozo' USING ERRCODE = '42501';
  END IF;
  IF NOT private.is_project_team_member_for(p_entered_by, p_project_id) THEN
    RAISE EXCEPTION 'Ese operador no es del equipo de este pozo' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('phc.caller', auth.uid()::text, true);
  PERFORM set_config('phc.saved_claims', COALESCE(current_setting('request.jwt.claims', true), ''), true);
  PERFORM set_config('phc.saved_claim_sub', COALESCE(current_setting('request.jwt.claim.sub', true), ''), true);
  v_claims := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  PERFORM set_config('request.jwt.claims',
    jsonb_set(v_claims, '{sub}', to_jsonb(p_entered_by::text))::text, true);
  IF COALESCE(current_setting('request.jwt.claim.sub', true), '') <> '' THEN
    PERFORM set_config('request.jwt.claim.sub', p_entered_by::text, true);
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION private.begin_acting(bigint, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.end_acting()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF COALESCE(current_setting('phc.caller', true), '') = '' THEN
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims', current_setting('phc.saved_claims', true), true);
  PERFORM set_config('request.jwt.claim.sub', current_setting('phc.saved_claim_sub', true), true);
  PERFORM set_config('phc.caller', '', true);
END;
$function$;
REVOKE ALL ON FUNCTION private.end_acting() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- audit (SEC-4) and sessions (SEC-5)
-- The audit rows name the uploader when a partner sent the typist's record.
CREATE OR REPLACE FUNCTION private.audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_project_id bigint;
  v_entity_id text;
  v_reason text;
  v_meta jsonb := jsonb_build_object('trigger', TG_NAME);
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_after := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_row := COALESCE(v_after, v_before, '{}'::jsonb);
  v_entity_id := COALESCE(v_row ->> 'id', v_row ->> 'project_id', 'unknown');
  v_project_id := NULLIF(v_row ->> 'project_id', '')::bigint;
  IF TG_TABLE_NAME = 'projects' THEN
    v_project_id := NULLIF(v_row ->> 'id', '')::bigint;
  END IF;
  IF TG_TABLE_NAME = 'profiles' THEN
    v_project_id := NULL;
  END IF;
  v_reason := NULLIF(current_setting('phc.audit_reason', true), '');
  IF COALESCE(current_setting('phc.caller', true), '') <> '' THEN
    v_meta := v_meta || jsonb_build_object('uploaded_by', current_setting('phc.caller', true));
  END IF;

  PERFORM private.write_audit(
    v_project_id,
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    v_entity_id,
    v_before,
    v_after,
    v_reason,
    v_meta
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER audit_profiles_mutation
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.is_active IS DISTINCT FROM NEW.is_active
        OR OLD.username IS DISTINCT FROM NEW.username OR OLD.full_name IS DISTINCT FROM NEW.full_name)
  EXECUTE FUNCTION private.audit_mutation();
CREATE TRIGGER audit_project_secondary_operators_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.project_secondary_operators
  FOR EACH ROW EXECUTE FUNCTION private.audit_mutation();

CREATE OR REPLACE FUNCTION private.revoke_sessions_on_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.is_active IS TRUE AND NEW.is_active IS FALSE THEN
    PERFORM public.revoke_user_sessions(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.revoke_sessions_on_deactivation() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER revoke_sessions_on_deactivation
  AFTER UPDATE OF is_active ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.revoke_sessions_on_deactivation();

-- Bars: any crew member of the well may record on its shift.
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

-- Consumption: same.
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
$function$;

-- Samples: the bottle photo may have been uploaded by the partner.
CREATE OR REPLACE FUNCTION private.register_water_sample_20260712_impl(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real DEFAULT NULL::real, p_stage text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_bottle_photo_path text DEFAULT NULL::text, p_sample_number integer DEFAULT NULL::integer, p_timestamp_local timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS water_samples
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
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
      AND private.is_project_team_member_for(ph.uploaded_by, p_project_id)
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
$function$;

-- start_shift: join the crew's open shift; the owner is a participant.
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
    abs(extract(epoch FROM (now() - v_requested))) > 900
      OR (p_device_started_at IS NOT NULL AND abs(extract(epoch FROM (v_requested - p_device_started_at))) > 900)
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
$function$;

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
$function$;

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

  v_fields := private.validate_completion_final_fields(p_final_fields);
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
  v_fields := private.validate_completion_final_fields(p_final_fields);
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
  PERFORM private.write_audit(
    v_report.project_id, 'ficha.resubmitted', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), NULL,
    jsonb_build_object('resubmission_id', p_client_entry_id)
  );
  RETURN v_report;
END;
$function$;

-- start_shift: body moved to private.start_shift_core; the public function adds p_entered_by.
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
      RAISE EXCEPTION 'Idempotency key belongs to another shift'
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
REVOKE ALL ON FUNCTION private.start_shift_core(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone, p_device_started_at timestamp with time zone) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.start_shift(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone, p_device_started_at timestamp with time zone);
CREATE FUNCTION public.start_shift(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_device_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.shifts;
BEGIN
  PERFORM private.begin_acting(p_project_id, p_entered_by);
  v_result := private.start_shift_core(p_project_id, p_shift_id, p_client_entry_id, p_started_at, p_device_started_at);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.start_shift(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone, p_device_started_at timestamp with time zone, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_shift(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone, p_device_started_at timestamp with time zone, p_entered_by uuid) TO authenticated, service_role;

-- create_drilling_bar: body moved to private.create_drilling_bar_core; the public function adds p_entered_by.
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
    RAISE EXCEPTION 'client_entry_id cannot be blank' USING ERRCODE = '22023';
  END IF;
  IF p_shift_id IS NOT NULL AND p_client_entry_id IS NULL THEN
    RAISE EXCEPTION 'Shift-bound bars require client_entry_id' USING ERRCODE = '22023';
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
REVOKE ALL ON FUNCTION private.create_drilling_bar_core(p_project_id bigint, p_soil_type text, p_client_entry_id text, p_length real, p_diameter text, p_start_time text, p_end_time text, p_duration_minutes integer, p_water_level real, p_notes text, p_photo_paths text, p_timestamp_local text, p_shift_id uuid) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.create_drilling_bar(p_project_id bigint, p_soil_type text, p_client_entry_id text, p_length real, p_diameter text, p_start_time text, p_end_time text, p_duration_minutes integer, p_water_level real, p_notes text, p_photo_paths text, p_timestamp_local text, p_shift_id uuid);
CREATE FUNCTION public.create_drilling_bar(p_project_id bigint, p_soil_type text, p_client_entry_id text DEFAULT NULL::text, p_length real DEFAULT NULL::real, p_diameter text DEFAULT NULL::text, p_start_time text DEFAULT NULL::text, p_end_time text DEFAULT NULL::text, p_duration_minutes integer DEFAULT NULL::integer, p_water_level real DEFAULT NULL::real, p_notes text DEFAULT NULL::text, p_photo_paths text DEFAULT NULL::text, p_timestamp_local text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS drilling_bars
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.drilling_bars;
BEGIN
  PERFORM private.begin_acting(p_project_id, p_entered_by);
  v_result := private.create_drilling_bar_core(p_project_id, p_soil_type, p_client_entry_id, p_length, p_diameter, p_start_time, p_end_time, p_duration_minutes, p_water_level, p_notes, p_photo_paths, p_timestamp_local, p_shift_id);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_drilling_bar(p_project_id bigint, p_soil_type text, p_client_entry_id text, p_length real, p_diameter text, p_start_time text, p_end_time text, p_duration_minutes integer, p_water_level real, p_notes text, p_photo_paths text, p_timestamp_local text, p_shift_id uuid, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_drilling_bar(p_project_id bigint, p_soil_type text, p_client_entry_id text, p_length real, p_diameter text, p_start_time text, p_end_time text, p_duration_minutes integer, p_water_level real, p_notes text, p_photo_paths text, p_timestamp_local text, p_shift_id uuid, p_entered_by uuid) TO authenticated, service_role;

-- register_water_sample: body moved to private.register_water_sample_core; the public function adds p_entered_by.
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
    RAISE EXCEPTION 'client_entry_id and taken_at required' USING ERRCODE = '22023';
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
REVOKE ALL ON FUNCTION private.register_water_sample_core(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real, p_stage text, p_notes text, p_bottle_photo_path text, p_sample_number integer, p_timestamp_local timestamp with time zone) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.register_water_sample(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real, p_stage text, p_notes text, p_bottle_photo_path text, p_sample_number integer, p_timestamp_local timestamp with time zone);
CREATE FUNCTION public.register_water_sample(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real DEFAULT NULL::real, p_stage text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_bottle_photo_path text DEFAULT NULL::text, p_sample_number integer DEFAULT NULL::integer, p_timestamp_local timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS water_samples
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.water_samples;
BEGIN
  PERFORM private.begin_acting(p_project_id, p_entered_by);
  v_result := private.register_water_sample_core(p_project_id, p_client_entry_id, p_taken_at, p_depth_m, p_stage, p_notes, p_bottle_photo_path, p_sample_number, p_timestamp_local);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.register_water_sample(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real, p_stage text, p_notes text, p_bottle_photo_path text, p_sample_number integer, p_timestamp_local timestamp with time zone, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_water_sample(p_project_id bigint, p_client_entry_id text, p_taken_at timestamp with time zone, p_depth_m real, p_stage text, p_notes text, p_bottle_photo_path text, p_sample_number integer, p_timestamp_local timestamp with time zone, p_entered_by uuid) TO authenticated, service_role;

-- record_material_consumption: body moved to private.record_material_consumption_core; the public function adds p_entered_by.
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
    RAISE EXCEPTION 'client_entry_id cannot be blank' USING ERRCODE = '22023';
  END IF;
  IF p_shift_id IS NOT NULL AND p_client_entry_id IS NULL THEN
    RAISE EXCEPTION 'Shift-bound consumption requires client_entry_id'
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
REVOKE ALL ON FUNCTION private.record_material_consumption_core(p_project_id bigint, p_quantity_used real, p_client_entry_id text, p_project_material_id bigint, p_material_id bigint, p_material_name text, p_unit text, p_date date, p_notes text, p_shift_id uuid, p_approximate boolean) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.record_material_consumption(p_project_id bigint, p_quantity_used real, p_client_entry_id text, p_project_material_id bigint, p_material_id bigint, p_material_name text, p_unit text, p_date date, p_notes text, p_shift_id uuid, p_approximate boolean);
CREATE FUNCTION public.record_material_consumption(p_project_id bigint, p_quantity_used real, p_client_entry_id text DEFAULT NULL::text, p_project_material_id bigint DEFAULT NULL::bigint, p_material_id bigint DEFAULT NULL::bigint, p_material_name text DEFAULT NULL::text, p_unit text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid, p_approximate boolean DEFAULT false, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS material_consumption
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.material_consumption;
BEGIN
  PERFORM private.begin_acting(p_project_id, p_entered_by);
  v_result := private.record_material_consumption_core(p_project_id, p_quantity_used, p_client_entry_id, p_project_material_id, p_material_id, p_material_name, p_unit, p_date, p_notes, p_shift_id, p_approximate);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_material_consumption(p_project_id bigint, p_quantity_used real, p_client_entry_id text, p_project_material_id bigint, p_material_id bigint, p_material_name text, p_unit text, p_date date, p_notes text, p_shift_id uuid, p_approximate boolean, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_material_consumption(p_project_id bigint, p_quantity_used real, p_client_entry_id text, p_project_material_id bigint, p_material_id bigint, p_material_name text, p_unit text, p_date date, p_notes text, p_shift_id uuid, p_approximate boolean, p_entered_by uuid) TO authenticated, service_role;

-- create_pedido_v2: body moved to private.create_pedido_v2_core; the public function adds p_entered_by.
CREATE OR REPLACE FUNCTION private.create_pedido_v2_core(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text DEFAULT NULL::text, p_priority text DEFAULT 'Normal'::text, p_needed_by date DEFAULT NULL::date, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.pedidos;
  v_items jsonb;
  v_payload jsonb;
  v_legacy_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_crew(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;
  v_items := private.canonicalize_pedido_items(p_items);
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'kind', p_kind, 'items', v_items,
    'justification', NULLIF(btrim(COALESCE(p_justification, '')), ''),
    'priority', COALESCE(p_priority, 'Normal'), 'needed_by', p_needed_by,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
  ));
  v_legacy_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'kind', p_kind, 'items', p_items,
    'justification', NULLIF(btrim(COALESCE(p_justification, '')), ''),
    'priority', COALESCE(p_priority, 'Normal'), 'needed_by', p_needed_by,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('create_pedido_v2:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_existing
  FROM public.pedidos
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.kind IS DISTINCT FROM p_kind
       OR (
         v_existing.request_payload IS DISTINCT FROM v_payload
         AND v_existing.request_payload IS DISTINCT FROM v_legacy_payload
       ) THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'pedido', to_jsonb(v_existing),
      'items', (
        SELECT COALESCE(jsonb_agg(to_jsonb(pi) ORDER BY pi.id), '[]'::jsonb)
        FROM public.pedido_items pi WHERE pi.pedido_id = v_existing.id
      ),
      'idempotent_replay', true
    );
  END IF;
  RETURN private.create_pedido_v2_20260712_impl(
    p_project_id, p_kind, v_items, p_client_entry_id,
    p_justification, p_priority, p_needed_by, p_notes
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.create_pedido_v2_core(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text, p_priority text, p_needed_by date, p_notes text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.create_pedido_v2(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text, p_priority text, p_needed_by date, p_notes text);
CREATE FUNCTION public.create_pedido_v2(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text DEFAULT NULL::text, p_priority text DEFAULT 'Normal'::text, p_needed_by date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM private.begin_acting(p_project_id, p_entered_by);
  v_result := private.create_pedido_v2_core(p_project_id, p_kind, p_items, p_client_entry_id, p_justification, p_priority, p_needed_by, p_notes);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_pedido_v2(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text, p_priority text, p_needed_by date, p_notes text, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pedido_v2(p_project_id bigint, p_kind text, p_items jsonb, p_client_entry_id text, p_justification text, p_priority text, p_needed_by date, p_notes text, p_entered_by uuid) TO authenticated, service_role;

-- submit_completion_v2: body moved to private.submit_completion_v2_core; the public function adds p_entered_by.
CREATE OR REPLACE FUNCTION private.submit_completion_v2_core(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text DEFAULT NULL::text, p_pdf_url text DEFAULT NULL::text)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.completion_reports;
  v_attempt private.completion_submission_attempts;
  v_fields jsonb;
  v_payload jsonb;
  v_existing_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  -- Operator testimony cannot be manufactured through an admin bypass.
  IF NOT public.is_closing_operator(p_project_id) AND NOT public.is_project_crew(p_project_id) THEN
    RAISE EXCEPTION 'Only the responsible closing operator may submit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(btrim(COALESCE(p_operator_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Identificador y firma del operador requeridos'
      USING ERRCODE = '22023';
  END IF;
  v_fields := private.validate_completion_final_fields_strict(p_final_fields);
  v_payload := jsonb_build_object(
    'final_fields', v_fields - ARRAY[
      '_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'
    ],
    'operator_signature', btrim(p_operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
    'pdf_url', p_pdf_url
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('submit_completion_v2:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_attempt
  FROM private.completion_submission_attempts
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_attempt.project_id IS DISTINCT FROM p_project_id
       OR v_attempt.actor_id IS DISTINCT FROM auth.uid()
       OR v_attempt.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_existing
    FROM public.completion_reports WHERE id = v_attempt.report_id;
    RETURN v_existing;
  END IF;
  SELECT * INTO v_existing
  FROM public.completion_reports
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    v_existing_payload := COALESCE(
      v_existing.submission_payload,
      CASE WHEN v_existing.format_version >= 2
        THEN private.completion_submission_payload(v_existing)
      END
    );
    IF v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    INSERT INTO private.completion_submission_attempts (
      client_entry_id, report_id, project_id, actor_id, request_payload
    ) VALUES (
      p_client_entry_id, v_existing.id, p_project_id, auth.uid(), v_payload
    );
    RETURN v_existing;
  END IF;
  v_existing := private.submit_completion_v2_20260712_impl(
    p_project_id, p_client_entry_id, v_fields, p_operator_signature,
    p_completion_notes, p_pdf_url
  );
  INSERT INTO private.completion_submission_attempts (
    client_entry_id, report_id, project_id, actor_id, request_payload
  ) VALUES (
    p_client_entry_id, v_existing.id, p_project_id, auth.uid(), v_payload
  );
  RETURN v_existing;
END;
$function$;
REVOKE ALL ON FUNCTION private.submit_completion_v2_core(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.submit_completion_v2(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text);
CREATE FUNCTION public.submit_completion_v2(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text DEFAULT NULL::text, p_pdf_url text DEFAULT NULL::text, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.completion_reports;
BEGIN
  PERFORM private.begin_acting(p_project_id, p_entered_by);
  v_result := private.submit_completion_v2_core(p_project_id, p_client_entry_id, p_final_fields, p_operator_signature, p_completion_notes, p_pdf_url);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.submit_completion_v2(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_completion_v2(p_project_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text, p_entered_by uuid) TO authenticated, service_role;

-- end_shift: body moved to private.end_shift_core; the public function adds p_entered_by.
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
      v_effective_date := COALESCE((v_item ->> 'date')::date, CURRENT_DATE);
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
REVOKE ALL ON FUNCTION private.end_shift_core(p_shift_id uuid, p_usage jsonb, p_notes text, p_device_ended_at timestamp with time zone, p_end_type text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.end_shift(p_shift_id uuid, p_usage jsonb, p_notes text, p_device_ended_at timestamp with time zone, p_end_type text);
CREATE FUNCTION public.end_shift(p_shift_id uuid, p_usage jsonb, p_notes text DEFAULT NULL::text, p_device_ended_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_type text DEFAULT 'manual'::text, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.shifts;
BEGIN
  PERFORM private.begin_acting((SELECT s.project_id FROM public.shifts s WHERE s.id = p_shift_id), p_entered_by);
  v_result := private.end_shift_core(p_shift_id, p_usage, p_notes, p_device_ended_at, p_end_type);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.end_shift(p_shift_id uuid, p_usage jsonb, p_notes text, p_device_ended_at timestamp with time zone, p_end_type text, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_shift(p_shift_id uuid, p_usage jsonb, p_notes text, p_device_ended_at timestamp with time zone, p_end_type text, p_entered_by uuid) TO authenticated, service_role;

-- confirm_shift_handover: body moved to private.confirm_shift_handover_core; the public function adds p_entered_by.
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
     AND pm.active IS TRUE
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'A handover item is not an active material in this project'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id AND pm.active IS TRUE
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
    SELECT * FROM public.project_materials
    WHERE project_id = v_shift.project_id AND active IS TRUE
    ORDER BY id
    FOR UPDATE
  LOOP
    v_item := NULL;
    SELECT value INTO v_item
    FROM jsonb_array_elements(v_items)
    WHERE public.safe_bigint(value ->> 'project_material_id') = v_assignment.id
    LIMIT 1;
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
REVOKE ALL ON FUNCTION private.confirm_shift_handover_core(p_shift_id uuid, p_items jsonb) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.confirm_shift_handover(p_shift_id uuid, p_items jsonb);
CREATE FUNCTION public.confirm_shift_handover(p_shift_id uuid, p_items jsonb, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.shifts;
BEGIN
  PERFORM private.begin_acting((SELECT s.project_id FROM public.shifts s WHERE s.id = p_shift_id), p_entered_by);
  v_result := private.confirm_shift_handover_core(p_shift_id, p_items);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_shift_handover(p_shift_id uuid, p_items jsonb, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_shift_handover(p_shift_id uuid, p_items jsonb, p_entered_by uuid) TO authenticated, service_role;

-- confirm_pedido_item_receipt: body moved to private.confirm_pedido_item_receipt_core; the public function adds p_entered_by.
CREATE OR REPLACE FUNCTION private.confirm_pedido_item_receipt_core(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real DEFAULT 0, p_incident_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_item public.pedido_items;
  v_pedido public.pedidos;
  v_existing public.pedido_receipts;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.pedido_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = v_item.pedido_id;
  IF v_pedido.operator_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND NOT (public.is_project_crew(v_pedido.project_id) AND v_pedido.kind = 'empresa') THEN
    RAISE EXCEPTION 'Only the requesting operator can confirm receipt'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('confirm_pedido_item_receipt:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_existing
  FROM public.pedido_receipts
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.confirmed_by IS DISTINCT FROM auth.uid()
       OR v_existing.pedido_item_id IS DISTINCT FROM p_item_id
       OR v_existing.outcome IS DISTINCT FROM p_outcome
       OR v_existing.quantity_received IS DISTINCT FROM COALESCE(p_quantity_received, 0)
       OR v_existing.incident_note IS DISTINCT FROM
          NULLIF(btrim(COALESCE(p_incident_note, '')), '') THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'receipt', to_jsonb(v_existing),
      'item', to_jsonb(v_item),
      'idempotent_replay', true
    );
  END IF;
  RETURN private.confirm_pedido_item_receipt_20260712_impl(
    p_item_id, p_client_entry_id, p_outcome,
    p_quantity_received, p_incident_note
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.confirm_pedido_item_receipt_core(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real, p_incident_note text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.confirm_pedido_item_receipt(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real, p_incident_note text);
CREATE FUNCTION public.confirm_pedido_item_receipt(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real DEFAULT 0, p_incident_note text DEFAULT NULL::text, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM private.begin_acting((SELECT p.project_id FROM public.pedido_items pi JOIN public.pedidos p ON p.id = pi.pedido_id WHERE pi.id = p_item_id), p_entered_by);
  v_result := private.confirm_pedido_item_receipt_core(p_item_id, p_client_entry_id, p_outcome, p_quantity_received, p_incident_note);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_pedido_item_receipt(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real, p_incident_note text, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_pedido_item_receipt(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real, p_incident_note text, p_entered_by uuid) TO authenticated, service_role;

-- resubmit_completion_v2: body moved to private.resubmit_completion_v2_core; the public function adds p_entered_by.
CREATE OR REPLACE FUNCTION private.resubmit_completion_v2_core(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text DEFAULT NULL::text, p_pdf_url text DEFAULT NULL::text)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_report public.completion_reports;
  v_attempt private.completion_resubmission_attempts;
  v_fields jsonb;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(btrim(COALESCE(p_operator_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Identificador y firma del operador requeridos'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report FROM public.completion_reports WHERE id = p_report_id;
  IF NOT FOUND OR v_report.format_version < 2 THEN
    RAISE EXCEPTION 'Ficha v2 no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_closing_operator(v_report.project_id)
     AND NOT public.is_project_crew(v_report.project_id) THEN
    RAISE EXCEPTION 'Only the responsible closing operator may resubmit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  v_fields := private.validate_completion_final_fields_strict(p_final_fields);
  v_payload := jsonb_build_object(
    'final_fields', v_fields - ARRAY[
      '_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'
    ],
    'operator_signature', btrim(p_operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
    'pdf_url', p_pdf_url
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('resubmit_completion_v2:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_attempt
  FROM private.completion_resubmission_attempts
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_attempt.report_id IS DISTINCT FROM p_report_id
       OR v_attempt.project_id IS DISTINCT FROM v_report.project_id
       OR v_attempt.actor_id IS DISTINCT FROM auth.uid()
       OR v_attempt.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_report FROM public.completion_reports WHERE id = v_attempt.report_id;
    RETURN v_report;
  END IF;

  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF v_report.last_resubmission_id = p_client_entry_id THEN
    IF v_report.submission_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    INSERT INTO private.completion_resubmission_attempts (
      client_entry_id, report_id, project_id, actor_id, request_payload
    ) VALUES (
      p_client_entry_id, p_report_id, v_report.project_id, auth.uid(), v_payload
    );
    RETURN v_report;
  END IF;

  v_report := private.resubmit_completion_v2_20260712_impl(
    p_report_id, p_client_entry_id, v_fields, p_operator_signature,
    p_completion_notes, p_pdf_url
  );
  INSERT INTO private.completion_resubmission_attempts (
    client_entry_id, report_id, project_id, actor_id, request_payload
  ) VALUES (
    p_client_entry_id, p_report_id, v_report.project_id, auth.uid(), v_payload
  );
  RETURN v_report;
END;
$function$;
REVOKE ALL ON FUNCTION private.resubmit_completion_v2_core(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.resubmit_completion_v2(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text);
CREATE FUNCTION public.resubmit_completion_v2(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text DEFAULT NULL::text, p_pdf_url text DEFAULT NULL::text, p_entered_by uuid DEFAULT NULL::uuid)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.completion_reports;
BEGIN
  PERFORM private.begin_acting((SELECT r.project_id FROM public.completion_reports r WHERE r.id = p_report_id), p_entered_by);
  v_result := private.resubmit_completion_v2_core(p_report_id, p_client_entry_id, p_final_fields, p_operator_signature, p_completion_notes, p_pdf_url);
  PERFORM private.end_acting();
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.resubmit_completion_v2(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text, p_entered_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resubmit_completion_v2(p_report_id bigint, p_client_entry_id text, p_final_fields jsonb, p_operator_signature text, p_completion_notes text, p_pdf_url text, p_entered_by uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------- policies: the second operator is crew
DROP POLICY "Read own empresa or admin pedidos" ON public.pedidos;
CREATE POLICY "Read own empresa or admin pedidos" ON public.pedidos AS PERMISSIVE FOR SELECT TO public
  USING (((is_active_user() AND ((operator_id = ( SELECT auth.uid() AS uid)) OR (is_project_crew(project_id) AND (kind = 'empresa'::text)))) OR is_admin()));

DROP POLICY "Operators can create assigned-project pedidos" ON public.pedidos;
CREATE POLICY "Operators can create assigned-project pedidos" ON public.pedidos AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((operator_id = ( SELECT auth.uid() AS uid)) AND is_project_crew(project_id) AND (status = 'Pendiente'::text) AND (approved_by IS NULL) AND (approved_at IS NULL) AND (rejection_reason IS NULL) AND (closed_manually IS FALSE) AND (closed_by IS NULL) AND (closed_at IS NULL) AND (kind = 'empresa'::text) AND (request_payload IS NULL) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = pedidos.project_id) AND (p.created_at < '2026-07-11 10:29:30+00'::timestamp with time zone) AND (project_status_key(p.status) = 'active'::text)))) AND ((kind <> 'empresa'::text) OR (length(btrim(COALESCE(justification, reason, notes, ''::text))) >= 3))));

DROP POLICY "Read assigned empresa or admin pedido items" ON public.pedido_items;
CREATE POLICY "Read assigned empresa or admin pedido items" ON public.pedido_items AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR (is_active_user() AND (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_items.pedido_id) AND ((p.operator_id = ( SELECT auth.uid() AS uid)) OR (is_project_crew(p.project_id) AND (p.kind = 'empresa'::text)))))))));

DROP POLICY "Read assigned empresa or admin pedido receipts" ON public.pedido_receipts;
CREATE POLICY "Read assigned empresa or admin pedido receipts" ON public.pedido_receipts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR (is_active_user() AND (EXISTS ( SELECT 1
   FROM (pedido_items pi
     JOIN pedidos p ON ((p.id = pi.pedido_id)))
  WHERE ((pi.id = pedido_receipts.pedido_item_id) AND ((p.operator_id = ( SELECT auth.uid() AS uid)) OR (is_project_crew(p.project_id) AND (p.kind = 'empresa'::text)))))))));

DROP POLICY "Read own closing or admin shifts" ON public.shifts;
CREATE POLICY "Read own closing or admin shifts" ON public.shifts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR is_closing_operator(project_id) OR (is_active_user() AND ((operator_id = ( SELECT auth.uid() AS uid)) OR is_project_crew(project_id)))));

DROP POLICY "Read own or admin handovers" ON public.shift_handovers;
CREATE POLICY "Read own or admin handovers" ON public.shift_handovers AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR (is_active_user() AND ((confirmed_by = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1 FROM shifts s WHERE ((s.id = shift_handovers.shift_id) AND is_project_crew(s.project_id))))))));

DROP POLICY "Active project operators upload photo metadata" ON public.photos;
CREATE POLICY "Active project operators upload photo metadata" ON public.photos AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((uploaded_by = ( SELECT auth.uid() AS uid)) AND is_project_team_member(project_id) AND (storage_path ~~ ((project_id)::text || '/%'::text)) AND (EXISTS ( SELECT 1
   FROM storage.objects o
  WHERE ((o.bucket_id = 'phc-photos'::text) AND (o.name = photos.storage_path)))) AND (((evidence_kind = 'water_sample'::text) AND (shift_id IS NULL)) OR ((evidence_kind = 'field'::text) AND (shift_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM shifts s
  WHERE ((s.id = photos.shift_id) AND (s.project_id = photos.project_id) AND ((s.operator_id = ( SELECT auth.uid() AS uid)) OR is_project_crew(s.project_id)) AND (s.status = ANY (ARRAY['open'::text, 'report_pending'::text, 'closed'::text])) AND (s.started_at > (now() - '7 days'::interval))))))) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = photos.project_id) AND (project_status_key(p.status) = 'active'::text))))));

DROP POLICY "Read own closing or admin completion reports" ON public.completion_reports;
CREATE POLICY "Read own closing or admin completion reports" ON public.completion_reports AS PERMISSIVE FOR SELECT TO public
  USING (((is_active_user() AND ((operator_id = ( SELECT auth.uid() AS uid)) OR is_project_crew(project_id))) OR is_closing_operator(project_id) OR is_admin()));

DROP POLICY "Authorized users read reports and admins read attachments" ON storage.objects;
CREATE POLICY "Authorized users read reports and admins read attachments" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated
  USING (((bucket_id = 'phc-reports'::text) AND (storage_project_id(name) IS NOT NULL) AND (is_admin() OR ((COALESCE((storage.foldername(name))[2], ''::text) <> 'attachments'::text) AND (is_project_crew(storage_project_id(name)) OR is_closing_operator(storage_project_id(name)))))));

DROP POLICY "Authorized users upload constrained reports and attachments" ON storage.objects;
CREATE POLICY "Authorized users upload constrained reports and attachments" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((bucket_id = 'phc-reports'::text) AND (storage_project_id(name) IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE (p.id = storage_project_id(objects.name)))) AND (((COALESCE((storage.foldername(name))[2], ''::text) = 'attachments'::text) AND is_admin() AND (name ~ '^[1-9][0-9]*/attachments/[^/]+\.(pdf|jpg|jpeg|png)$'::text)) OR ((COALESCE((storage.foldername(name))[2], ''::text) <> 'attachments'::text) AND (name ~ '^[1-9][0-9]*/[^/]+\.pdf$'::text) AND (is_admin() OR ((EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = storage_project_id(objects.name)) AND (project_status_key(p.status) = ANY (ARRAY['active'::text, 'closure_submitted'::text]))))) AND (is_project_crew(storage_project_id(name)) OR is_closing_operator(storage_project_id(name)))))))));

-- ---------------------------------------------------------------- join_shift
-- The partner signs in on the tablet during the equipo's shift. Idempotent; on a
-- shift that is no longer open it changes nothing and doesn't fail, because a join
-- queued offline may arrive after the shift closed.
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
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002';
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

-- ---------------------------------------------------------------- equipo of a well (admin)
-- One call, one transaction: operador 1 and operador 2 of a well. The web and the
-- admin's phone used three separate writes, which could stop halfway.
CREATE OR REPLACE FUNCTION public.set_project_equipo(
  p_project_id bigint, p_operator_id uuid, p_partner_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Pozo no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF p_partner_id IS NOT NULL AND p_partner_id = p_operator_id THEN
    RAISE EXCEPTION 'El operador 2 tiene que ser distinto del operador 1' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles pr
    WHERE pr.id IN (p_operator_id, p_partner_id)
      AND (pr.role <> 'operator' OR pr.is_active IS NOT TRUE)
  ) THEN
    RAISE EXCEPTION 'Los dos integrantes del equipo tienen que ser operadores activos' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('phc.audit_reason', 'Equipo del pozo', true);
  IF (SELECT assigned_operator_id FROM public.projects WHERE id = p_project_id) IS DISTINCT FROM p_operator_id THEN
    UPDATE public.projects SET assigned_operator_id = p_operator_id WHERE id = p_project_id;
  END IF;
  DELETE FROM public.project_secondary_operators
  WHERE project_id = p_project_id
    AND (p_partner_id IS NULL OR operator_id <> p_partner_id);
  IF p_partner_id IS NOT NULL THEN
    INSERT INTO public.project_secondary_operators (project_id, operator_id)
    VALUES (p_project_id, p_partner_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('project_id', p_project_id, 'operator_id', p_operator_id, 'partner_id', p_partner_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_project_equipo(bigint, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_project_equipo(bigint, uuid, uuid) TO authenticated, service_role;

-- The old wording called operador 2 "subcontratista".
CREATE OR REPLACE FUNCTION private.reject_secondary_equals_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.projects p
     WHERE p.id = NEW.project_id
       AND p.assigned_operator_id = NEW.operator_id
  ) THEN
    RAISE EXCEPTION 'Ese operador ya es el operador 1 del pozo; no puede ser también su operador 2'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- metrics (WEB-3, SRV-11)
-- Shift figures count every shift the operator was on (shift_participants), and
-- p_from / p_to (inclusive, Asunción dates) limit the period. Same JSON shape, plus
-- period_from / period_to.
DROP FUNCTION public.get_operator_accountability_metrics(uuid);
CREATE FUNCTION public.get_operator_accountability_metrics(
  p_operator_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date
) RETURNS jsonb
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
            SELECT s.started_at, s.ended_at,
                   CASE WHEN s.started_at < max(s.ended_at) OVER (
                          ORDER BY s.started_at, s.ended_at
                          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                        THEN 0 ELSE 1 END AS starts_island
            FROM public.shifts s
            JOIN public.shift_participants sp ON sp.shift_id = s.id
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
REVOKE ALL ON FUNCTION public.get_operator_accountability_metrics(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_accountability_metrics(uuid, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
