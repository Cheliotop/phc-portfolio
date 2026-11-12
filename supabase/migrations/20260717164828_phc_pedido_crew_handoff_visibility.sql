-- Crew handoff: pedidos visibility and receipt confirmation were scoped to
-- the original requesting operator only (operator_id = auth.uid()). When an
-- admin reassigns a project's current operator mid-lifecycle (a real crew
-- handoff), the incoming operator could not see, or confirm receipt of,
-- pedidos requested by the outgoing operator -- even after admin approval.
-- Extend scope to also allow the project's current assigned operator,
-- alongside the original requester and admins.

DROP POLICY IF EXISTS "Active operators view own pedidos" ON public.pedidos;
CREATE POLICY "Active operators view own or assigned pedidos"
  ON public.pedidos FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (operator_id = (SELECT auth.uid()) OR public.is_project_operator(project_id))
  );

DROP POLICY IF EXISTS "Operators read own pedido items" ON public.pedido_items;
CREATE POLICY "Operators read own or assigned pedido items"
  ON public.pedido_items FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_items.pedido_id
        AND (p.operator_id = (SELECT auth.uid()) OR public.is_project_operator(p.project_id))
    )
  );

DROP POLICY IF EXISTS "Operators read own pedido receipts" ON public.pedido_receipts;
CREATE POLICY "Operators read own or assigned pedido receipts"
  ON public.pedido_receipts FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND EXISTS (
      SELECT 1 FROM public.pedido_items pi
      JOIN public.pedidos p ON p.id = pi.pedido_id
      WHERE pi.id = pedido_receipts.pedido_item_id
        AND (p.operator_id = (SELECT auth.uid()) OR public.is_project_operator(p.project_id))
    )
  );

-- Outer RPC's own authorization gate must accept the current project
-- operator too, not just the original requester (admin already bypassed).
CREATE OR REPLACE FUNCTION public.confirm_pedido_item_receipt(p_item_id bigint, p_client_entry_id text, p_outcome text, p_quantity_received real DEFAULT 0, p_incident_note text DEFAULT NULL::text)
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
     AND NOT public.is_project_operator(v_pedido.project_id) THEN
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

-- Impl function: same relaxed authorization as the outer wrapper above.
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
     AND NOT public.is_project_operator(v_pedido.project_id) THEN
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

  -- Personal pedidos are deliberately inventory-neutral. Company inventory
  -- changes happen here and nowhere in the approval path.
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
