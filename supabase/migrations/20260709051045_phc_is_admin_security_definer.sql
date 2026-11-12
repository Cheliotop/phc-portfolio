-- =====================================================================
-- Migration: phc_is_admin_security_definer  (version 20260709051045)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- Pass 1.5 follow-up: is_admin() was SECURITY INVOKER, so evaluating the
-- profiles policies that call it re-applied RLS on profiles, which calls
-- is_admin() again -> infinite recursion / stack depth exceeded on any
-- SELECT of profiles by an authenticated user (this would have broken the
-- app's own login profile fetch). SECURITY DEFINER makes its internal
-- SELECT run as the function owner (bypasses RLS on profiles) and prevents
-- SQL inlining, breaking the recursion. Behavior is unchanged: it still
-- just answers "is the calling JWT's user an admin?".
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

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
