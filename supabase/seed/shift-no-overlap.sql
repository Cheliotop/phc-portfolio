-- Regression checks for 20261106120000_phc_shift_no_overlap.sql.
-- LOCAL stack only. Creates its own users and wells, so it needs no seed, and runs
-- inside one transaction that is rolled back, so it leaves no rows behind.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -f supabase/seed/shift-no-overlap.sql
--
-- Prints one PASS/FAIL line per check.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o /dev/null
BEGIN;

CREATE TEMP TABLE results (check_name text, passed boolean) ON COMMIT DROP;
GRANT ALL ON results TO authenticated;

\set ana 'aaaaaaaa-0000-4000-8000-000000000001'
\set beto 'aaaaaaaa-0000-4000-8000-000000000002'
\set ciro 'aaaaaaaa-0000-4000-8000-000000000003'
\set dana 'aaaaaaaa-0000-4000-8000-000000000004'
\set eva 'aaaaaaaa-0000-4000-8000-000000000005'

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
SELECT '00000000-0000-0000-0000-000000000000', v.id::uuid, 'authenticated', 'authenticated',
       v.username || '@phc.local', '', now(), '{"provider":"email"}'::jsonb,
       jsonb_build_object('username', v.username, 'full_name', v.full_name),
       now(), now(), '', '', '', ''
FROM (VALUES
  (:'ana', 'overlap_ana', 'Ana Prueba'),
  (:'beto', 'overlap_beto', 'Beto Prueba'),
  (:'ciro', 'overlap_ciro', 'Ciro Prueba'),
  (:'dana', 'overlap_dana', 'Dana Prueba'),
  (:'eva', 'overlap_eva', 'Eva Prueba')
) AS v(id, username, full_name);
UPDATE public.profiles SET full_name = 'Ana Prueba' WHERE id = :'ana';

