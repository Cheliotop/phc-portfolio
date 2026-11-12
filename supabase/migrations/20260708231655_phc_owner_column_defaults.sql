-- =====================================================================
-- Migration: phc_owner_column_defaults  (version 20260708231655)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- Every one of these owner-identifying columns was being left for the client
-- to set explicitly. In practice several call sites never set it at all
-- (completion_reports.operator_id, pedidos.operator_id, photos.uploaded_by),
-- which either violates NOT NULL or now fails the RLS WITH CHECK that
-- compares it to auth.uid(). Defaulting to auth.uid() server-side means the
-- client never has to (and can't spoof) another user's id here.
ALTER TABLE public.drilling_bars ALTER COLUMN operator_id SET DEFAULT auth.uid();
ALTER TABLE public.completion_reports ALTER COLUMN operator_id SET DEFAULT auth.uid();
ALTER TABLE public.pedidos ALTER COLUMN operator_id SET DEFAULT auth.uid();
ALTER TABLE public.photos ALTER COLUMN uploaded_by SET DEFAULT auth.uid();
ALTER TABLE public.progress_reports ALTER COLUMN reported_by SET DEFAULT auth.uid();
ALTER TABLE public.material_consumption ALTER COLUMN operator_id SET DEFAULT auth.uid();
ALTER TABLE public.material_transactions ALTER COLUMN created_by SET DEFAULT auth.uid();
ALTER TABLE public.projects ALTER COLUMN created_by SET DEFAULT auth.uid();
