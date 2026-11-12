-- =====================================================================
-- Migration: phc_reports_storage_bucket  (version 20260708231611)
-- Reconstructed 2026-07-10 from live project portfolio-project's
-- supabase_migrations.schema_migrations table (source of truth). This
-- file was missing or version-mismatched in the local repo prior to
-- this reconciliation; the SQL below is exactly what is recorded as
-- applied to remote for this migration (statements column, joined).
-- =====================================================================

-- New private bucket for generated completion-report PDFs (mirrors phc-photos).
-- Objects are stored as "<project_id>/completion_<...>.pdf" so we can scope
-- access the same way: assigned operator on that project, or admin.
INSERT INTO storage.buckets (id, name, public)
VALUES ('phc-reports', 'phc-reports', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Assigned operators and admins can read report PDFs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'phc-reports'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.projects
        WHERE projects.id::text = (storage.foldername(name))[1]
        AND projects.assigned_operator_id = (select auth.uid())
      )
    )
  );

CREATE POLICY "Assigned operators and admins can upload report PDFs"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'phc-reports'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.projects
        WHERE projects.id::text = (storage.foldername(name))[1]
        AND projects.assigned_operator_id = (select auth.uid())
      )
    )
  );

-- Admin re-uploads the signed version after signature, so allow overwrite there.
CREATE POLICY "Admins can update report PDFs"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'phc-reports' AND public.is_admin())
  WITH CHECK (bucket_id = 'phc-reports' AND public.is_admin());

CREATE POLICY "Only admins can delete report PDFs"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'phc-reports' AND public.is_admin());
