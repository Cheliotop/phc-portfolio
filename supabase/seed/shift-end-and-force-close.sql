-- Regression checks for 20261107120000_phc_shift_end_server_clock.sql,
-- 20261107130000_phc_shift_force_close.sql, 20261108120000_phc_shift_end_after_sweep.sql and
-- 20261108130000_phc_force_closed_bars.sql and 20261108150000_phc_shift_end_material_changes.sql.
-- LOCAL stack only. Creates its own users and wells, so it needs no seed, and runs
-- inside one transaction that is rolled back, so it leaves no rows behind.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -f supabase/seed/shift-end-and-force-close.sql
--
-- Prints one PASS/FAIL line per check. now() does not move inside a transaction, so
-- each shift is backdated by hand to give it a past.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o /dev/null
BEGIN;

CREATE TEMP TABLE results (check_name text, passed boolean) ON COMMIT DROP;
GRANT ALL ON results TO authenticated;

\set ana 'cccccccc-0000-4000-8000-000000000001'
\set beto 'cccccccc-0000-4000-8000-000000000002'
\set admin 'cccccccc-0000-4000-8000-000000000003'
\set idle 'cccccccc-0000-4000-8000-000000000004'

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
  (:'ana', 'close_ana', 'Ana Prueba'),
  (:'beto', 'close_beto', 'Beto Prueba'),
  (:'admin', 'close_admin', 'Admin Prueba'),
  (:'idle', 'close_idle', 'Admin Inactivo')
) AS v(id, username, full_name);
UPDATE public.profiles SET role = 'admin' WHERE id IN (:'admin', :'idle');
UPDATE public.profiles SET is_active = false WHERE id = :'idle';

INSERT INTO public.projects (name, status, assigned_operator_id)
VALUES ('Pozo de cierres', 'active', :'ana') RETURNING id AS well \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Caño', 10, 10, 'u', true) RETURNING id AS material \gset
INSERT INTO public.project_secondary_operators (project_id, operator_id) VALUES (:well, :'beto');

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