INSERT INTO public.projects (name, status, assigned_operator_id)
VALUES ('Pozo sin solapes', 'active', :'ana') RETURNING id AS well \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Caño', 10, 10, 'u', true);
INSERT INTO public.projects (name, status, assigned_operator_id)
VALUES ('Pozo con reloj malo', 'active', :'dana') RETURNING id AS clock_well \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:clock_well, 'Caño', 10, 10, 'u', true);

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
-- Each returns the shift id or 'ok' on success, or 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.start(p_well bigint, p_key text, p_started timestamptz DEFAULT NULL,
                              p_device timestamptz DEFAULT now(), p_id uuid DEFAULT gen_random_uuid())
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v public.shifts;
BEGIN
  v := public.start_shift(p_well, p_id, p_key, p_started, p_device);
  RETURN v.id::text;
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.handover(p_shift uuid, p_well bigint) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.confirm_shift_handover(p_shift, (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('project_material_id', pm.id)), '[]'::jsonb)
    FROM public.project_materials pm WHERE pm.project_id = p_well AND pm.active));
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.finish(p_shift uuid, p_well bigint) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.end_shift(p_shift, (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('project_material_id', pm.id, 'quantity_used', 0)), '[]'::jsonb)
    FROM public.project_materials pm WHERE pm.project_id = p_well AND pm.active),
    'prueba', now(), 'manual');
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.bar(p_well bigint, p_shift uuid, p_key text, p_at timestamptz) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.create_drilling_bar(p_well, 'arcilla', p_key, 3::real, NULL, NULL, NULL, NULL, NULL,
                                     NULL, NULL, p_at::text, p_shift);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.sample(p_well bigint, p_key text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.register_water_sample(p_well, p_key, now(), 10::real, NULL, NULL, NULL, NULL, now());
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- A start with no time uses the server's, and the phone's time is kept.
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.start(:well, 'overlap-ana-1', NULL, now() - interval '2 minutes',
                     'bbbbbbbb-0000-4000-8000-000000000001') AS ana_shift \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a start with no time uses the server clock and stays open',
  s.status = 'open' AND s.started_at = now() AND s.operator_id = :'ana'
  FROM public.shifts s WHERE s.id::text = :'ana_shift';
INSERT INTO results SELECT 'a phone 2 minutes off keeps its time and is not flagged',
  s.start_device_time = now() - interval '2 minutes' AND s.device_time_flag IS FALSE
  FROM public.shifts s WHERE s.id::text = :'ana_shift';

-- A retry after a lost response returns the same shift, not an error or a second one.
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.start(:well, 'overlap-ana-1', NULL, now() - interval '2 minutes',
                     'bbbbbbbb-0000-4000-8000-000000000001') AS ana_retry \gset
SELECT pg_temp.start(:well, 'overlap-ana-other-key') AS ana_new_key \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'retrying with the same key returns the same shift', :'ana_retry' = :'ana_shift';
INSERT INTO results SELECT 'a new key returns the operator''s unresolved shift', :'ana_new_key' = :'ana_shift';
INSERT INTO results SELECT 'neither retry added a shift', count(*) = 1
  FROM public.shifts WHERE project_id = :well;

-- A second operator waits, and is told who to wait for.
SELECT pg_temp.act_as(:'beto');
SELECT pg_temp.start(:well, 'overlap-beto-unassigned') AS beto_unassigned \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an operator with no link to the well is refused', :'beto_unassigned' LIKE 'ERR 42501%';

-- Reassign while Ana's shift is open.
UPDATE public.projects SET assigned_operator_id = :'beto' WHERE id = :well;
INSERT INTO results SELECT 'moving the well flags the open shift', reassigned_during_shift
  FROM public.shifts WHERE id::text = :'ana_shift';
SELECT pg_temp.act_as(:'beto');
SELECT pg_temp.start(:well, 'overlap-beto-1') AS beto_refused \gset
INSERT INTO results SELECT 'the new operator is refused while the old shift is open', :'beto_refused' LIKE 'ERR 55000%';
INSERT INTO results SELECT 'the refusal starts with the words the phone matches',
  :'beto_refused' LIKE 'ERR 55000 Todavía no podés iniciar%';
INSERT INTO results SELECT 'the refusal names who to wait for', :'beto_refused' LIKE '%Ana Prueba%';

-- Current-assignment contract supersedes old open-shift read/write exception.
SELECT pg_temp.act_as(:'ana');
INSERT INTO results SELECT 'removed operator is no longer team', NOT public.is_project_team_member(:well);
INSERT INTO results SELECT 'removed operator cannot browse materials', count(*)=0 FROM public.project_materials WHERE project_id=:well;
SELECT pg_temp.bar(:well, :'ana_shift', 'overlap-denied-bar', now()) AS denied_bar \gset
INSERT INTO results SELECT 'removed operator field write refused', :'denied_bar' LIKE 'ERR 42501%';
-- Explicit admin restoration, not shift ownership, authorizes report completion.
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id=:'ana' WHERE id=:well;
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.handover(:'ana_shift', :well) AS ana_handover \gset
INSERT INTO results SELECT 'restored operator confirms handover', :'ana_handover'='ok';
-- Deactivating them still cuts them off at once.
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = false WHERE id = :'ana';
SELECT pg_temp.act_as(:'ana');
INSERT INTO results SELECT 'a deactivated operator loses the well during their shift',
  NOT public.is_project_team_member(:well);
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active = true WHERE id = :'ana';

SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'ana_shift', :well) AS ana_finish \gset
INSERT INTO results SELECT 'a removed operator can close their shift', :'ana_finish' = 'ok';
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id=:'beto' WHERE id=:well;
SELECT pg_temp.act_as(:'ana');
INSERT INTO results SELECT 'access ends after assignment removal', NOT public.is_project_team_member(:well);
INSERT INTO results SELECT 'the materials are hidden once it closes', count(*) = 0
  FROM public.project_materials WHERE project_id = :well;
SELECT pg_temp.sample(:well, 'overlap-sample-2') AS ana_late_sample \gset
INSERT INTO results SELECT 'work after the close is refused', :'ana_late_sample' LIKE 'ERR 42501%';
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the flag survives the close', reassigned_during_shift AND status = 'closed'
  FROM public.shifts WHERE id::text = :'ana_shift';

