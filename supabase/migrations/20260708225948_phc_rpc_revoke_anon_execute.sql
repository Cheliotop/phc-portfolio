-- =====================================================================
-- Migration: phc_rpc_revoke_anon_execute  (version 20260708225948)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- Supabase grants EXECUTE to anon/authenticated/service_role by default on
-- function creation (via default privileges), independent of PUBLIC grants.
-- Explicitly revoke from anon so unauthenticated callers can't invoke these.
REVOKE ALL ON FUNCTION public.create_drilling_bar(bigint, text, text, real, text, text, text, integer, real, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.assign_material_to_project(bigint, bigint, real, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_material_consumption(bigint, real, bigint, bigint, text, text, date, text) FROM anon;
REVOKE ALL ON FUNCTION public.adjust_material_stock(bigint, real, text) FROM anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM anon;
