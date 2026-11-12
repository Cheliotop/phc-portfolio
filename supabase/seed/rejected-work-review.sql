-- Regression checks for 20261105120000_phc_rejected_work_review.sql.
-- LOCAL stack only, after seed-local.js. Everything runs inside one
-- transaction that is rolled back, so it leaves no rows behind.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -f supabase/seed/rejected-work-review.sql
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
WHERE public.project_status_key(p.status) = 'active' AND p.assigned_operator_id IS NOT NULL
ORDER BY p.id LIMIT 1 \gset
SELECT id AS admin_id FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1 \gset
SELECT id AS other_id FROM public.profiles
WHERE role = 'operator' AND is_active AND id <> :'operator_id' ORDER BY created_at LIMIT 1 \gset
SELECT p.id AS signed_project FROM public.projects p
WHERE public.project_status_key(p.status) = 'completed' ORDER BY p.id LIMIT 1 \gset

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
CREATE FUNCTION pg_temp.report(p_key text, p_owner uuid, p_entity text, p_payload jsonb) RETURNS bigint
LANGUAGE sql AS $$
  SELECT public.report_rejected_work(p_key, p_owner, p_entity, 'local-1', 'UPSERT', p_payload, 'denied (42501)', now());
$$;
CREATE FUNCTION pg_temp.decide(p_id bigint, p_decision text, p_note text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.decide_rejected_work(p_id, p_decision, p_note);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- Permissions
INSERT INTO results SELECT 'anon cannot report rejected work',
  NOT has_function_privilege('anon', 'public.report_rejected_work(text, uuid, text, text, text, jsonb, text, timestamptz)', 'EXECUTE');
INSERT INTO results SELECT 'anon cannot decide rejected work',
  NOT has_function_privilege('anon', 'public.decide_rejected_work(bigint, text, text)', 'EXECUTE');
INSERT INTO results SELECT 'clients cannot apply work directly',
  NOT has_function_privilege('authenticated', 'private.apply_rejected_work(public.rejected_work_reports)', 'EXECUTE');
INSERT INTO results SELECT 'clients cannot write the table directly',
  NOT has_table_privilege('authenticated', 'public.rejected_work_reports', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.rejected_work_reports', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.rejected_work_reports', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.rejected_work_reports', 'SELECT');

-- A deactivated operator can still report, and reporting twice adds one row.
UPDATE public.profiles SET is_active = false WHERE id = :'operator_id';
SELECT pg_temp.act_as(:'operator_id');
SELECT pg_temp.report('t-bar-1', :'operator_id', 'drilling_bar', jsonb_build_object(
  'client_entry_id', 'review-bar-1', 'project_id', :project_id, 'soil_type', 'Arena',
  'length', 3, 'notes', 'barra de prueba')) AS bar_report \gset
SELECT pg_temp.report('t-bar-1', :'operator_id', 'drilling_bar', '{"project_id": 1}'::jsonb) AS bar_report_again \gset
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = true WHERE id = :'operator_id';
INSERT INTO results SELECT 'deactivated operator can report, and a repeat adds nothing',
  :bar_report = :bar_report_again
  AND (SELECT count(*) = 1 FROM public.rejected_work_reports WHERE client_entry_id = 't-bar-1');

-- Another user uploads archived work: both names are kept. Since SEC-1
-- (20261109130000) only the well's crew may report its work, so the uploader is
-- the well's secondary operator, as the equipo partner on a shared tablet would be.
SELECT pg_temp.act_as_owner();
INSERT INTO public.project_secondary_operators (project_id, operator_id)
SELECT v.project_id, v.operator_id
FROM (VALUES (:project_id::bigint, :'other_id'::uuid), (:signed_project::bigint, :'other_id'::uuid),
             (:signed_project::bigint, :'operator_id'::uuid)) AS v(project_id, operator_id)
WHERE NOT EXISTS (SELECT 1 FROM public.projects p
                  WHERE p.id = v.project_id AND p.assigned_operator_id = v.operator_id)
ON CONFLICT DO NOTHING;
SELECT pg_temp.act_as(:'other_id');
SELECT pg_temp.report('t-sample-1', :'operator_id', 'water_sample', jsonb_build_object(
  'clientEntryId', 'review-sample-1', 'projectId', :project_id, 'takenAt', now(), 'depthM', 12)) AS sample_report \gset
SELECT pg_temp.report('t-shift-1', :'operator_id', 'shift_start', jsonb_build_object('projectId', :project_id)) AS shift_report \gset
SELECT pg_temp.report('t-signed-1', :'operator_id', 'drilling_bar', jsonb_build_object(
  'client_entry_id', 'review-bar-signed', 'project_id', :signed_project, 'soil_type', 'Arena')) AS signed_report \gset
SELECT pg_temp.report('t-reject-1', :'operator_id', 'drilling_bar', jsonb_build_object(
  'client_entry_id', 'review-bar-rejected', 'project_id', :project_id, 'soil_type', 'Arena')) AS reject_report \gset
INSERT INTO results SELECT 'an operator cannot read someone else''s report',
  NOT EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :bar_report);
INSERT INTO results SELECT 'an operator cannot decide', pg_temp.decide(:bar_report, 'accepted', NULL) = '42501';

SELECT pg_temp.act_as(:'operator_id');
INSERT INTO results SELECT 'an operator can read their own report',
  EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :sample_report);

