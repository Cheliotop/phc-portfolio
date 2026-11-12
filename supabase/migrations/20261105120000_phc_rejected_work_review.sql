-- =====================================================================
-- Migration: phc_rejected_work_review  (version 20261105120000)
--
-- Finding B1 of docs/audits/PHC_HANDOFF_AUDIT_2026-11-05.md. Field work the
-- server permanently refuses used to stay only on the phone, where it could be
-- lost without anyone at the office knowing. Phones now report it here and an
-- admin accepts or rejects each item.
--
-- Accepting a drilling bar or water sample adds it to the well's record under
-- the original operator, marked with the report it came from. Other kinds affect
-- paid hours, stock or signed documents, so accepting those only records the
-- decision and a required note, and the admin enters the data by hand.
-- =====================================================================

CREATE TABLE public.rejected_work_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_entry_id text NOT NULL UNIQUE,
  operator_id uuid NOT NULL REFERENCES public.profiles(id),
  reported_by uuid NOT NULL REFERENCES public.profiles(id),
  project_id bigint REFERENCES public.projects(id),
  entity text NOT NULL,
  entity_id text,
  op text,
  payload jsonb NOT NULL,
  rejection_reason text,
  rejected_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  applied boolean NOT NULL DEFAULT false,
  decided_by uuid REFERENCES public.profiles(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rejected_work_reports_status ON public.rejected_work_reports (status, created_at);
CREATE INDEX idx_rejected_work_reports_operator_id ON public.rejected_work_reports (operator_id);
CREATE INDEX idx_rejected_work_reports_reported_by ON public.rejected_work_reports (reported_by);
CREATE INDEX idx_rejected_work_reports_project_id ON public.rejected_work_reports (project_id);
CREATE INDEX idx_rejected_work_reports_decided_by ON public.rejected_work_reports (decided_by);

COMMENT ON TABLE public.rejected_work_reports IS
  'Field work the server refused, reported by phones for admin review. operator_id is whose work it is; reported_by is the session that uploaded it, which differs when a phone changed hands.';

ALTER TABLE public.rejected_work_reports ENABLE ROW LEVEL SECURITY;

-- Reads only. Every write goes through the two functions below.
REVOKE ALL ON public.rejected_work_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rejected_work_reports TO authenticated;
GRANT ALL ON public.rejected_work_reports TO service_role;

CREATE POLICY "Read own or admin rejected work" ON public.rejected_work_reports
  FOR SELECT TO authenticated
  USING (public.is_admin() OR operator_id = (SELECT auth.uid()));

-- The mark on rows that reached the record through review.
ALTER TABLE public.drilling_bars
  ADD COLUMN accepted_review_id bigint REFERENCES public.rejected_work_reports(id);
ALTER TABLE public.water_samples
  ADD COLUMN accepted_review_id bigint REFERENCES public.rejected_work_reports(id);
CREATE INDEX idx_drilling_bars_accepted_review_id ON public.drilling_bars (accepted_review_id);
CREATE INDEX idx_water_samples_accepted_review_id ON public.water_samples (accepted_review_id);

-- ---------------------------------------------------------------------
-- A phone reports refused work. Deliberately open to any signed-in user,
-- including a deactivated one: that is exactly who this must not lose work
-- from. It can only add a pending row for an admin to read.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.report_rejected_work(
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
  v_id bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(p_client_entry_id) > 200
     OR length(btrim(COALESCE(p_entity, ''))) = 0
     OR length(p_entity) > 60
     OR p_payload IS NULL
     OR pg_column_size(p_payload) > 262144 THEN
    RAISE EXCEPTION 'Invalid rejected work report' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_id FROM public.rejected_work_reports
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    RETURN v_id;
  END IF;

  -- Whose work this claims to be is only ever shown to an admin next to who
  -- reported it, so a wrong claim cannot change any record by itself.
  SELECT id INTO v_operator FROM public.profiles WHERE id = p_operator_id;
  v_operator := COALESCE(v_operator, v_uid);

  SELECT p.id INTO v_project FROM public.projects p
  WHERE p.id = public.safe_bigint(COALESCE(p_payload ->> 'project_id', p_payload ->> 'projectId'));

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

-- ---------------------------------------------------------------------
-- Add an accepted item to the well's record. Returns false when this kind must
-- be entered by hand, or when the work already reached the server by itself.
-- ---------------------------------------------------------------------
CREATE FUNCTION private.apply_rejected_work(p_report public.rejected_work_reports)
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
  v_number integer;
  v_taken timestamptz;
  v_photo text;
BEGIN
  IF p_report.entity NOT IN ('drilling_bar', 'water_sample') THEN
    RETURN false;
  END IF;
  IF p_report.project_id IS NULL THEN
    RAISE EXCEPTION 'Este registro no indica un pozo válido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_report.project_id FOR UPDATE;
  IF public.project_status_key(v_project.status) <> 'active' THEN
    RAISE EXCEPTION 'El pozo no está activo, así que no admite registros nuevos' USING ERRCODE = '22023';
  END IF;

  IF p_report.entity = 'drilling_bar' THEN
    v_entry := v_payload ->> 'client_entry_id';
    IF length(btrim(COALESCE(v_entry, ''))) = 0
       OR length(btrim(COALESCE(v_payload ->> 'soil_type', ''))) = 0 THEN
      RAISE EXCEPTION 'A la barra le faltan datos obligatorios' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = v_entry) THEN
      RETURN false;
    END IF;

    v_length := COALESCE((v_payload ->> 'length')::real, v_project.default_bar_length, 3);
    IF v_length <= 0 OR v_length > 50 THEN
      RAISE EXCEPTION 'La longitud de barra debe estar entre 0 y 50 m' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(max(bar_number), 0), COALESCE(max(depth_end), 0)
    INTO v_last_bar, v_depth
    FROM public.drilling_bars WHERE project_id = p_report.project_id;

    -- The shift may be the very thing that was refused. The bar still counts.
    SELECT id INTO v_shift FROM public.shifts
    WHERE id = public.safe_uuid(v_payload ->> 'shift_id')
      AND project_id = p_report.project_id;

    -- Paths on the phone mean nothing here, and uploaded photos keep their own
    -- rows in public.photos, so only a list without device paths is kept.
    v_photos := CASE
      WHEN COALESCE(v_payload ->> 'photo_paths', '') LIKE '%file://%'
        OR COALESCE(v_payload ->> 'photo_paths', '') LIKE '%content://%' THEN NULL
      ELSE v_payload ->> 'photo_paths'
    END;

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
      (v_payload ->> 'duration_minutes')::integer, (v_payload ->> 'water_level')::real,
      v_payload ->> 'notes', v_photos, v_payload ->> 'timestamp_local',
      v_payload, p_report.id
    );
    RETURN true;
  END IF;

  v_entry := v_payload ->> 'clientEntryId';
  v_taken := (v_payload ->> 'takenAt')::timestamptz;
  IF length(btrim(COALESCE(v_entry, ''))) = 0 OR v_taken IS NULL THEN
    RAISE EXCEPTION 'A la muestra le faltan datos obligatorios' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.water_samples WHERE client_entry_id = v_entry) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(max(sample_number), 0) + 1 INTO v_number
  FROM public.water_samples WHERE project_id = p_report.project_id;

  v_photo := v_payload ->> 'bottlePhotoPath';
  IF v_photo IS NOT NULL AND v_photo NOT LIKE p_report.project_id::text || '/%' THEN
    v_photo := NULL;
  END IF;

  INSERT INTO public.water_samples (
    client_entry_id, project_id, sample_number, depth_m, stage, operator_id,
    notes, bottle_photo_path, taken_at, timestamp_local, device_time_flag,
    request_payload, accepted_review_id
  ) VALUES (
    v_entry, p_report.project_id, v_number, (v_payload ->> 'depthM')::real,
    NULLIF(btrim(COALESCE(v_payload ->> 'stage', '')), ''), p_report.operator_id,
    NULLIF(btrim(COALESCE(v_payload ->> 'notes', '')), ''), v_photo, v_taken,
    (v_payload ->> 'timestampLocal')::timestamptz, true, v_payload, p_report.id
  );
  RETURN true;