-- An open shift of Ana's on the well, confirmed, that began this long ago by the
-- server, with the phone's clock off by p_skew. Clears the well first.
CREATE FUNCTION pg_temp.shift_ago(p_ago interval, p_skew interval, p_confirmed boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_well bigint;
BEGIN
  SELECT id INTO v_well FROM public.projects WHERE name = 'Pozo de cierres';
  UPDATE public.shifts SET status = 'closed', ended_at = started_at, usage_report_submitted = true
    WHERE project_id = v_well AND status <> 'closed';
  INSERT INTO public.shifts (id, client_entry_id, project_id, operator_id, status, started_at,
                             start_device_time, handover_confirmed)
  SELECT v_id, 'close-' || v_id, v_well, assigned_operator_id, 'open', now() - p_ago,
         now() - p_ago + p_skew, p_confirmed
  FROM public.projects WHERE id = v_well;
  RETURN v_id;
END $$;

-- Each returns 'ok' on success, or 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.finish(p_shift uuid, p_device_end timestamptz, p_quantity real DEFAULT 0) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_well bigint;
BEGIN
  SELECT project_id INTO v_well FROM public.shifts WHERE id = p_shift;
  PERFORM public.end_shift(p_shift, (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('project_material_id', pm.id, 'quantity_used', p_quantity)), '[]'::jsonb)
    FROM public.project_materials pm WHERE pm.project_id = v_well AND pm.active),
    'prueba', p_device_end, 'manual');
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.force(p_shift uuid, p_reason text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.force_close_shift(p_shift, p_reason);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.start(p_well bigint, p_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v public.shifts;
BEGIN
  v := public.start_shift(p_well, gen_random_uuid(), p_key, NULL, now());
  RETURN v.id::text;
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.bar(p_well bigint, p_shift uuid, p_key text, p_at timestamptz) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.create_drilling_bar(p_well, 'arcilla', p_key, 3::real, NULL, NULL, NULL, NULL, NULL,
                                     NULL, NULL, p_at::text, p_shift);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- ---------- H2: the end time is on the server's clock

-- Closed just now on a phone 30 minutes slow: four hours, not three and a half.
SELECT pg_temp.shift_ago('4 hours', '-30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '30 minutes') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a slow phone closing now records the real hours',
  s.ended_at = now() AND s.status = 'closed' FROM public.shifts s WHERE s.id = :'s';
INSERT INTO results SELECT 'the slow phone''s own time is kept for reference',
  s.end_device_time = now() - interval '30 minutes' FROM public.shifts s WHERE s.id = :'s';

-- Closed an hour ago offline on that slow phone.
SELECT pg_temp.shift_ago('4 hours', '-30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '90 minutes') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a slow phone''s offline close keeps when it really happened',
  s.ended_at = now() - interval '1 hour' FROM public.shifts s WHERE s.id = :'s';

-- Closed an hour ago offline on a phone 30 minutes fast. Unconverted, this comes out
-- 30 minutes long.
SELECT pg_temp.shift_ago('4 hours', '30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '30 minutes') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a fast phone''s offline close keeps when it really happened',
  s.ended_at = now() - interval '1 hour' FROM public.shifts s WHERE s.id = :'s';

-- Closed just now on that fast phone: no longer looks like a time in the future.
SELECT pg_temp.shift_ago('4 hours', '30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() + interval '30 minutes') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a fast phone closing now records the real hours',
  s.ended_at = now() FROM public.shifts s WHERE s.id = :'s';

-- A correct clock is unchanged.
SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '1 hour') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a correct clock''s offline close is unchanged and not flagged',
  s.ended_at = now() - interval '1 hour' AND s.device_time_flag IS FALSE
  FROM public.shifts s WHERE s.id = :'s';

-- A shift with no phone start time, from before these columns.
SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
UPDATE public.shifts SET start_device_time = NULL WHERE id = :'s';
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '1 hour') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a shift with no phone start time uses the end time as sent',
  s.ended_at = now() - interval '1 hour' FROM public.shifts s WHERE s.id = :'s';

-- A clock changed during the shift, so the conversion lands in the future.
SELECT pg_temp.shift_ago('4 hours', '-30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() + interval '20 minutes') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an end time that lands in the future becomes now, flagged',
  s.ended_at = now() AND s.device_time_flag FROM public.shifts s WHERE s.id = :'s';

-- A clock changed the other way, so the conversion lands before the start.
SELECT pg_temp.shift_ago('4 hours', '30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '4 hours') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an end time before the start becomes now, flagged',
  s.ended_at = now() AND s.device_time_flag FROM public.shifts s WHERE s.id = :'s';

-- The 12-hour cap still holds after converting.
SELECT pg_temp.shift_ago('14 hours', '-30 minutes') AS s \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '30 minutes') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the 12-hour cap still applies',
  s.ended_at = s.started_at + interval '12 hours' AND s.end_type = 'auto'
  FROM public.shifts s WHERE s.id = :'s';

-- ---------- H4: who may force-close

SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
INSERT INTO results SELECT 'anon cannot run the force-close',
  NOT has_function_privilege('anon', 'public.force_close_shift(uuid, text, timestamp with time zone)', 'EXECUTE');
INSERT INTO results SELECT 'a signed-in user can reach it, so its own check decides',
  has_function_privilege('authenticated', 'public.force_close_shift(uuid, text, timestamp with time zone)', 'EXECUTE');
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.force(:'s', 'yo mismo') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an operator cannot force-close, even their own shift', :'r' LIKE 'ERR 42501%';
SELECT pg_temp.act_as(:'idle');
SELECT pg_temp.force(:'s', 'cuenta inactiva') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a deactivated admin cannot force-close', :'r' LIKE 'ERR 42501%';

SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', '') AS r_empty \gset
SELECT pg_temp.force(:'s', '   ') AS r_blank \gset
SELECT pg_temp.force(:'s', NULL) AS r_null \gset
SELECT pg_temp.force(:'s', 'ab') AS r_short \gset
SELECT pg_temp.force(gen_random_uuid(), 'no existe') AS r_missing \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a reason is required',
  :'r_empty' LIKE 'ERR 22023%' AND :'r_blank' LIKE 'ERR 22023%' AND :'r_null' LIKE 'ERR 22023%'
  AND :'r_short' LIKE 'ERR 22023%';
INSERT INTO results SELECT 'an unknown shift is reported as such', :'r_missing' LIKE 'ERR P0002%';
INSERT INTO results SELECT 'every refusal left the shift open',
  s.status = 'open' FROM public.shifts s WHERE s.id = :'s';

-- ---------- H4: what it does

SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', '  El operador perdió el teléfono  ') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the admin closes the shift', :'r' = 'ok';
INSERT INTO results SELECT 'it closes now, marked as closed by the admin, with no report',
  s.status = 'closed' AND s.ended_at = now() AND s.end_type = 'admin'
  AND s.usage_report_submitted IS FALSE
  FROM public.shifts s WHERE s.id = :'s';
INSERT INTO results SELECT 'the operator can see why',
  s.notes = 'El operador perdió el teléfono' FROM public.shifts s WHERE s.id = :'s';
INSERT INTO results SELECT 'the audit log has the admin, the reason and the state before',
  a.actor_id = :'admin' AND a.reason = 'El operador perdió el teléfono'
  AND a.before_data ->> 'status' = 'open' AND a.after_data ->> 'status' = 'closed'
  FROM public.audit_log a WHERE a.action = 'shift.force_closed' AND a.entity_id = :'s';

SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'otra vez') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a shift already closed is refused', :'r' LIKE 'ERR 22023%';

-- The next operator is free.
SELECT pg_temp.act_as(:'beto');
SELECT pg_temp.start(:well, 'close-beto-after') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the next operator can now start', :'r' NOT LIKE 'ERR%';

-- Well past the limit with no reap yet: capped, not paid to today.
SELECT pg_temp.shift_ago('3 days', '0') AS s \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'abandonado') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a long abandoned shift is capped at 12 hours',
  s.ended_at = s.started_at + interval '12 hours' AND s.end_type = 'admin'
  FROM public.shifts s WHERE s.id = :'s';

-- Auto-closed with no report: keeps its end. This is the case that blocked a well.
SELECT pg_temp.shift_ago('15 hours', '0') AS s \gset
UPDATE public.shifts SET status = 'report_pending', ended_at = now() - interval '3 hours', end_type = 'auto'
  WHERE id = :'s';
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'nunca informó') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an auto-closed shift keeps its end time',
  s.status = 'closed' AND s.ended_at = now() - interval '3 hours' AND s.end_type = 'admin'
  FROM public.shifts s WHERE s.id = :'s';

-- Never confirmed: still closable.
SELECT pg_temp.shift_ago('1 hour', '0', false) AS s \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'nunca confirmó') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a shift with no handover can be closed', :'r' = 'ok';

-- ---------- H4: the operator's phone comes back

-- A close the phone had queued is refused, so it reaches the review list, and it
-- must not touch the material balance.
SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'sin señal') \g /dev/null
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '1 hour', 2) AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a close queued on the phone is refused for good', :'r' LIKE 'ERR 22023%';
INSERT INTO results SELECT 'the refused close does not touch the balance',
  pm.current_quantity = 10 FROM public.project_materials pm WHERE pm.id = :material;
