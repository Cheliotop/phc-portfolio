-- Regression checks for 20261109130000_phc_rejected_work_guard.sql.
-- LOCAL stack only, after seed-local.js. Everything runs in one transaction
-- and is rolled back, so it leaves no rows behind.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -f supabase/seed/rejected-work-guard.sql
--
-- Prints one PASS/FAIL line per check.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o /dev/null
BEGIN;

CREATE TEMP TABLE results (check_name text, passed boolean) ON COMMIT DROP;
GRANT ALL ON results TO authenticated;

SELECT p.id AS project_id, p.assigned_operator_id AS operator_id
FROM public.projects p
JOIN public.profiles owner ON owner.id = p.assigned_operator_id AND owner.is_active
WHERE public.project_status_key(p.status) = 'active'
ORDER BY p.id LIMIT 1 \gset
SELECT COALESCE(
  -- Another well the operator has no link to.
  (SELECT p.id FROM public.projects p
   WHERE p.id <> :project_id
     AND p.assigned_operator_id IS DISTINCT FROM :'operator_id'
     AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.project_id = p.id AND s.operator_id = :'operator_id')
     AND NOT EXISTS (SELECT 1 FROM public.project_secondary_operators o WHERE o.project_id = p.id AND o.operator_id = :'operator_id')
   ORDER BY p.id LIMIT 1),
  :project_id + 1
) AS other_project_id \gset
SELECT id AS admin_id FROM public.profiles
WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1 \gset
SELECT id AS next_id FROM public.profiles
WHERE role = 'operator' AND is_active AND id <> :'operator_id'
ORDER BY created_at LIMIT 1 \gset
SELECT id AS removed_id FROM public.profiles
WHERE role = 'operator' AND is_active AND id NOT IN (:'operator_id', :'next_id')
  AND NOT EXISTS (
    SELECT 1 FROM public.project_secondary_operators s
    WHERE s.project_id = :project_id AND s.operator_id = profiles.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.project_id = :project_id AND s.operator_id = profiles.id
  )
ORDER BY created_at LIMIT 1 \gset

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.act_as_owner() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
CREATE FUNCTION pg_temp.try_report(
  p_key text, p_owner uuid, p_entity text, p_payload jsonb
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.report_rejected_work(
    p_key, p_owner, p_entity, 'local-guard', 'UPSERT', p_payload, 'denied (42501)', now()
  );
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
CREATE FUNCTION pg_temp.try_decide(p_id bigint) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.decide_rejected_work(p_id, 'accepted', NULL);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO results SELECT 'anon cannot report rejected work',
  NOT has_function_privilege('anon', 'public.report_rejected_work(text, uuid, text, text, text, jsonb, text, timestamptz)', 'EXECUTE');
INSERT INTO results SELECT 'clients cannot apply rejected work directly',
  NOT has_function_privilege('authenticated', 'private.apply_rejected_work(public.rejected_work_reports)', 'EXECUTE');

-- B1: a deactivated operator's own work still reaches review.
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = false WHERE id = :'operator_id';
SELECT pg_temp.act_as(:'operator_id');
SELECT pg_temp.try_report('guard-deactivated', :'operator_id', 'drilling_bar',
  jsonb_build_object('project_id', :project_id)) AS deactivated_result \gset
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = true WHERE id = :'operator_id';
INSERT INTO results SELECT 'a deactivated operator can still report their own well''s work (B1)',
  :'deactivated_result' = 'ok'
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE client_entry_id = 'guard-deactivated');

-- ...but not another well's.
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = false WHERE id = :'operator_id';
SELECT pg_temp.act_as(:'operator_id');
SELECT pg_temp.try_report('guard-deactivated-other', :'operator_id', 'drilling_bar',
  jsonb_build_object('project_id', :other_project_id)) AS deactivated_other_result \gset
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = true WHERE id = :'operator_id';
INSERT INTO results SELECT 'a deactivated operator cannot report another well''s work',
  :'deactivated_other_result' = '42501'
  AND NOT EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE client_entry_id = 'guard-deactivated-other');

-- Install the next operator as the current secondary crew member on this well.
INSERT INTO public.project_secondary_operators (project_id, operator_id)
VALUES (:project_id, :'next_id') ON CONFLICT DO NOTHING;