END;
$function$;

-- ---------------------------------------------------------------------
-- An admin decides. Atomic: if the work cannot be added, nothing is decided.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.decide_rejected_work(
  p_report_id bigint,
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS public.rejected_work_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_report public.rejected_work_reports;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_applied boolean := false;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'Decisión inválida' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_report FROM public.rejected_work_reports
  WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Registro no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.status <> 'pending' THEN
    RAISE EXCEPTION 'Este registro ya fue revisado' USING ERRCODE = '22023';
  END IF;

  -- A note is required whenever the decision adds nothing to the record, so the
  -- file always says why the work did not enter it.
  IF p_decision = 'rejected' AND length(COALESCE(v_note, '')) < 3 THEN
    RAISE EXCEPTION 'Indicá el motivo del rechazo' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'accepted'
     AND v_report.entity NOT IN ('drilling_bar', 'water_sample')
     AND length(COALESCE(v_note, '')) < 3 THEN
    RAISE EXCEPTION 'Este tipo de registro se carga a mano: indicá qué se hizo' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'accepted' THEN
    v_applied := private.apply_rejected_work(v_report);
  END IF;

  UPDATE public.rejected_work_reports
  SET status = p_decision, applied = v_applied, decided_by = auth.uid(),
      decided_at = now(), decision_note = v_note
  WHERE id = p_report_id
  RETURNING * INTO v_report;

  PERFORM private.write_audit(
    v_report.project_id, 'rejected_work.' || p_decision, 'rejected_work_reports',
    v_report.id::text, NULL, to_jsonb(v_report), v_note,
    jsonb_build_object('entity', v_report.entity, 'applied', v_applied,
                       'operator_id', v_report.operator_id)
  );
  RETURN v_report;
END;
$function$;

-- A malformed uuid in a payload must read as "no shift", not abort the decision.
CREATE FUNCTION public.safe_uuid(p_value text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE
SET search_path TO ''
AS $function$
BEGIN
  RETURN p_value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$function$;

-- A hosted project grants anon EXECUTE by another route, so revoke from both.
REVOKE ALL ON FUNCTION public.report_rejected_work(text, uuid, text, text, text, jsonb, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_rejected_work(text, uuid, text, text, text, jsonb, text, timestamptz) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.decide_rejected_work(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_rejected_work(bigint, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.safe_uuid(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safe_uuid(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.apply_rejected_work(public.rejected_work_reports) FROM PUBLIC, anon, authenticated;
