-- =====================================================================
-- Migration: phc_is_admin_security_definer
-- Status: ALREADY APPLIED to live project portfolio-project (2026-07-09).
--
-- Bug found while verifying the Pass 1.5 privilege guard:
-- is_admin() was SECURITY INVOKER. The profiles RLS policies call
-- is_admin(), and its internal SELECT on profiles re-applied those same
-- policies -> infinite recursion ("stack depth limit exceeded", 54001) on
-- ANY SELECT/UPDATE of profiles by an `authenticated` user. This would
-- have broken the app's own login profile fetch for every user.
--
-- Fix: SECURITY DEFINER — the internal SELECT runs as the function owner
-- (bypasses RLS on profiles) and the function is no longer inlined, which
-- breaks the recursion. Semantics unchanged.
-- =====================================================================
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
