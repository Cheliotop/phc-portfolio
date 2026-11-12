-- Handoff audit hardening (2026-07-28).
--
-- 1. A clean `supabase db reset` rebuilt every table with RLS but left the
--    `service_role` without table DML privileges. RLS bypass does not replace
--    ordinary PostgreSQL grants, so all service-backed Edge Functions and the
--    disaster-recovery seed failed before reaching their authorization logic.
-- 2. Both private Storage buckets had NULL server-side MIME/size limits.
-- 3. The phc-reports INSERT policy inspected server-managed object metadata.
--    Storage authorizes the initial INSERT before populating that metadata, so
--    every valid PDF/attachment upload failed with SQLSTATE 42501. The photo
--    policy already removed the same broken check in migration 20260713214048.

-- The service role is server-only and must be able to operate through the Data
-- API. Keep anon ungranted; authenticated access remains the explicit, narrow
-- allow-list plus RLS from the Product Plan migrations.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;

-- Defense in depth for the implementation schema. These functions are called
-- only by triggers or the authenticated public wrappers; the schema is not
-- exposed, and no client role should inherit PostgreSQL's default EXECUTE.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Project measurements are required to be positive by every creation form,
-- but the table previously enforced finiteness only. Protect direct Data API
-- writes and older clients too. NOT VALID keeps this forward-only migration
-- deployable if an old production row is dirty; new/updated rows are still
-- checked. Clean installations validate immediately.
ALTER TABLE public.projects
  ADD CONSTRAINT projects_target_depth_positive
  CHECK (target_depth IS NULL OR target_depth > 0) NOT VALID;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_default_bar_length_positive
  CHECK (default_bar_length IS NULL OR default_bar_length > 0) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE target_depth IS NOT NULL AND target_depth <= 0
  ) THEN
    ALTER TABLE public.projects VALIDATE CONSTRAINT projects_target_depth_positive;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE default_bar_length IS NOT NULL AND default_bar_length <= 0
  ) THEN
    ALTER TABLE public.projects VALIDATE CONSTRAINT projects_default_bar_length_positive;
  END IF;
END;
$$;

-- Storage enforces these limits before accepting object data. Row policies
-- remain responsible for bucket/path/project/role checks.
UPDATE storage.buckets
SET public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
WHERE id = 'phc-photos';

UPDATE storage.buckets
SET public = false,
    file_size_limit = 20971520,
    allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]
WHERE id = 'phc-reports';

DROP POLICY IF EXISTS "Authorized users upload constrained reports and attachments"
ON storage.objects;

CREATE POLICY "Authorized users upload constrained reports and attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-reports'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = public.storage_project_id(objects.name)
  )
  AND (
    (
      COALESCE((storage.foldername(objects.name))[2], '') = 'attachments'
      AND public.is_admin()
      AND objects.name ~ '^[1-9][0-9]*/attachments/[^/]+\.(pdf|jpg|jpeg|png)$'
    )
    OR (
      COALESCE((storage.foldername(objects.name))[2], '') <> 'attachments'
      AND objects.name ~ '^[1-9][0-9]*/[^/]+\.pdf$'
      AND (
        public.is_admin()
        OR (
          EXISTS (
            SELECT 1
            FROM public.projects p
            WHERE p.id = public.storage_project_id(objects.name)
              AND public.project_status_key(p.status) IN ('active', 'closure_submitted')
          )
          AND (
            public.is_project_operator(public.storage_project_id(objects.name))
            OR public.is_closing_operator(public.storage_project_id(objects.name))
          )
        )
      )
    )
  )
);