-- Now the next operator can start.
SELECT pg_temp.act_as(:'beto');
SELECT pg_temp.start(:well, 'overlap-beto-2') AS beto_shift \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the next operator starts once the old shift closes', :'beto_shift' NOT LIKE 'ERR%';
INSERT INTO results SELECT 'a shift started after the move is not flagged', NOT reassigned_during_shift
  FROM public.shifts WHERE id::text = :'beto_shift';

-- A shift the 12-hour rule auto-closed still blocks until its report is filed.
UPDATE public.shifts SET started_at = now() - interval '13 hours' WHERE id::text = :'beto_shift';
SELECT private.reap_expired_shifts();
UPDATE public.projects SET assigned_operator_id = :'ciro' WHERE id = :well;
SELECT pg_temp.act_as(:'ciro');
SELECT pg_temp.start(:well, 'overlap-ciro-1') AS ciro_refused \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an auto-closed shift with no report still blocks', :'ciro_refused' LIKE 'ERR 55000%';
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id=:'beto' WHERE id=:well;
SELECT pg_temp.act_as(:'beto');
SELECT pg_temp.handover(:'beto_shift', :well) \g /dev/null
SELECT pg_temp.finish(:'beto_shift', :well) AS beto_finish \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the auto-closed shift can file its report', :'beto_finish' = 'ok';

UPDATE public.projects SET assigned_operator_id=:'ciro' WHERE id=:well;

-- A backdated start is no longer an overlap: the server starts it on its own clock (D3).
SELECT pg_temp.act_as(:'ciro');
SELECT pg_temp.start(:well, 'overlap-ciro-back', now() - interval '13 hours', now() - interval '13 hours') AS ciro_back \gset
SELECT pg_temp.start(:well, 'overlap-ciro-2') AS ciro_shift \gset
INSERT INTO results SELECT 'a backdated start is accepted and starts on the server clock',
  :'ciro_back' NOT LIKE 'ERR%' AND (SELECT started_at >= now() - interval '1 minute' FROM public.shifts WHERE id::text = :'ciro_back');
INSERT INTO results SELECT 'a second start by the same operator resumes their open shift', :'ciro_shift' = :'ciro_back';
SELECT pg_temp.act_as_owner();

-- The index holds even if a path skips start_shift.
DO $$
DECLARE v_refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.shifts (id, client_entry_id, project_id, operator_id, status, started_at)
    SELECT gen_random_uuid(), 'overlap-raw', project_id, 'aaaaaaaa-0000-4000-8000-000000000002', 'open', now()
    FROM public.shifts WHERE client_entry_id = 'overlap-ciro-back';
  EXCEPTION WHEN unique_violation THEN v_refused := true;
  END;
  INSERT INTO results VALUES ('the database refuses a second unresolved shift on a well', v_refused);
END $$;

-- A retry of a start after its shift closed still gets the same shift.
SELECT pg_temp.act_as(:'ciro');
SELECT pg_temp.handover(:'ciro_shift', :well) \g /dev/null
SELECT pg_temp.finish(:'ciro_shift', :well) \g /dev/null
INSERT INTO results SELECT 'a retried start after the close returns the closed shift',
  pg_temp.start(:well, 'overlap-ciro-back', now() - interval '13 hours', now() - interval '13 hours', :'ciro_back') = :'ciro_back';
SELECT pg_temp.act_as_owner();