-- A signed-in operator with neither a team link nor a shift on this well is refused.
SELECT pg_temp.act_as(:'removed_id');
SELECT pg_temp.try_report('guard-unlinked', :'removed_id', 'drilling_bar',
  jsonb_build_object('project_id', :project_id)) AS unlinked_result \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a user with no link to the well is refused',
  :'unlinked_result' = '42501'
  AND NOT EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE client_entry_id = 'guard-unlinked');

-- The next operator reports the previous operator's archived work on the same well.
SELECT pg_temp.act_as(:'next_id');
SELECT public.report_rejected_work('guard-shared-tablet', :'operator_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-valid-bar',
    'soil_type', 'Arena', 'length', 3, 'duration_minutes', 30,
    'water_level', 4, 'timestamp_local', now()::text,
    'photo_paths', jsonb_build_array(:project_id::text || '/bar.jpg')::text
  ), 'denied (42501)', now()) AS shared_report \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the next operator can report the previous operator''s work',
  EXISTS (SELECT 1 FROM public.rejected_work_reports
          WHERE id = :shared_report AND reported_by = :'next_id'
            AND operator_id = :'operator_id' AND project_id = :project_id);
SELECT pg_temp.act_as(:'next_id');

-- A removed operator remains eligible to report old work when a shift proves
-- they worked on this well. A closed historical shift is sufficient.
SELECT pg_temp.act_as_owner();
INSERT INTO public.shifts (project_id, operator_id, status, started_at, ended_at)
VALUES (:project_id, :'removed_id', 'closed', now() - interval '2 hours', now() - interval '1 hour');
SELECT pg_temp.act_as(:'next_id');
SELECT public.report_rejected_work('guard-removed-with-shift', :'removed_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-removed-bar',
    'soil_type', 'Arena', 'length', 2, 'timestamp_local', now()::text
  ), 'denied (42501)', now()) AS removed_report \gset
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:removed_report) AS removed_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a removed claimed operator with a shift is accepted',
  :'removed_report_decision' = 'ok';

-- Invalid accepted bars fail atomically and remain pending.
SELECT pg_temp.act_as(:'next_id');
SELECT public.report_rejected_work('guard-bad-duration', :'operator_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-bad-duration-bar',
    'soil_type', 'Arena', 'length', 3, 'duration_minutes', 99999
  ), 'denied (42501)', now()) AS duration_report \gset
SELECT public.report_rejected_work('guard-bad-water', :'operator_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-bad-water-bar',
    'soil_type', 'Arena', 'length', 3, 'water_level', -5
  ), 'denied (42501)', now()) AS water_report \gset
SELECT public.report_rejected_work('guard-bad-photo', :'operator_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-bad-photo-bar',
    'soil_type', 'Arena', 'length', 3,
    'photo_paths', jsonb_build_array(:other_project_id::text || '/other-project.jpg')::text
  ), 'denied (42501)', now()) AS photo_report \gset
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:duration_report) AS duration_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'duration 99999 fails and stays pending',
  :'duration_report_decision' = '22023'
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :duration_report AND status = 'pending')
  AND NOT EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'guard-bad-duration-bar');
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:water_report) AS water_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'negative water level fails and stays pending',
  :'water_report_decision' = '22023'
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :water_report AND status = 'pending')
  AND NOT EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'guard-bad-water-bar');
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:photo_report) AS photo_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'another well''s photo path is dropped and the bar is still accepted',
  :'photo_report_decision' = 'ok'
  AND EXISTS (SELECT 1 FROM public.drilling_bars
              WHERE client_entry_id = 'guard-bad-photo-bar' AND photo_paths IS NULL);

-- What phones really send: uploaded photos as objects with their photos.id, and
-- photos that never uploaded as phone paths. Only this well's photo row is kept.
SELECT pg_temp.act_as_owner();
INSERT INTO public.photos (project_id, storage_path, filename, uploaded_by, evidence_kind)
VALUES (:project_id, :project_id::text || '/guard-kept.jpg', :project_id::text || '/guard-kept.jpg',
        :'operator_id', 'field') RETURNING id AS kept_photo \gset
INSERT INTO public.photos (project_id, storage_path, filename, uploaded_by, evidence_kind)
VALUES (:other_project_id, :other_project_id::text || '/guard-other.jpg', :other_project_id::text || '/guard-other.jpg',
        :'operator_id', 'field') RETURNING id AS other_photo \gset
