CREATE OR REPLACE FUNCTION public.save_material_reconciliation(p_project_id bigint, p_project_material_id bigint, p_returned_quantity real, p_notes text DEFAULT NULL::text)
 RETURNS material_reconciliations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_material public.project_materials;
  v_consumed real;
  v_allowed_returned real;
  v_stored_returned real;
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
  v_allowed_returned := greatest(COALESCE(v_material.initial_quantity, 0) - greatest(v_consumed, 0), 0);
  IF p_returned_quantity IS NULL OR p_returned_quantity < 0
     OR p_returned_quantity > v_allowed_returned + 0.0005::real THEN
    RAISE EXCEPTION 'Cantidad devuelta inválida' USING ERRCODE = '22023';
  END IF;
  v_stored_returned := CASE
    WHEN abs(p_returned_quantity - v_allowed_returned) <= 0.0005::real
      THEN round(v_allowed_returned::numeric, 3)::real
    ELSE round(p_returned_quantity::numeric, 3)::real
  END;
  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Reconciliación de cierre'), true);
  INSERT INTO public.material_reconciliations (
    project_id, project_material_id, sent_quantity, consumed_quantity,
    returned_quantity, notes, created_by
  ) VALUES (
    p_project_id, p_project_material_id,
    round(COALESCE(v_material.initial_quantity, 0)::numeric, 3)::real,
    round(greatest(v_consumed, 0)::numeric, 3)::real,
    v_stored_returned, p_notes, auth.uid()
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

REVOKE ALL ON FUNCTION public.save_material_reconciliation(bigint, bigint, real, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_material_reconciliation(bigint, bigint, real, text)
  TO authenticated, service_role;
