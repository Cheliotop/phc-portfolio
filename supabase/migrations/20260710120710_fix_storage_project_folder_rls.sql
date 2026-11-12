-- Fix broken RLS policies on storage.objects: the project-folder check
-- referenced storage.foldername(projects.name) (the project's NAME string)
-- instead of storage.foldername(name) (the actual uploaded object's own
-- path, whose first folder segment is the project id, per the client's
-- upload convention `${projectId}/${filename}`). Project names contain no
-- "/" characters, so foldername(projects.name) was always NULL and this
-- EXISTS clause was always false for every operator -- only the separate
-- is_admin() branch ever let uploads/reads through. Found via live device
-- testing 2026-07-10: a real operator's photo upload failed "new row
-- violates row-level security policy" while an identical admin call
-- succeeded.
--
-- NOTE: this version still had the bug -- see the _v2 migration immediately
-- following it, which corrects a second, subtler instance of the same
-- ambiguous-column-name issue this migration introduces.

DROP POLICY IF EXISTS "Assigned operators and admins can upload project photos" ON storage.objects;
CREATE POLICY "Assigned operators and admins can upload project photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'phc-photos'
  AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects
      WHERE (projects.id)::text = (storage.foldername(name))[1]
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
      WHERE (projects.id)::text = (storage.foldername(name))[1]
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
      WHERE (projects.id)::text = (storage.foldername(name))[1]
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
      WHERE (projects.id)::text = (storage.foldername(name))[1]
      AND projects.assigned_operator_id = auth.uid()
    )
  )
);
