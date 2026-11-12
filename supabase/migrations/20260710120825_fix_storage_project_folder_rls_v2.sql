-- v1 of this fix (fix_storage_project_folder_rls) still had the same bug:
-- it wrote bare `name` inside `EXISTS (SELECT 1 FROM public.projects WHERE
-- ...)`, and since public.projects ALSO has a `name` column, Postgres
-- resolved the bare reference to the inner projects.name again, not the
-- outer storage.objects row being checked. Explicitly qualifying as
-- `objects.name` fixes the ambiguity for real -- verified by re-reading
-- pg_policies after applying, not just trusting a success response.

DROP POLICY IF EXISTS "Assigned operators and admins can upload project photos" ON storage.objects;
CREATE POLICY "Assigned operators and admins can upload project photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-photos'
  AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects
      WHERE (projects.id)::text = (storage.foldername(objects.name))[1]
      AND projects.assigned_operator_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Assigned operators and admins can read project photos" ON storage.objects;
CREATE POLICY "Assigned operators and admins can read project photos"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'phc-photos'
  AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects
      WHERE (projects.id)::text = (storage.foldername(objects.name))[1]
      AND projects.assigned_operator_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Assigned operators and admins can upload report PDFs" ON storage.objects;
CREATE POLICY "Assigned operators and admins can upload report PDFs"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-reports'
  AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects
      WHERE (projects.id)::text = (storage.foldername(objects.name))[1]
      AND projects.assigned_operator_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Assigned operators and admins can read report PDFs" ON storage.objects;
CREATE POLICY "Assigned operators and admins can read report PDFs"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'phc-reports'
  AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects
      WHERE (projects.id)::text = (storage.foldername(objects.name))[1]
      AND projects.assigned_operator_id = auth.uid()
    )
  )
);