INSERT INTO results SELECT 'the refused close does not change the shift',
  s.end_type = 'admin' AND s.usage_report_submitted IS FALSE AND s.ended_at = now()
  FROM public.shifts s WHERE s.id = :'s';

-- Bars recorded offline before the close really happened.
SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
UPDATE public.shifts SET ended_at = now() - interval '2 hours', status = 'report_pending', end_type = 'auto' WHERE id = :'s';
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'cerrado antes') \g /dev/null
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.bar(:well, :'s', 'close-bar-before', now() - interval '3 hours') AS before \gset
SELECT pg_temp.bar(:well, :'s', 'close-bar-after', now() - interval '1 hour') AS after \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a bar recorded before the close is accepted', :'before' = 'ok';
INSERT INTO results SELECT 'a bar recorded after the close is refused, so it goes to review', :'after' LIKE 'ERR 22023%';

-- Other closed shifts keep the old rule: no report, no late evidence. Closed with a
-- report missing is otherwise impossible, so force the row into that state.
SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
UPDATE public.shifts SET status = 'closed', ended_at = now(), end_type = 'manual', usage_report_submitted = false WHERE id = :'s';
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.bar(:well, :'s', 'close-bar-noreport', now() - interval '1 hour') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'any other closed shift with no report still refuses bars', :'r' LIKE 'ERR 55000%';

