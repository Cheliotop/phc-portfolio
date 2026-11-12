-- =====================================================================
-- Migration: phc_secondary_operators  (version 20260725160000)
--
-- Fixes W-5, the top blocker from the 2026-07-25 audit: PHC crews share a
-- rig, but a well could only ever have ONE operator. Everything the second
-- man did was either unrecorded or attributed to the first, so drilling
-- bars, shifts and photos all credited the whole rig to one person and
-- accountability, payroll and safety records pointed at the wrong operator.
--
-- The field structure is a HIERARCHY, not a partnership: a responsible
-- operator and their subcontractor. So this is additive rather than a
-- rewrite --
--
--   projects.assigned_operator_id  stays exactly as it is and now means
--                                  the RESPONSIBLE (primary) operator
--   project_secondary_operators    new: the subcontractor(s) on that well
--
-- is_project_operator() deliberately KEEPS its current meaning (primary
-- only) so every restricted path continues to work untouched. A new
-- is_project_team_member() means "primary OR secondary", and only the
-- paths a subcontractor should reach are switched to it.
--
-- WHAT THE SUBCONTRACTOR CAN DO
--   see the well, its materials, its bars, consumption, samples, photos
--   run their own shifts, log drilling bars, record consumption,
--   register water samples, upload photos, confirm handovers
--
-- WHAT THEY CANNOT DO
--   create pedidos, or confirm pedido receipts. Orders must come from one
--   place: if both men could order, the same material gets requested twice
--   and the admin has to work out which request is the duplicate.
--   They can still SEE pedidos -- visibility is what stops a second man
--   asking for something already on its way.
--
--   submit the ficha tecnica / close the well. That stays with the
--   responsible operator and the separately-assigned closing operator.
--
-- IMPLEMENTATION NOTE
-- The policy and function rewrites below are done PROGRAMMATICALLY: each
-- existing definition is read back and one token is replaced. Nothing is
-- retyped. This matters most for the photos INSERT policy, which carries
-- legacy date windows and evidence-kind branches that must survive the
-- change byte for byte.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The subcontractor assignment table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_secondary_operators (
  project_id   bigint      NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  operator_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, operator_id)
);

COMMENT ON TABLE public.project_secondary_operators IS
  'Subcontractor operators on a well. The responsible operator remains '
  'projects.assigned_operator_id. Secondaries may log field work but not '
  'create pedidos or close the well.';

-- A subcontractor cannot also be the responsible operator for the same
-- well -- that would silently duplicate rights and confuse attribution.
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
    RAISE EXCEPTION 'Ese operador ya es el responsable del pozo; no puede ser tambien subcontratista'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS reject_secondary_equals_primary ON public.project_secondary_operators;
CREATE TRIGGER reject_secondary_equals_primary
  BEFORE INSERT OR UPDATE ON public.project_secondary_operators
  FOR EACH ROW EXECUTE FUNCTION private.reject_secondary_equals_primary();

ALTER TABLE public.project_secondary_operators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage secondary operators" ON public.project_secondary_operators;
CREATE POLICY "Admins manage secondary operators"
  ON public.project_secondary_operators FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Team members read secondary assignments" ON public.project_secondary_operators;
CREATE POLICY "Team members read secondary assignments"
  ON public.project_secondary_operators FOR SELECT
  TO authenticated
  USING (
    public.is_active_user()
    AND (
      operator_id = (SELECT auth.uid())
      OR public.is_project_operator(project_id)
    )
  );

-- ---------------------------------------------------------------------
-- 2. Membership helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_project_secondary_operator(p_project_id bigint)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $function$
  SELECT public.is_active_user() AND EXISTS (
    SELECT 1
      FROM public.project_secondary_operators s
     WHERE s.project_id = p_project_id
       AND s.operator_id = (SELECT auth.uid())
  );
$function$;

-- Primary OR subcontractor. Used only on the paths a subcontractor should
-- reach; is_project_operator() still means the responsible operator alone.
CREATE OR REPLACE FUNCTION public.is_project_team_member(p_project_id bigint)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $function$
  SELECT public.is_project_operator(p_project_id)
      OR public.is_project_secondary_operator(p_project_id);
$function$;

-- ---------------------------------------------------------------------
-- 3. Widen the permissive policies, mechanically
-- ---------------------------------------------------------------------
DO $swap_policies$
DECLARE
  r        record;
  v_qual   text;
  v_check  text;
  v_sql    text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, qual, with_check, roles
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (tablename, policyname) IN (
         ('drilling_bars',        'Project operators view project bars'),
         ('material_consumption', 'Project operators view project consumption'),
         ('photos',               'Active operators view own project photos'),
         ('photos',               'Active project operators upload photo metadata'),
         ('project_materials',    'Active operators view assigned project materials'),
         ('water_samples',        'Operators read project water samples')
       )
  LOOP
    v_qual  := replace(COALESCE(r.qual, ''),       'is_project_operator(', 'is_project_team_member(');
    v_check := replace(COALESCE(r.with_check, ''), 'is_project_operator(', 'is_project_team_member(');

    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);

    v_sql := format('CREATE POLICY %I ON public.%I FOR %s TO %s',
                    r.policyname, r.tablename, r.cmd,
                    array_to_string(r.roles, ', '));
    IF v_qual <> '' THEN
      v_sql := v_sql || format(' USING (%s)', v_qual);
    END IF;
    IF v_check <> '' THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', v_check);
    END IF;
    EXECUTE v_sql;
  END LOOP;
END;
$swap_policies$;

-- projects SELECT keys off assigned_operator_id directly rather than the
-- helper, so it needs its own clause.
DROP POLICY IF EXISTS "Active operators view assigned projects" ON public.projects;
CREATE POLICY "Active operators view assigned projects"
  ON public.projects FOR SELECT
  TO authenticated
  USING (
    public.is_active_user()
    AND (
      assigned_operator_id = (SELECT auth.uid())
      OR public.is_project_secondary_operator(id)
    )
  );

-- ---------------------------------------------------------------------
-- 4. Widen the field-work RPCs, mechanically
--
-- Deliberately EXCLUDED, so they stay responsible-operator-only:
--   create_pedido_v2 (+impl)             pedidos come from one place
--   confirm_pedido_item_receipt (+impl)  two confirmers could double-count
--   sign/submit/resubmit completion       closure stays with the closer
-- ---------------------------------------------------------------------
DO $swap_functions$
DECLARE
  r     record;
  v_def text;
BEGIN
  FOR r IN
    SELECT p.oid, n.nspname, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prokind = 'f'
       AND (n.nspname, p.proname) IN (
         ('public',  'start_shift'),
         ('private', 'start_shift_20260712_impl'),
         ('public',  'create_drilling_bar'),
         ('private', 'create_drilling_bar_20260712_impl'),
         ('public',  'record_material_consumption'),
         ('private', 'record_material_consumption_20260712_impl'),
         ('public',  'register_water_sample'),
         ('private', 'register_water_sample_20260712_impl')
       )
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(v_def, 'public.is_project_operator(', 'public.is_project_team_member(');
    EXECUTE v_def;
  END LOOP;
END;
$swap_functions$;

GRANT SELECT ON public.project_secondary_operators TO authenticated;
