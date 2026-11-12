-- =====================================================================
-- Migration: phc_rls_role_and_perf_fixes  (version 20260708225908)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- =====================================================
-- PHC: fix admin RLS (no access-token hook exists, so
-- auth.jwt() ->> 'role' never matched 'admin'), wrap auth.uid()/
-- auth.jwt() calls per Supabase perf lint (auth_rls_initplan),
-- and tighten the always-true INSERT policies.
-- =====================================================

-- ---------- profiles ----------
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
CREATE POLICY "Admins can view all profiles"
  ON profiles FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- ---------- projects ----------
DROP POLICY IF EXISTS "Operators can view assigned projects" ON projects;
CREATE POLICY "Operators can view assigned projects"
  ON projects FOR SELECT
  USING ((select auth.uid()) = assigned_operator_id);

DROP POLICY IF EXISTS "Admins can view all projects" ON projects;
CREATE POLICY "Admins can view all projects"
  ON projects FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins can insert projects" ON projects;
CREATE POLICY "Admins can insert projects"
  ON projects FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can update projects" ON projects;
CREATE POLICY "Admins can update projects"
  ON projects FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- drilling_bars ----------
DROP POLICY IF EXISTS "Operators can view own drilling bars" ON drilling_bars;
CREATE POLICY "Operators can view own drilling bars"
  ON drilling_bars FOR SELECT
  USING ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Admins can view all drilling bars" ON drilling_bars;
CREATE POLICY "Admins can view all drilling bars"
  ON drilling_bars FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Operators can insert their drilling bars" ON drilling_bars;
CREATE POLICY "Operators can insert their drilling bars"
  ON drilling_bars FOR INSERT
  WITH CHECK ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Admins can update any drilling bar" ON drilling_bars;
CREATE POLICY "Admins can update any drilling bar"
  ON drilling_bars FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- materials ----------
DROP POLICY IF EXISTS "Only admins can insert materials" ON materials;
CREATE POLICY "Only admins can insert materials"
  ON materials FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Only admins can update materials" ON materials;
CREATE POLICY "Only admins can update materials"
  ON materials FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- material_transactions ----------
DROP POLICY IF EXISTS "Admins can view all transactions" ON material_transactions;
CREATE POLICY "Admins can view all transactions"
  ON material_transactions FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Operators can view own transactions" ON material_transactions;
CREATE POLICY "Operators can view own transactions"
  ON material_transactions FOR SELECT
  USING ((select auth.uid()) = created_by);

DROP POLICY IF EXISTS "Authenticated users can insert transactions" ON material_transactions;
CREATE POLICY "Users can insert own transactions"
  ON material_transactions FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = created_by OR public.is_admin());

-- ---------- project_materials ----------
DROP POLICY IF EXISTS "Operators can view assigned project materials" ON project_materials;
CREATE POLICY "Operators can view assigned project materials"
  ON project_materials FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_materials.project_id
    AND projects.assigned_operator_id = (select auth.uid())
  ));

DROP POLICY IF EXISTS "Admins can view all project materials" ON project_materials;
CREATE POLICY "Admins can view all project materials"
  ON project_materials FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Only admins can manage project materials" ON project_materials;
CREATE POLICY "Only admins can manage project materials"
  ON project_materials FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Only admins can update project materials" ON project_materials;
CREATE POLICY "Only admins can update project materials"
  ON project_materials FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- material_consumption ----------
DROP POLICY IF EXISTS "Operators can view own consumption" ON material_consumption;
CREATE POLICY "Operators can view own consumption"
  ON material_consumption FOR SELECT
  USING ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Admins can view all consumption" ON material_consumption;
CREATE POLICY "Admins can view all consumption"
  ON material_consumption FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Authenticated users can record consumption" ON material_consumption;
CREATE POLICY "Users can record own consumption"
  ON material_consumption FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = operator_id OR public.is_admin());

-- ---------- progress_reports ----------
DROP POLICY IF EXISTS "Operators can view own reports" ON progress_reports;
CREATE POLICY "Operators can view own reports"
  ON progress_reports FOR SELECT
  USING ((select auth.uid()) = reported_by);

DROP POLICY IF EXISTS "Admins can view all reports" ON progress_reports;
CREATE POLICY "Admins can view all reports"
  ON progress_reports FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Operators can submit reports" ON progress_reports;
CREATE POLICY "Operators can submit reports"
  ON progress_reports FOR INSERT
  WITH CHECK ((select auth.uid()) = reported_by);

-- ---------- pedidos ----------
DROP POLICY IF EXISTS "Operators can view own pedidos" ON pedidos;
CREATE POLICY "Operators can view own pedidos"
  ON pedidos FOR SELECT
  USING ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Admins can view all pedidos" ON pedidos;
CREATE POLICY "Admins can view all pedidos"
  ON pedidos FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Operators can create pedidos" ON pedidos;
CREATE POLICY "Operators can create pedidos"
  ON pedidos FOR INSERT
  WITH CHECK ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Only admins can update pedidos status" ON pedidos;
CREATE POLICY "Only admins can update pedidos status"
  ON pedidos FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- completion_reports ----------
DROP POLICY IF EXISTS "Operators can view own completion reports" ON completion_reports;
CREATE POLICY "Operators can view own completion reports"
  ON completion_reports FOR SELECT
  USING ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Admins can view all completion reports" ON completion_reports;
CREATE POLICY "Admins can view all completion reports"
  ON completion_reports FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Operators can submit completion reports" ON completion_reports;
CREATE POLICY "Operators can submit completion reports"
  ON completion_reports FOR INSERT
  WITH CHECK ((select auth.uid()) = operator_id);

DROP POLICY IF EXISTS "Only admins can update completion reports" ON completion_reports;
CREATE POLICY "Only admins can update completion reports"
  ON completion_reports FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- photos ----------
DROP POLICY IF EXISTS "Operators can view own project photos" ON photos;
CREATE POLICY "Operators can view own project photos"
  ON photos FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = photos.project_id
    AND (projects.assigned_operator_id = (select auth.uid()) OR public.is_admin())
  ));

DROP POLICY IF EXISTS "Admins can view all photos" ON photos;
CREATE POLICY "Admins can view all photos"
  ON photos FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Authenticated users can upload photos" ON photos;
CREATE POLICY "Users can upload photos to accessible projects"
  ON photos FOR INSERT
  TO authenticated
  WITH CHECK (
    (select auth.uid()) = uploaded_by
    AND EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = photos.project_id
      AND (projects.assigned_operator_id = (select auth.uid()) OR public.is_admin())
    )
  );

-- ---------- notifications ----------
DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  USING ((select auth.uid()) = user_id);

-- ---------- settings ----------
DROP POLICY IF EXISTS "Only admins can update settings" ON settings;
CREATE POLICY "Only admins can update settings"
  ON settings FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- search_path hardening (function_search_path_mutable lint) ----------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username, email, role, first_name, last_name, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'username', split_part(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'operator'),
    NEW.raw_user_meta_data ->> 'first_name',
    NEW.raw_user_meta_data ->> 'last_name',
    NEW.raw_user_meta_data ->> 'full_name'
  );
  RETURN NEW;
END;
$$;

-- handle_new_user should only ever run via the auth.users trigger, not be
-- callable as a public RPC endpoint.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Supabase-managed event-trigger helper; not meant to be called directly either.
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
