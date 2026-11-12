-- Supabase Storage authorizes an object INSERT before its server-managed
-- metadata has been populated. MIME type and file-size limits are enforced by
-- the private phc-photos bucket configuration instead; keeping those checks in
-- this row policy rejects every otherwise-valid upload.

DROP POLICY IF EXISTS "Active operators and admins upload constrained project photos"
ON storage.objects;

CREATE POLICY "Active operators and admins upload constrained project photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-photos'
  AND objects.name ~ '^[1-9][0-9]*/[^/]+\.(jpg|jpeg|png|webp)$'
  AND public.storage_project_id(objects.name) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = public.storage_project_id(objects.name)
      AND public.project_status_key(p.status) = 'active'
  )
  AND (
    public.is_admin()
    OR public.is_project_operator(public.storage_project_id(objects.name))
  )
);
