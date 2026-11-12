-- =====================================================
-- PHC Supabase RLS Policies
-- Run this AFTER the schema (01_schema.sql), then apply the files in
-- supabase/migrations/ in version order.
--
-- REWRITTEN 2026-07-09 (Pass 1.5) to match the LIVE database.
-- The previous version of this file used `auth.jwt() ->> 'role' = 'admin'`,
-- which is ALWAYS FALSE in this project (no custom access token hook is
-- configured, so the JWT `role` claim is 'authenticated', never 'admin').
-- Running that old file would have silently removed all admin access.
-- All admin checks MUST go through public.is_admin(), which reads
-- profiles.role. See docs/PHC_SUPABASE_MIGRATION_PLAN_2026-07-08.md.
-- =====================================================

-- Admin check helper. profiles.role is protected against self-service
-- changes by the protect_profiles_privileged trigger (see
-- migrations/20260709050323_phc_profile_privilege_guard.sql).
-- MUST be SECURITY DEFINER: the profiles policies call is_admin(), and a
-- SECURITY INVOKER version re-applies profiles RLS inside itself ->
-- infinite recursion ("stack depth limit exceeded") on ANY profiles query
-- by an authenticated user (see migrations/..._phc_is_admin_security_definer.sql).
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- 1. PROFILES RLS
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING ((SELECT auth.uid()) = id);

CREATE POLICY "Admins can view all profiles"
  ON profiles FOR SELECT
  USING (public.is_admin());

-- Column-level protection (role, is_active, id, email) is enforced by the
-- protect_profiles_privileged BEFORE UPDATE trigger, not by these policies.
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "Admins can update any profile"
  ON profiles FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 2. PROJECTS RLS
CREATE POLICY "Operators can view assigned projects"
  ON projects FOR SELECT
  USING ((SELECT auth.uid()) = assigned_operator_id);

CREATE POLICY "Admins can view all projects"
  ON projects FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins can insert projects"
  ON projects FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update projects"
  ON projects FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 3. DRILLING BARS RLS
CREATE POLICY "Operators can view own drilling bars"
  ON drilling_bars FOR SELECT
  USING ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Admins can view all drilling bars"
  ON drilling_bars FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Operators can insert their drilling bars"
  ON drilling_bars FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Admins can update any drilling bar"
  ON drilling_bars FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 4. MATERIALS RLS
CREATE POLICY "Everyone can view materials"
  ON materials FOR SELECT
  TO authenticated
  USING (TRUE);

CREATE POLICY "Only admins can insert materials"
  ON materials FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "Only admins can update materials"
  ON materials FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 5. MATERIAL TRANSACTIONS RLS
CREATE POLICY "Admins can view all transactions"
  ON material_transactions FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Operators can view own transactions"
  ON material_transactions FOR SELECT
  USING ((SELECT auth.uid()) = created_by);

CREATE POLICY "Users can insert own transactions"
  ON material_transactions FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = created_by OR public.is_admin());

-- 6. PROJECT MATERIALS RLS
CREATE POLICY "Operators can view assigned project materials"
  ON project_materials FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_materials.project_id
    AND projects.assigned_operator_id = (SELECT auth.uid())
  ));

CREATE POLICY "Admins can view all project materials"
  ON project_materials FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Only admins can manage project materials"
  ON project_materials FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "Only admins can update project materials"
  ON project_materials FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 7. MATERIAL CONSUMPTION RLS
CREATE POLICY "Operators can view own consumption"
  ON material_consumption FOR SELECT
  USING ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Admins can view all consumption"
  ON material_consumption FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Users can record own consumption"
  ON material_consumption FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = operator_id OR public.is_admin());

-- 8. PROGRESS REPORTS RLS
CREATE POLICY "Operators can view own reports"
  ON progress_reports FOR SELECT
  USING ((SELECT auth.uid()) = reported_by);

CREATE POLICY "Admins can view all reports"
  ON progress_reports FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Operators can submit reports"
  ON progress_reports FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = reported_by);

-- 9. PEDIDOS RLS
CREATE POLICY "Operators can view own pedidos"
  ON pedidos FOR SELECT
  USING ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Admins can view all pedidos"
  ON pedidos FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Operators can create pedidos"
  ON pedidos FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Only admins can update pedidos status"
  ON pedidos FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 10. COMPLETION REPORTS RLS
CREATE POLICY "Operators can view own completion reports"
  ON completion_reports FOR SELECT
  USING ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Admins can view all completion reports"
  ON completion_reports FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Operators can submit completion reports"
  ON completion_reports FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = operator_id);

CREATE POLICY "Only admins can update completion reports"
  ON completion_reports FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 11. PHOTOS RLS
CREATE POLICY "Operators can view own project photos"
  ON photos FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = photos.project_id
    AND (projects.assigned_operator_id = (SELECT auth.uid()) OR public.is_admin())
  ));

CREATE POLICY "Admins can view all photos"
  ON photos FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Users can upload photos to accessible projects"
  ON photos FOR INSERT
  WITH CHECK (
    (SELECT auth.uid()) = uploaded_by
    AND EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = photos.project_id
      AND (projects.assigned_operator_id = (SELECT auth.uid()) OR public.is_admin())
    )
  );

-- 12. NOTIFICATIONS RLS
CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

-- 13. SETTINGS RLS
CREATE POLICY "Authenticated users can view settings"
  ON settings FOR SELECT
  TO authenticated
  USING (TRUE);

CREATE POLICY "Only admins can update settings"
  ON settings FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- =====================
-- AUTO-CREATE PROFILE ON SIGNUP
-- Hardened (Pass 1.5): role is ALWAYS 'operator' for self-signups —
-- raw_user_meta_data->>'role' is deliberately ignored so nobody can sign
-- up as admin with the anon key. Admins are promoted by the project owner
-- via the Supabase dashboard/SQL editor.
-- =====================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (id, username, email, role, first_name, last_name, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'username', split_part(NEW.email, '@', 1)),
    NEW.email,
    'operator',
    NEW.raw_user_meta_data ->> 'first_name',
    NEW.raw_user_meta_data ->> 'last_name',
    NEW.raw_user_meta_data ->> 'full_name'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
