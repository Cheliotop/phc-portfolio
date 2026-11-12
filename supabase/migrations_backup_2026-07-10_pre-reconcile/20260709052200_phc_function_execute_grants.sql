-- =====================================================================
-- Migration: phc_function_execute_grants
-- Status: ALREADY APPLIED to live project portfolio-project (2026-07-09).
--
-- Tighten EXECUTE grants flagged by the Supabase security advisor after
-- the Pass 1.5 changes:
--  - is_admin(): callable by authenticated (needed: app + Edge Function
--    role checks) but NOT by anon / PUBLIC.
--  - protect_profile_privileged_columns(), handle_new_user(): trigger
--    functions; never callable via /rest/v1/rpc by any client role.
--    Triggers fire regardless of EXECUTE privileges.
-- =====================================================================
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.protect_profile_privileged_columns() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
