-- Complete the crew-handoff continuity set.
--
-- material_consumption was the one evidence table left without an
-- is_project_operator SELECT policy (drilling_bars, water_samples,
-- project_materials, and Empresa pedidos all got one in 20260717205309 /
-- 20260717164828). After a crew handoff the incoming operator saw the correct
-- project_materials stock but an EMPTY "recent usage" list (RLS scoped it to
-- their own rows), misleading them about the well's real burn rate.
--
-- Mirror the sibling tables: the current assigned operator reads the whole
-- well's consumption, read-only, with every row keeping its original operator
-- attribution. Own + closing-operator + admin policies are unchanged.
DROP POLICY IF EXISTS "Project operators view project consumption" ON public.material_consumption;
CREATE POLICY "Project operators view project consumption"
  ON public.material_consumption FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_project_operator(project_id));
