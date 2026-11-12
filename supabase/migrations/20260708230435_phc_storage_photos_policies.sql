-- =====================================================================
-- Migration: phc_storage_photos_policies  (version 20260708230435)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- =====================================================
-- phc-photos storage policies
-- Bucket is private (public=false) but had zero storage.objects
-- policies, so uploads/reads were failing for every real user
-- (only service_role could touch it). Objects are uploaded as
-- "<project_id>/<timestamp>_<filename>" (see supabase-photos.ts),
-- so we scope access using the first path segment as the project id.
-- =====================================================

CREATE POLICY "Assigned operators and admins can read project photos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'phc-photos'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.projects
        WHERE projects.id::text = (storage.foldername(name))[1]
        AND projects.assigned_operator_id = (select auth.uid())
      )
    )
  );

CREATE POLICY "Assigned operators and admins can upload project photos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'phc-photos'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.projects
        WHERE projects.id::text = (storage.foldername(name))[1]
        AND projects.assigned_operator_id = (select auth.uid())
      )
    )
  );

CREATE POLICY "Only admins can delete project photos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'phc-photos' AND public.is_admin());
