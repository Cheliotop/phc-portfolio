-- =====================================================================
-- Migration: phc_full_audit_fixes  (version 20261030230000)
--
-- Fixes from the 2026-10-30 full code audit
-- (docs/audits/PHC_CODE_AUDIT_2026-10-30.md). Every change is additive or a
-- tightening; no stored row is rewritten.
--
--   F2  authenticated/anon lose TRUNCATE, TRIGGER, REFERENCES on public tables.
--       TRUNCATE bypasses RLS; nothing in the product uses any of the three.
--   F3  operators may edit only their own phone/avatar, not the names that
--       appear in reports, dossiers and emails.
--   F4  role changes require the service role / SQL editor, matching the
--       documented rule that only the owner promotes admins.
--   F5  a stored PDF is attachable only by the user who uploaded it.
--   F6  subcontractors (secondary operators) can upload and read the project
--       photos their own field work requires. 20260725160000 widened the
--       public.* policies but never the two storage.objects ones, so every
--       subcontractor photo was refused and its outbox row quarantined.
--   F7  service-only helper so a password reset also ends the operator's
--       existing sessions.
--   F10 a shift that overlaps the operator's earlier shifts is flagged at
--       start, and hours_worked counts overlapping time once.
--   F12 sane upper bounds on bar length/duration and consumption, so one
--       typo cannot overflow depth/stock into a value the finite CHECKs then
--       refuse forever.
-- =====================================================================

-- ---------------------------------------------------------------------
-- F2
-- ---------------------------------------------------------------------
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- F3 + F4
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Service role / dashboard SQL editor: no JWT subject -> allowed.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Promotion/demotion is an owner action (dashboard or SQL editor only).
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'El rol solo puede cambiarse desde el panel de Supabase'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'No autorizado: el id y el correo de la cuenta son inmutables'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin() THEN
    -- A non-admin may maintain only their own contact details. Names and the
    -- username identify the person in reports, dossiers and emails.
    IF NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.username IS DISTINCT FROM OLD.username
       OR NEW.full_name IS DISTINCT FROM OLD.full_name
       OR NEW.first_name IS DISTINCT FROM OLD.first_name
       OR NEW.last_name IS DISTINCT FROM OLD.last_name THEN
      RAISE EXCEPTION 'No autorizado: solo un administrador puede cambiar nombre, usuario o estado'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Admins may not change their OWN activation (lockout guard).
  IF OLD.id = v_uid AND NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    RAISE EXCEPTION 'Un administrador no puede cambiar su propio estado de activacion'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------
-- F6: subcontractors upload and read project photos
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Active operators and admins upload constrained project photos"
  ON storage.objects;
CREATE POLICY "Active operators and admins upload constrained project photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-photos'
  AND objects.name ~ '^[1-9][0-9]*/[^/]+\.(jpg|jpeg|png|webp)$'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = public.storage_project_id(objects.name)
      AND public.project_status_key(p.status) = 'active'
  )
  AND (
    public.is_admin()
    OR public.is_project_team_member(public.storage_project_id(objects.name))
  )
);

DROP POLICY IF EXISTS "Assigned operators closers and admins read project photos"
  ON storage.objects;
CREATE POLICY "Assigned operators closers and admins read project photos"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'phc-photos'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND (
    public.is_admin()
    OR public.is_project_team_member(public.storage_project_id(objects.name))
    OR public.is_closing_operator(public.storage_project_id(objects.name))
  )
);

-- ---------------------------------------------------------------------
-- F7: end every session of a user (service role only)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count integer;
BEGIN
  -- Refresh tokens cascade from their session; access tokens already issued
  -- expire on their own (jwt_expiry).
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role;

-- ---------------------------------------------------------------------
-- F5, F10, F12: function bodies below are the current definitions with
-- only the marked checks added.
-- ---------------------------------------------------------------------
-- F5: signed PDF must be the admin's own upload
CREATE OR REPLACE FUNCTION private.attach_completion_pdf_20260712_impl(p_report_id bigint, p_storage_path text)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
         AND o.owner_id = auth.uid()::text
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
$function$;

-- F5: Ficha PDF must be the submitting operator's own upload
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

-- F5: same for resubmission
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
     OR v_report.operator_id IS DISTINCT FROM auth.uid() THEN
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

-- F10: flag a start that overlaps the operator's earlier shifts
CREATE OR REPLACE FUNCTION private.start_shift_20260712_impl(p_project_id bigint, p_shift_id uuid, p_client_entry_id text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_device_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.shifts;
  v_result public.shifts;
  v_started timestamptz := COALESCE(p_started_at, now());
  v_payload jsonb;
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
      OR (p_device_started_at IS NOT NULL AND abs(extract(epoch FROM (v_started - p_device_started_at))) > 900)
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

-- F10: hours_worked counts overlapping shift time once; expose flagged count
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
                                  AND (s.status = 'report_pending' OR s.end_type = 'auto'
                                       OR (s.status = 'open' AND s.started_at <= now() - interval '12 hours'))),
    'active_pedidos', (SELECT count(*) FROM public.pedidos p
                       WHERE p.operator_id = v_operator_id AND p.status NOT IN ('Cerrado', 'Rechazado')),
    'last_activity', v_last_activity,
    'account_active', (SELECT is_active FROM public.profiles WHERE id = v_operator_id)
  );
END;
$function$;

-- F12: bar length 0-50 m, duration 0-1440 min, water level >= 0
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
    IF v_captured_at IS NOT NULL AND (
      v_captured_at < v_shift.started_at - interval '15 minutes'
      OR v_captured_at > v_shift.started_at + interval '12 hours 15 minutes'
      OR (v_shift.status = 'closed'
          AND v_captured_at > v_shift.ended_at + interval '15 minutes')
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

-- F12: consumption at most 1,000,000 per entry
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
$function$;

-- F12: same bound for shift usage lines
CREATE OR REPLACE FUNCTION public.end_shift(p_shift_id uuid, p_usage jsonb, p_notes text DEFAULT NULL::text, p_device_ended_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_type text DEFAULT 'manual'::text)
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
  IF v_shift.operator_id IS DISTINCT FROM auth.uid() THEN
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
     AND pm.active IS TRUE
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'El informe debe incluir exactamente cada material activo del proyecto'
      USING ERRCODE = '22023';
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
      AND project_id = v_shift.project_id AND active IS TRUE
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
      v_anomaly := v_quantity > COALESCE(v_assignment.current_quantity, 0);
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
        p_device_ended_at IS NOT NULL AND (
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
    jsonb_build_object('usage_lines', jsonb_array_length(v_usage))
  );
  RETURN v_shift;
END;
$function$;