-- Clients cannot clear the flag or touch shifts directly.
INSERT INTO results SELECT 'clients cannot reach the reassignment trigger function',
  NOT has_function_privilege('authenticated', 'private.flag_shifts_on_reassignment()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'private.flag_shifts_on_reassignment()', 'EXECUTE');
SELECT pg_temp.act_as(:'ana');
DO $$
DECLARE v_changed int := 0;
BEGIN
  BEGIN
    UPDATE public.shifts SET reassigned_during_shift = false WHERE client_entry_id = 'overlap-ana-1';
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN v_changed := 0;
  END;
  INSERT INTO results VALUES ('an operator cannot clear the flag', v_changed = 0);
END $$;
INSERT INTO results SELECT 'an operator can read the flag on their own shift', reassigned_during_shift
  FROM public.shifts WHERE client_entry_id = 'overlap-ana-1';
SELECT pg_temp.act_as_owner();

-- Wrong phone clocks: accepted on the server's time, flagged, phone time kept.
SELECT pg_temp.act_as(:'dana');
SELECT pg_temp.start(:clock_well, 'overlap-fast', NULL, now() + interval '30 minutes') AS fast_shift \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a phone 30 minutes fast starts on the server clock, flagged',
  s.started_at = now() AND s.device_time_flag AND s.start_device_time = now() + interval '30 minutes'
  FROM public.shifts s WHERE s.id::text = :'fast_shift';
SELECT pg_temp.act_as(:'dana');
SELECT pg_temp.handover(:'fast_shift', :clock_well) \g /dev/null
SELECT pg_temp.bar(:clock_well, :'fast_shift', 'overlap-fast-bar', now() + interval '31 minutes') AS fast_bar \gset
SELECT pg_temp.bar(:clock_well, :'fast_shift', 'overlap-fast-far', now() + interval '14 hours') AS fast_far \gset
SELECT pg_temp.finish(:'fast_shift', :clock_well) \g /dev/null
INSERT INTO results SELECT 'a bar from the fast phone is accepted', :'fast_bar' = 'ok';
INSERT INTO results SELECT 'a bar far outside the shift is still refused', :'fast_far' LIKE 'ERR 22023%';

SELECT pg_temp.start(:clock_well, 'overlap-slow', NULL, now() - interval '30 minutes') AS slow_shift \gset
SELECT pg_temp.handover(:'slow_shift', :clock_well) \g /dev/null
SELECT pg_temp.bar(:clock_well, :'slow_shift', 'overlap-slow-bar', now() - interval '29 minutes') AS slow_bar \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a phone 30 minutes slow starts on the server clock, flagged',
  s.started_at = now() AND s.device_time_flag
  FROM public.shifts s WHERE s.id::text = :'slow_shift';
INSERT INTO results SELECT 'a bar from the slow phone is accepted', :'slow_bar' = 'ok';
SELECT pg_temp.act_as(:'dana');
SELECT pg_temp.finish(:'slow_shift', :clock_well) \g /dev/null
SELECT pg_temp.act_as_owner();

-- An older app that sends a future start time is accepted the same way.
SELECT pg_temp.act_as(:'dana');
SELECT pg_temp.start(:clock_well, 'overlap-legacy', now() + interval '30 minutes', now() + interval '30 minutes',
                     'bbbbbbbb-0000-4000-8000-000000000002') AS legacy_shift \gset
SELECT pg_temp.start(:clock_well, 'overlap-legacy', now() + interval '30 minutes', now() + interval '30 minutes',
                     'bbbbbbbb-0000-4000-8000-000000000002') AS legacy_retry \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a future start from an older app uses the server clock, flagged',
  s.started_at = now() AND s.device_time_flag
  FROM public.shifts s WHERE s.id::text = :'legacy_shift';
INSERT INTO results SELECT 'retrying that future start returns the same shift', :'legacy_retry' = :'legacy_shift';

-- A well keeps its own rule; an operator's overlap across wells is only flagged.
SELECT pg_temp.act_as(:'dana');
SELECT pg_temp.handover(:'legacy_shift', :clock_well) \g /dev/null
SELECT pg_temp.finish(:'legacy_shift', :clock_well) \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO public.projects (name, status, assigned_operator_id)
VALUES ('Otro pozo de Dana', 'active', :'dana') RETURNING id AS other_well \gset
SELECT pg_temp.act_as(:'dana');
SELECT pg_temp.start(:other_well, 'overlap-other-well', now() - interval '1 hour', now() - interval '1 hour') AS other_shift \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'overlapping the operator''s shift on another well is allowed and flagged',
  s.device_time_flag FROM public.shifts s WHERE s.id::text = :'other_shift';

-- An operator on no well gets nothing.
SELECT pg_temp.act_as(:'eva');
INSERT INTO results SELECT 'an unrelated operator is not on the well', NOT public.is_project_team_member(:well);
SELECT pg_temp.act_as_owner();

\o
SELECT CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed) || '/' || count(*) || ' passed' FROM results;
ROLLBACK;
