-- Remove the expired legacy branch from the photo upload policy.
--
-- The policy carried a hard-coded deadline:
--
--     (evidence_kind = 'field' AND shift_id IS NULL
--      AND now() < '2026-08-01 00:00:00+00'
--      AND EXISTS (SELECT 1 FROM projects WHERE created_at < '2026-07-11 10:29:30+00'))
--
-- a grace window letting pre-product-plan wells upload field photos with no
-- shift attached. It expired at midnight UTC on 2026-08-01 and is now
-- unreachable twice over: the date has passed and cannot come back, and the
-- projects it named do not exist.
--
--     legacy_projects              0
--     field photos with no shift   0
--
-- So this removes behaviour from nothing. It is worth doing anyway. A date
-- literal inside a live RLS policy is a trap for whoever reads it next: it
-- looks load-bearing, it cannot be reasoned about without querying the data it
-- refers to, and it silently changed what the system accepted at a moment
-- nobody chose. This one went off during field testing hours after it expired,
-- and cost real time ruling it out as the cause of a rejected write.
--
-- What remains is the rule as it actually stands, in two readable branches:
-- a water-sample photo carries no shift, and a field photo belongs to the
-- uploader's own recent shift.

DROP POLICY IF EXISTS "Active project operators upload photo metadata" ON public.photos;
CREATE POLICY "Active project operators upload photo metadata"
  ON public.photos
  FOR INSERT
  TO authenticated
  WITH CHECK (
    uploaded_by = (SELECT auth.uid())
    AND public.is_project_team_member(project_id)

    -- The stored object must already exist, and live under this project's
    -- prefix, so metadata can never point at another well's evidence.
    AND storage_path LIKE ((project_id)::text || '/%')
    AND EXISTS (
      SELECT 1 FROM storage.objects o
       WHERE o.bucket_id = 'phc-photos'
         AND o.name = photos.storage_path
    )

    AND (
      -- A water-sample photo documents the bottle, not a moment in a shift.
      (evidence_kind = 'water_sample' AND shift_id IS NULL)

      -- A field photo is evidence from a shift, so it must name one, and it
      -- must be the uploader's own and recent. This is also what makes the id
      -- correctness load-bearing: the mobile sync must send the SERVER shift
      -- id, because a local one matches nothing here and the write is refused.
      OR (
        evidence_kind = 'field'
        AND shift_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.shifts s
           WHERE s.id = photos.shift_id
             AND s.project_id = photos.project_id
             AND s.operator_id = (SELECT auth.uid())
             AND s.status = ANY (ARRAY['open', 'report_pending', 'closed'])
             AND s.started_at > (now() - interval '7 days')
        )
      )
    )

    AND EXISTS (
      SELECT 1 FROM public.projects p
       WHERE p.id = photos.project_id
         AND public.project_status_key(p.status) = 'active'
    )
  );
