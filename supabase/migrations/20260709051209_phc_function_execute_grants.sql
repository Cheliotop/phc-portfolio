-- =====================================================================
-- Migration: phc_function_execute_grants  (version 20260709051209)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- Pass 1.5 cleanup: tighten EXECUTE grants flagged by the security advisor.
-- is_admin(): needed via RPC by authenticated users (Edge Function role
-- check) but not by anon. protect_profile_privileged_columns(): a trigger
-- function that should never be callable via /rest/v1/rpc at all — triggers
-- fire regardless of EXECUTE privileges.
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.protect_profile_privileged_columns() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