-- Admin decisions
SELECT pg_temp.act_as(:'admin_id');
SELECT COALESCE(max(bar_number), 0) AS last_bar, COALESCE(max(depth_end), 0) AS last_depth
FROM public.drilling_bars WHERE project_id = :project_id \gset

INSERT INTO results SELECT 'accepting a bar succeeds', pg_temp.decide(:bar_report, 'accepted', NULL) = 'ok';
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an accepted bar joins the record under its operator, marked and next in line',
  EXISTS (
    SELECT 1 FROM public.drilling_bars
    WHERE client_entry_id = 'review-bar-1' AND project_id = :project_id
      AND operator_id = :'operator_id' AND accepted_review_id = :bar_report
      AND bar_number = :last_bar + 1 AND depth_start = :last_depth AND depth_end = :last_depth + 3
  );
INSERT INTO results SELECT 'the decision records who decided and that it applied',
  EXISTS (
    SELECT 1 FROM public.rejected_work_reports
    WHERE id = :bar_report AND status = 'accepted' AND applied AND decided_by = :'admin_id'
  );
INSERT INTO results SELECT 'the decision is in the audit log',
  EXISTS (
    SELECT 1 FROM public.audit_log
    WHERE action = 'rejected_work.accepted' AND entity_id = :bar_report::text
  );

SELECT pg_temp.act_as(:'admin_id');
INSERT INTO results SELECT 'a decision cannot be made twice', pg_temp.decide(:bar_report, 'rejected', 'cambio de idea') = '22023';
INSERT INTO results SELECT 'accepting a water sample succeeds', pg_temp.decide(:sample_report, 'accepted', NULL) = 'ok';
INSERT INTO results SELECT 'a manual kind needs a note', pg_temp.decide(:shift_report, 'accepted', NULL) = '22023';
INSERT INTO results SELECT 'a manual kind accepts with a note', pg_temp.decide(:shift_report, 'accepted', 'Cargado a mano') = 'ok';
INSERT INTO results SELECT 'a signed well refuses the bar', pg_temp.decide(:signed_report, 'accepted', NULL) = '22023';
INSERT INTO results SELECT 'a rejection needs a reason', pg_temp.decide(:reject_report, 'rejected', NULL) = '22023';
INSERT INTO results SELECT 'a rejection with a reason succeeds', pg_temp.decide(:reject_report, 'rejected', 'Duplicado') = 'ok';

SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an accepted sample joins the record, marked',
  EXISTS (
    SELECT 1 FROM public.water_samples
    WHERE client_entry_id = 'review-sample-1' AND operator_id = :'operator_id'
      AND accepted_review_id = :sample_report AND device_time_flag
  );
INSERT INTO results SELECT 'a manual kind is recorded as not applied',
  EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :shift_report AND status = 'accepted' AND NOT applied);
INSERT INTO results SELECT 'a refused acceptance stays pending and adds nothing',
  EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :signed_report AND status = 'pending')
  AND NOT EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'review-bar-signed');
INSERT INTO results SELECT 'a rejected bar stays out of the record but on file',
  NOT EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'review-bar-rejected')
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :reject_report AND decision_note = 'Duplicado');

-- Work that later reached the server by itself must not be added twice.
SELECT pg_temp.act_as(:'operator_id');
SELECT pg_temp.report('t-dup-1', :'operator_id', 'drilling_bar', jsonb_build_object(
  'client_entry_id', 'review-bar-1', 'project_id', :project_id, 'soil_type', 'Arena')) AS dup_report \gset
SELECT pg_temp.act_as(:'admin_id');
INSERT INTO results SELECT 'accepting work already on record succeeds', pg_temp.decide(:dup_report, 'accepted', NULL) = 'ok';
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'work already on record is not added twice',
  (SELECT count(*) = 1 FROM public.drilling_bars WHERE client_entry_id = 'review-bar-1')
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :dup_report AND NOT applied);

-- Code read S8 (20261108140000): the reporting phone says refused work got
-- through on a retry. It is only a note for the admin, never a decision.
INSERT INTO results SELECT 'anon cannot mark rejected work as sent',
  NOT has_function_privilege('anon', 'public.mark_rejected_work_sent(text)', 'EXECUTE');
SELECT pg_temp.act_as(:'operator_id');
SELECT pg_temp.report('t-sent-1', :'operator_id', 'pedido_v2', jsonb_build_object('projectId', :project_id)) AS sent_report \gset
SELECT pg_temp.act_as(:'other_id');
INSERT INTO results SELECT 'another user cannot mark it sent', NOT public.mark_rejected_work_sent('t-sent-1');
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'another user leaves no mark',
  EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :sent_report AND sent_later_at IS NULL);
SELECT pg_temp.act_as(:'operator_id');
INSERT INTO results SELECT 'the reporting user marks it sent', public.mark_rejected_work_sent('t-sent-1');
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'marking it sent records the time and leaves the decision to the admin',
  EXISTS (
    SELECT 1 FROM public.rejected_work_reports
    WHERE id = :sent_report AND sent_later_at IS NOT NULL AND status = 'pending' AND decided_by IS NULL
  );
SELECT pg_temp.act_as(:'other_id');
INSERT INTO results SELECT 'a decided entry is known but left as it was', public.mark_rejected_work_sent('t-shift-1');
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a decided entry gets no mark',
  EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE id = :shift_report AND sent_later_at IS NULL AND status = 'accepted');

\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed, '
  || count(*) FILTER (WHERE passed IS NOT TRUE) || ' FAILED' FROM results;
ROLLBACK;