SELECT pg_temp.act_as(:'next_id');
SELECT public.report_rejected_work('guard-phone-photos', :'operator_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-phone-photos-bar',
    'soil_type', 'Arena', 'length', 3,
    'photo_paths', jsonb_build_array(
      jsonb_build_object('id', :kept_photo, 'filename', :project_id::text || '/guard-kept.jpg', 'local_uri', 'file:///a.jpg'),
      jsonb_build_object('id', :other_photo, 'filename', :other_project_id::text || '/guard-other.jpg'),
      'file:///data/user/0/com.phc/cache/never-uploaded.jpg',
      :project_id::text || '/../' || :other_project_id::text || '/sneaky.jpg'
    )
  ), 'denied (42501)', now()) AS phone_photos_report \gset
-- The same, sent as text holding the array, the way the local row stores it.
SELECT public.report_rejected_work('guard-phone-photos-text', :'operator_id', 'drilling_bar',
  'local-guard', 'UPSERT', jsonb_build_object(
    'project_id', :project_id, 'client_entry_id', 'guard-phone-photos-text-bar',
    'soil_type', 'Arena', 'length', 3,
    'photo_paths', jsonb_build_array('file:///only-on-the-phone.jpg')::text
  ), 'denied (42501)', now()) AS phone_text_report \gset
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:phone_photos_report) AS phone_photos_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'phone photo payload: only this well''s uploaded photo is kept, the bar is accepted',
  :'phone_photos_report_decision' = 'ok'
  AND EXISTS (SELECT 1 FROM public.drilling_bars
              WHERE client_entry_id = 'guard-phone-photos-bar'
                AND jsonb_array_length(photo_paths::jsonb) = 1
                AND (photo_paths::jsonb -> 0 ->> 'id')::bigint = :kept_photo);
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:phone_text_report) AS phone_text_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a bar whose photos never uploaded is accepted without them',
  :'phone_text_report_decision' = 'ok'
  AND EXISTS (SELECT 1 FROM public.drilling_bars
              WHERE client_entry_id = 'guard-phone-photos-text-bar' AND photo_paths IS NULL);

-- Water samples: a bottle photo that isn't this well's uploaded sample photo is
-- dropped; a negative depth is refused and stays pending.
SELECT pg_temp.act_as(:'next_id');
SELECT public.report_rejected_work('guard-sample-photo', :'operator_id', 'water_sample',
  'local-guard', 'create', jsonb_build_object(
    'projectId', :project_id, 'clientEntryId', 'guard-sample-photo-entry',
    'takenAt', now()::text, 'depthM', 12,
    'bottlePhotoPath', :other_project_id::text || '/guard-other.jpg'
  ), 'denied (42501)', now()) AS sample_photo_report \gset
SELECT public.report_rejected_work('guard-sample-depth', :'operator_id', 'water_sample',
  'local-guard', 'create', jsonb_build_object(
    'projectId', :project_id, 'clientEntryId', 'guard-sample-depth-entry',
    'takenAt', now()::text, 'depthM', -3
  ), 'denied (42501)', now()) AS sample_depth_report \gset
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:sample_photo_report) AS sample_photo_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a sample with another well''s bottle photo is accepted without it',
  :'sample_photo_report_decision' = 'ok'
  AND EXISTS (SELECT 1 FROM public.water_samples
              WHERE client_entry_id = 'guard-sample-photo-entry' AND bottle_photo_path IS NULL);
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:sample_depth_report) AS sample_depth_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a sample with a negative depth fails and stays pending',
  :'sample_depth_report_decision' = '22023'
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :sample_depth_report AND status = 'pending')
  AND NOT EXISTS (SELECT 1 FROM public.water_samples WHERE client_entry_id = 'guard-sample-depth-entry');

-- Accept the valid shared-tablet bar and verify its attributed fields.
SELECT pg_temp.act_as(:'admin_id');
SELECT pg_temp.try_decide(:shared_report) AS shared_report_decision \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a valid accepted bar is inserted',
  :'shared_report_decision' = 'ok'
  AND EXISTS (SELECT 1 FROM public.drilling_bars
              WHERE client_entry_id = 'guard-valid-bar'
                AND project_id = :project_id AND operator_id = :'operator_id'
                AND accepted_review_id = :shared_report AND length = 3
                AND duration_minutes = 30 AND water_level = 4
                AND photo_paths::jsonb = jsonb_build_array(:project_id::text || '/bar.jpg'));

\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed, '
  || count(*) FILTER (WHERE passed IS NOT TRUE) || ' FAILED' FROM results;
ROLLBACK;
