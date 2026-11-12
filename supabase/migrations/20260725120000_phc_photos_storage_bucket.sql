-- =====================================================================
-- Migration: phc_photos_storage_bucket  (version 20260725120000)
--
-- Fixes a rebuild-blocking gap found in the 2026-07-25 audit.
--
-- The 'phc-photos' bucket has THREE migrations defining RLS policies
-- against it:
--   20260708230435_phc_storage_photos_policies.sql
--   20260710120825_fix_storage_project_folder_rls_v2.sql
--   20260713214048_fix_photo_storage_insert_policy.sql
-- ...but no migration ever CREATED the bucket. It exists on the live
-- project only because it was made by hand in the dashboard, which is
-- also why 20260708231611 could describe itself as "mirrors phc-photos"
-- while phc-photos had no migration of its own.
--
-- Consequence before this fix: any environment rebuilt from migrations
-- (local, staging, disaster recovery) had no phc-photos bucket, so every
-- photo upload failed with "Bucket not found" -- water-sample bottle
-- photos, ProgresoTab photos, shift-handover photo_path and project
-- attachments. Production kept working because of the manual bucket,
-- which is precisely what kept this invisible.
--
-- Same class as the 2026-07-20 finding ("13 core tables created outside
-- migrations"); that pass covered tables and missed storage buckets.
--
-- Idempotent: ON CONFLICT DO NOTHING, so this is a no-op against the
-- live project where the bucket already exists. Policies are NOT
-- recreated here -- they already ship in the three migrations above.
-- =====================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('phc-photos', 'phc-photos', false)
ON CONFLICT (id) DO NOTHING;