-- It counts against the report tally.
SELECT pg_temp.act_as(:'beto');
INSERT INTO results SELECT 'a shift with no force-close is not a missing report',
  (public.get_operator_accountability_metrics() ->> 'missing_or_late_reports')::int = 0;
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id = :'beto' WHERE id = :well;
SELECT pg_temp.shift_ago('1 hour', '0') AS s \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'para el conteo') \g /dev/null
SELECT pg_temp.act_as(:'beto');
INSERT INTO results SELECT 'a force-closed shift counts as a missing report',
  (public.get_operator_accountability_metrics() ->> 'missing_or_late_reports')::int = 1;
SELECT pg_temp.act_as_owner();


-- ---------- D2: a close made offline that syncs after the 12-hour sweep
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id = :'ana' WHERE id = :well;
SELECT pg_temp.shift_ago('14 hours', '0') AS s \gset
UPDATE public.shifts SET status = 'report_pending', ended_at = started_at + interval '12 hours', end_type = 'auto'
  WHERE id = :'s';
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '6 hours') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an offline close synced after the sweep keeps its own end time',
  :'r' = 'ok' AND s.status = 'closed' AND s.ended_at = s.started_at + interval '8 hours'
  AND s.end_type = 'manual' AND s.usage_report_submitted
  FROM public.shifts s WHERE s.id = :'s';

SELECT pg_temp.shift_ago('14 hours', '0') AS s \gset
UPDATE public.shifts SET status = 'report_pending', ended_at = started_at + interval '12 hours', end_type = 'auto'
  WHERE id = :'s';
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', NULL) AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a swept shift with no phone end time stays at 12 hours, auto',
  :'r' = 'ok' AND s.ended_at = s.started_at + interval '12 hours' AND s.end_type = 'auto'
  FROM public.shifts s WHERE s.id = :'s';

SELECT pg_temp.shift_ago('14 hours', '0') AS s \gset
UPDATE public.shifts SET status = 'report_pending', ended_at = started_at + interval '12 hours', end_type = 'auto'
  WHERE id = :'s';
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish(:'s', now() - interval '1 hour') AS r \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a swept shift closed after hour 12 stays at 12 hours, auto',
  :'r' = 'ok' AND s.ended_at = s.started_at + interval '12 hours' AND s.end_type = 'auto'
  FROM public.shifts s WHERE s.id = :'s';


-- ---------- D1: moved off the well, then force-closed
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id = :'ana' WHERE id = :well;
SELECT pg_temp.shift_ago('4 hours', '0') AS s \gset
UPDATE public.projects SET assigned_operator_id = :'beto' WHERE id = :well;
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.force(:'s', 'reasignado y sin señal') \g /dev/null
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.bar(:well, :'s', 'moved-bar-before', now() - interval '3 hours') AS before \gset
SELECT pg_temp.bar(:well, :'s', 'moved-bar-after', now() + interval '1 hour') AS after \gset
SELECT pg_temp.bar(:well, NULL, 'moved-bar-no-shift', now() - interval '3 hours') AS noshift \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'revoked late bar requires rejected-work review, not field RPC',
  :'before' LIKE 'ERR 42501%';
