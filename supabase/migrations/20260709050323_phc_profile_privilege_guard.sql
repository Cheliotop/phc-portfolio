-- =====================================================================
-- Migration: phc_profile_privilege_guard  (version 20260709050323)
-- Status: ALREADY APPLIED to the live project portfolio-project on
--         2026-07-09 via the Supabase management API. This file is the
--         committed copy for repo/history purposes — do NOT re-run it
--         blindly on the live DB (it is idempotent, but there is no need).
--         For a fresh environment: run 01_schema.sql, 02_rls_policies.sql,
--         then the migrations in supabase/migrations/ in version order.
--
-- Purpose (Pass 1.5 security fixes):
--   (1) Privilege escalation: "Users can update own profile" RLS allowed
--       updating ANY column of one's own profiles row, including `role`,
--       which is_admin() reads. An operator could self-promote to admin.
--   (2) handle_new_user() copied `role` from client-controlled signup
--       metadata: anyone with the anon key could sign up as an admin.
--   (3) There was no legitimate admin path to update other profiles, so
--       activate/deactivate could not be a real server-side control.
-- =====================================================================

-- 1. Self-signup can NEVER choose its own role. Always 'operator'.
--    Admin accounts are created/promoted only by the project owner via
--    the Supabase dashboard / SQL editor (service-role context).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
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
    'operator',  -- hardened: ignore raw_user_meta_data->>'role'
    NEW.raw_user_meta_data ->> 'first_name',
    NEW.raw_user_meta_data ->> 'last_name',
    NEW.raw_user_meta_data ->> 'full_name'
  );
  RETURN NEW;
END;
$$;

-- 2. Trigger guard: protected columns on profiles (role, is_active, id,
--    email) can only be changed by an admin (for OTHER users) or by a
--    service-role/SQL-editor context (auth.uid() IS NULL). Admins cannot
--    change their OWN role/is_active (lockout guard). Regular users can
--    still update harmless own-profile fields (name, phone, avatar...).
CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_privileged_change boolean :=
    NEW.role IS DISTINCT FROM OLD.role
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.email IS DISTINCT FROM OLD.email;
BEGIN
  IF NOT v_privileged_change THEN
    RETURN NEW;
  END IF;

  -- Service role / dashboard SQL editor: no JWT subject -> allowed.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Non-admins may never touch protected columns.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'No autorizado: solo un administrador puede cambiar rol o estado de activacion'
      USING ERRCODE = '42501';
  END IF;

  -- Admins may not change their OWN role/activation (lockout guard).
  IF OLD.id = v_uid THEN
    RAISE EXCEPTION 'Un administrador no puede cambiar su propio rol o estado de activacion'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profiles_privileged ON public.profiles;
CREATE TRIGGER protect_profiles_privileged
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_columns();

-- 3. Admins need a real UPDATE path on other users' profiles
--    (activate/deactivate). Column-level safety comes from the trigger.
DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
