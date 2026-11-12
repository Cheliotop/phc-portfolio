-- PostgREST 14.5 fails to serialize the HTTP error body when a RAISE
-- EXCEPTION uses ERRCODE 55000 together with a message containing non-ASCII
-- (accented) characters: the client gets a bare "Something went wrong" with
-- no JSON, no message, nothing recoverable — confirmed by isolated repro
-- (plain-ASCII 55000 and accented 22023 both serialize fine; only the
-- combination breaks). Every RAISE below that had both factors is moved to
-- ERRCODE 22023, which this same codebase already uses elsewhere for
-- business-rule violations and is unaffected by the bug. No client code
-- anywhere in phc-native or PHC_Web_Admin branches on the literal '55000'
-- string, so this is safe to change without any client-side changes.
-- Every other RAISE in these functions (plain-ASCII messages, or already on
-- a different ERRCODE) is left untouched.

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
    IF NOT public.project_allows_closure_change(v_report.project_id) THEN
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
    SET status = 'completed', updated_at = now(), end_date = COALESCE(end_date, CURRENT_DATE)
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

CREATE OR REPLACE FUNCTION public.return_completion_v2(p_report_id bigint, p_reason text)
 RETURNS completion_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_report public.completion_reports;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo de devolución requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_report.format_version < 2 THEN
    RAISE EXCEPTION 'Ficha v2 no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.finalized_at IS NOT NULL OR v_report.admin_signature IS NOT NULL THEN
    RAISE EXCEPTION 'Una Ficha firmada no puede devolverse' USING ERRCODE = '55000';
  END IF;
  IF v_report.status <> 'submitted' THEN
    RAISE EXCEPTION 'La Ficha no está pendiente de revisión (estado: %)', v_report.status
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_allows_closure_change(v_report.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite devolución de Ficha' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('phc.audit_reason', p_reason, true);
  UPDATE public.completion_reports
  SET status = 'returned', return_reason = btrim(p_reason),
      returned_by = auth.uid(), returned_at = now(), updated_at = now()
  WHERE id = p_report_id
  RETURNING * INTO v_report;
  PERFORM private.write_audit(
    v_report.project_id, 'ficha.returned', 'completion_reports', v_report.id::text,
    NULL, to_jsonb(v_report), p_reason, '{}'::jsonb
  );
  RETURN v_report;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_completion_discrepancy(p_project_id bigint, p_section text, p_description text, p_completion_report_id bigint DEFAULT NULL::bigint)
 RETURNS completion_discrepancies
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result public.completion_discrepancies;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_closing_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the closer or admin may report a discrepancy'
      USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_section, ''))) = 0
     OR length(btrim(COALESCE(p_description, ''))) < 3 THEN
    RAISE EXCEPTION 'Sección y descripción requeridas' USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_allows_closure_change(p_project_id) THEN
    RAISE EXCEPTION 'No se pueden crear discrepancias después de la firma/cierre'
      USING ERRCODE = '22023';
  END IF;
  IF p_completion_report_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.completion_reports cr
    WHERE cr.id = p_completion_report_id
      AND cr.project_id = p_project_id
      AND cr.finalized_at IS NULL
      AND cr.admin_signature IS NULL
  ) THEN
    RAISE EXCEPTION 'La Ficha indicada no pertenece al proyecto o ya está finalizada'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.completion_discrepancies (
    project_id, completion_report_id, section, description, reported_by
  ) VALUES (
    p_project_id, p_completion_report_id, btrim(p_section), btrim(p_description), auth.uid()
  ) RETURNING * INTO v_result;
  PERFORM private.write_audit(
    p_project_id, 'ficha.discrepancy_reported', 'completion_discrepancies', v_result.id::text,
    NULL, to_jsonb(v_result), p_description, '{}'::jsonb
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.deactivate_project_material_assignment(p_assignment_id bigint, p_reason text)
 RETURNS project_materials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.project_materials;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.project_materials WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND OR v_row.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Material asignado no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.project_allows_planning_change(v_row.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite cambios de materiales en su estado actual'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.material_consumption WHERE project_material_id = p_assignment_id
  ) THEN
    RAISE EXCEPTION 'No se puede quitar un material con consumo; ajusta el total o registra una corrección'
      USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('phc.audit_reason', p_reason, true);
  UPDATE public.project_materials
  SET active = false, updated_at = now(), notes = concat_ws(' · ', notes, p_reason)
  WHERE id = p_assignment_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_material_reconciliation(p_project_id bigint, p_project_material_id bigint, p_returned_quantity real, p_notes text DEFAULT NULL::text)
 RETURNS material_reconciliations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_material public.project_materials;
  v_consumed real;
  v_result public.material_reconciliations;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_material
  FROM public.project_materials
  WHERE id = p_project_material_id AND project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Material asignado no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF v_material.active IS NOT TRUE OR NOT public.project_allows_closure_change(p_project_id) THEN
    RAISE EXCEPTION 'El proyecto/material no admite reconciliación en su estado actual'
      USING ERRCODE = '22023';
  END IF;
  v_consumed := COALESCE(v_material.initial_quantity, 0) - COALESCE(v_material.current_quantity, 0);
  IF p_returned_quantity IS NULL OR p_returned_quantity < 0
     OR p_returned_quantity > greatest(COALESCE(v_material.initial_quantity, 0) - greatest(v_consumed, 0), 0) THEN
    RAISE EXCEPTION 'Cantidad devuelta inválida' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Reconciliación de cierre'), true);
  INSERT INTO public.material_reconciliations (
    project_id, project_material_id, sent_quantity, consumed_quantity,
    returned_quantity, notes, created_by
  ) VALUES (
    p_project_id, p_project_material_id, COALESCE(v_material.initial_quantity, 0),
    greatest(v_consumed, 0), p_returned_quantity, p_notes, auth.uid()
  )
  ON CONFLICT (project_id, project_material_id) DO UPDATE
    SET sent_quantity = EXCLUDED.sent_quantity,
        consumed_quantity = EXCLUDED.consumed_quantity,
        returned_quantity = EXCLUDED.returned_quantity,
        notes = EXCLUDED.notes,
        updated_at = now()
  RETURNING * INTO v_result;
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
