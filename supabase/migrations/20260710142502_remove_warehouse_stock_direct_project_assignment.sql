-- Recovered from remote supabase_migrations.schema_migrations on 2026-07-11:
-- applied directly to the live project on 2026-07-10, never committed as a
-- file. Recorded verbatim so local history matches the remote. Do NOT edit or
-- re-apply; approve_pedido's auto-assignment behavior defined here is retired
-- by 20260711102930_phc_product_plan_v2.sql (fail-loud stub).

-- Product decision 2026-07-10: no more shared warehouse stock pool that
-- assignments draw down from. Materials get assigned directly to a project
-- by name+quantity (no dependency on a pre-existing `materials` catalog row
-- or its current_stock). The `materials` table itself is left untouched
-- (not dropped) in case it's still useful for something later, it's just no
-- longer read or written by these two functions.
--
-- Signatures change (bigint material_id -> text material_name), so the old
-- overloads must be dropped explicitly -- CREATE OR REPLACE with a different
-- parameter list creates a second overloaded function instead of replacing
-- the old one, which would leave both active.

DROP FUNCTION IF EXISTS public.assign_material_to_project(bigint, bigint, real, text);
DROP FUNCTION IF EXISTS public.approve_pedido(bigint, bigint, real, text);

CREATE FUNCTION public.assign_material_to_project(p_project_id bigint, p_material_name text, p_quantity real, p_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS project_materials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.project_materials;
  v_result public.project_materials;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_material_name IS NULL OR btrim(p_material_name) = '' THEN
    RAISE EXCEPTION 'material_name is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM public.project_materials
    WHERE project_id = p_project_id AND material_name = btrim(p_material_name) FOR UPDATE;

  IF FOUND THEN
    UPDATE public.project_materials SET
      quantity_allocated = COALESCE(quantity_allocated, 0) + p_quantity,
      initial_quantity = COALESCE(initial_quantity, 0) + p_quantity,
      current_quantity = COALESCE(current_quantity, 0) + p_quantity,
      unit = COALESCE(p_unit, unit),
      notes = COALESCE(p_notes, notes),
      updated_at = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.project_materials (
      project_id, material_name, quantity_allocated,
      initial_quantity, current_quantity, unit, assigned_date, notes
    ) VALUES (
      p_project_id, btrim(p_material_name), p_quantity,
      p_quantity, p_quantity, p_unit, now(), p_notes
    )
    RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.approve_pedido(p_pedido_id bigint, p_quantity_override real DEFAULT NULL::real, p_notes text DEFAULT NULL::text)
 RETURNS pedidos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pedido public.pedidos;
  v_qty real;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pedido FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_pedido.status <> 'Pendiente' THEN
    RAISE EXCEPTION 'Pedido ya fue procesado (estado: %)', v_pedido.status USING ERRCODE = '22023';
  END IF;

  IF v_pedido.project_id IS NOT NULL THEN
    v_qty := COALESCE(p_quantity_override, v_pedido.quantity);
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Cantidad invalida para asignar' USING ERRCODE = '22023';
    END IF;
    -- Approving directly grants the requested material/quantity to the
    -- project -- no warehouse stock check, since there is no warehouse.
    PERFORM public.assign_material_to_project(v_pedido.project_id, v_pedido.material, v_qty, NULL, p_notes);
  END IF;

  UPDATE public.pedidos SET
    status = 'Aprobado',
    admin_notes = COALESCE(p_notes, admin_notes),
    approved_by = auth.uid(),
    approved_at = now(),
    updated_at = now()
  WHERE id = p_pedido_id
  RETURNING * INTO v_pedido;

  RETURN v_pedido;
END;
$function$;
