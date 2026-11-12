-- =====================================================================
-- Migration: phc_admin_pedido_and_completion_rpcs  (version 20260709102334)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- =====================================================================
-- PHC Pass 4 — Admin workflow correctness RPCs
-- Solves the pedido double-entry problem (approve == assign material +
-- reduce stock + set status, atomically) and makes cierre signing drive
-- project completion. All admin-gated via is_admin(); composed from the
-- existing assign_material_to_project() so stock is never double-subtracted.
-- =====================================================================

-- Audit columns on pedidos (small additive change).
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Approve a pending pedido. Optionally assign a real inventory material to the
-- pedido's project and decrement stock in the same transaction (this is the
-- fix for the approve→assign→adjust triple manual step). If p_material_id is
-- NULL, only the status/audit fields change (admin can assign later).
CREATE OR REPLACE FUNCTION public.approve_pedido(
  p_pedido_id bigint,
  p_material_id bigint DEFAULT NULL,
  p_quantity real DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.pedidos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  IF p_material_id IS NOT NULL THEN
    IF v_pedido.project_id IS NULL THEN
      RAISE EXCEPTION 'El pedido no tiene proyecto asignado; no se puede asignar material' USING ERRCODE = '22023';
    END IF;
    v_qty := COALESCE(p_quantity, v_pedido.quantity);
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida para asignar' USING ERRCODE = '22023';
    END IF;
    PERFORM public.assign_material_to_project(v_pedido.project_id, p_material_id, v_qty, p_notes);
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
$$;

-- Reject a pending pedido with a reason (audited).
CREATE OR REPLACE FUNCTION public.reject_pedido(
  p_pedido_id bigint,
  p_reason text DEFAULT NULL
)
RETURNS public.pedidos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_pedido public.pedidos;
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

  UPDATE public.pedidos SET
    status = 'Rechazado',
    rejection_reason = p_reason,
    admin_notes = COALESCE(p_reason, admin_notes),
    approved_by = auth.uid(),
    approved_at = now(),
    updated_at = now()
  WHERE id = p_pedido_id
  RETURNING * INTO v_pedido;

  RETURN v_pedido;
END;
$$;

-- Admin signs a completion report; optionally drives the project to
-- 'completed' in the same transaction. Blocks a double-sign.
CREATE OR REPLACE FUNCTION public.sign_completion_report(
  p_report_id bigint,
  p_admin_signature text,
  p_complete_project boolean DEFAULT true
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_report public.completion_reports;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_admin_signature IS NULL OR btrim(p_admin_signature) = '' THEN
    RAISE EXCEPTION 'Firma del administrador requerida' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_report FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.admin_signature IS NOT NULL AND btrim(v_report.admin_signature) <> '' THEN
    RAISE EXCEPTION 'El informe ya fue firmado' USING ERRCODE = '22023';
  END IF;

  UPDATE public.completion_reports SET
    admin_signature = p_admin_signature,
    status = 'approved',
    updated_at = now()
  WHERE id = p_report_id
  RETURNING * INTO v_report;

  IF p_complete_project THEN
    UPDATE public.projects SET status = 'completed', updated_at = now()
      WHERE id = v_report.project_id;
  END IF;

  RETURN v_report;
END;
$$;

-- Grants: authenticated may call (admin enforced inside); never anon.
REVOKE EXECUTE ON FUNCTION public.approve_pedido(bigint, bigint, real, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reject_pedido(bigint, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.sign_completion_report(bigint, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_pedido(bigint, bigint, real, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_pedido(bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sign_completion_report(bigint, text, boolean) TO authenticated, service_role;