INSERT INTO results SELECT 'revoked future bar is refused by assignment boundary', :'after' LIKE 'ERR 42501%';
INSERT INTO results SELECT 'a bar not tied to that shift is still refused', :'noshift' LIKE 'ERR 42501%';
UPDATE public.projects SET assigned_operator_id = :'ana' WHERE id = :well;

-- Code read D5 (20261108150000): a queued close survives the admin changing the
-- well's materials meanwhile, and nothing else gets through.
CREATE FUNCTION pg_temp.finish_with(p_shift uuid, p_usage jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.end_shift(p_shift, p_usage, 'prueba', now(), 'manual');
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END $$;
SELECT pg_temp.act_as_owner();
UPDATE public.project_materials SET created_at = now() - interval '1 day' WHERE id = :material;
SELECT pg_temp.shift_ago(interval '2 hours', interval '0') AS d5_added \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Grava nueva', 5, 5, 'm3', true) RETURNING id AS added_material \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish_with(:'d5_added', jsonb_build_array(
  jsonb_build_object('project_material_id', :material, 'quantity_used', 1))) AS d5_added_result \gset

SELECT pg_temp.act_as_owner();
SELECT pg_temp.shift_ago(interval '2 hours', interval '0') AS d5_removed \gset
UPDATE public.project_materials SET active = false WHERE id = :added_material;
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish_with(:'d5_removed', jsonb_build_array(
  jsonb_build_object('project_material_id', :material, 'quantity_used', 0),
  jsonb_build_object('project_material_id', :added_material, 'quantity_used', 2))) AS d5_removed_result \gset

SELECT pg_temp.act_as_owner();
SELECT pg_temp.shift_ago(interval '2 hours', interval '0') AS d5_omitted \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish_with(:'d5_omitted', '[]'::jsonb) AS d5_omitted_result \gset

SELECT pg_temp.act_as_owner();
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Bentonita vieja', 5, 5, 'kg', false) RETURNING id AS old_material \gset
SET session_replication_role = replica;
UPDATE public.project_materials SET created_at = now() - interval '2 days', updated_at = now() - interval '2 days'
WHERE id = :old_material;
SET session_replication_role = DEFAULT;
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Otro pozo D5', 'active', :'beto')
RETURNING id AS other_well \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:other_well, 'Caño ajeno', 5, 5, 'u', true) RETURNING id AS foreign_material \gset
SELECT pg_temp.shift_ago(interval '2 hours', interval '0') AS d5_old \gset
SELECT pg_temp.act_as(:'ana');
SELECT pg_temp.finish_with(:'d5_old', jsonb_build_array(
  jsonb_build_object('project_material_id', :material, 'quantity_used', 0),
  jsonb_build_object('project_material_id', :old_material, 'quantity_used', 1))) AS d5_old_result \gset
SELECT pg_temp.finish_with(:'d5_old', jsonb_build_array(
  jsonb_build_object('project_material_id', :material, 'quantity_used', 0),
  jsonb_build_object('project_material_id', :foreign_material, 'quantity_used', 1))) AS d5_foreign_result \gset

SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a close may leave out a material added during the shift', :'d5_added_result' = 'ok';
INSERT INTO results SELECT 'a close may name a material removed during the shift', :'d5_removed_result' = 'ok';
INSERT INTO results SELECT 'use of a removed material is recorded and flagged',
  EXISTS (
    SELECT 1 FROM public.material_consumption
    WHERE shift_id = :'d5_removed' AND project_material_id = :added_material
      AND quantity_used = 2 AND anomaly_flag
  );
INSERT INTO results SELECT 'leaving out a material from before the shift is still refused',
  :'d5_omitted_result' LIKE 'ERR 22023%';
INSERT INTO results SELECT 'naming a material removed before the shift is still refused',
  :'d5_old_result' LIKE 'ERR 22023%';
INSERT INTO results SELECT 'naming another well''s material is still refused',
  :'d5_foreign_result' LIKE 'ERR 22023%';

\o
SELECT CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed) || '/' || count(*) || ' passed' FROM results;
ROLLBACK;
