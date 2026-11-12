-- Regression checks for 20261109140000_phc_equipo_crew.sql (shared tablet per equipo).
-- LOCAL stack only, after seed-local.js. One transaction, rolled back: no rows left.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -q -f supabase/seed/equipo-crew.sql
--
-- A call and the check that looks for the row it inserted are separate statements:
-- one statement can't see rows inserted by a function it calls.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o /dev/null
BEGIN;

CREATE TEMP TABLE results (check_name text, passed boolean) ON COMMIT DROP;
GRANT ALL ON results TO authenticated;

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
-- Runs SQL, returns 'ok' or the SQLSTATE.
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- Three operators of our own: A (operador 1), B (operador 2), C (not on the crew).
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.username || '@phc.local', '', now(), '{"provider":"email"}'::jsonb,
       jsonb_build_object('username', u.username, 'full_name', u.full_name),
       now(), now(), '', '', '', ''
FROM (VALUES ('aaaaaaaa-0000-4000-8000-0000000000e1'::uuid, 'equipo_a', 'Equipo A'),
             ('aaaaaaaa-0000-4000-8000-0000000000e2'::uuid, 'equipo_b', 'Equipo B'),
             ('aaaaaaaa-0000-4000-8000-0000000000e3'::uuid, 'equipo_c', 'Fuera C')) AS u(id, username, full_name);
\set a 'aaaaaaaa-0000-4000-8000-0000000000e1'
\set b 'aaaaaaaa-0000-4000-8000-0000000000e2'
\set c 'aaaaaaaa-0000-4000-8000-0000000000e3'
SELECT id AS admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1 \gset

INSERT INTO public.projects (name, status, assigned_operator_id)
VALUES ('Pozo equipo compartido', 'active', :'a') RETURNING id AS well \gset
INSERT INTO public.project_secondary_operators (project_id, operator_id) VALUES (:well, :'b');

-- ---------------------------------------------------------------- grants
INSERT INTO results SELECT 'anon can execute none of the new or changed functions',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private')
      AND p.proname IN ('is_project_crew', 'join_shift', 'set_project_equipo', 'get_operator_accountability_metrics',
                        'start_shift', 'end_shift', 'confirm_shift_handover', 'create_drilling_bar',
                        'register_water_sample', 'record_material_consumption', 'confirm_pedido_item_receipt',
                        'create_pedido_v2', 'submit_completion_v2', 'resubmit_completion_v2', 'begin_acting',
                        'end_acting', 'is_project_crew_for', 'add_shift_participant')
      AND has_function_privilege('anon', p.oid, 'EXECUTE'));
INSERT INTO results SELECT 'clients cannot call the acting helpers or the moved bodies',
  NOT has_function_privilege('authenticated', 'private.begin_acting(bigint, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.create_drilling_bar_core(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid)', 'EXECUTE');
INSERT INTO results SELECT 'every field RPC has exactly one signature, ending in p_entered_by',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('start_shift', 'end_shift', 'confirm_shift_handover', 'create_drilling_bar',
                       'register_water_sample', 'record_material_consumption', 'confirm_pedido_item_receipt',
                       'create_pedido_v2', 'submit_completion_v2', 'resubmit_completion_v2')
     AND p.proargnames[array_length(p.proargnames, 1)] = 'p_entered_by') = 10
  AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('start_shift', 'end_shift', 'confirm_shift_handover', 'create_drilling_bar',
                           'register_water_sample', 'record_material_consumption', 'confirm_pedido_item_receipt',
                           'create_pedido_v2', 'submit_completion_v2', 'resubmit_completion_v2')) = 10;

-- ---------------------------------------------------------------- one shift for the equipo
SELECT pg_temp.act_as(:'a');
SELECT (public.start_shift(:well, 'bbbbbbbb-0000-4000-8000-0000000000e1', 'eq-shift-a')).id AS s1 \gset
SELECT pg_temp.try(format('SELECT public.confirm_shift_handover(%L, %L::jsonb)', :'s1', '[]')) AS handover \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 1 starts and confirms the handover (old call shape)', :'handover' = 'ok';

-- B, the second operator, records on A's shift: the bar is B's.
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'eq-bar-b1', p_shift_id => %L, p_timestamp_local => now()::text)$q$, :well, :'s1')) AS bar_b \gset
-- B uploads a bar A typed earlier: the bar is A's.
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arcilla',
  p_client_entry_id => 'eq-bar-a1', p_shift_id => %L, p_timestamp_local => now()::text, p_entered_by => %L)$q$,
  :well, :'s1', :'a')) AS bar_a \gset
-- B names someone off the team.
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'eq-bar-x1', p_shift_id => %L, p_timestamp_local => now()::text, p_entered_by => %L)$q$,
  :well, :'s1', :'c')) AS bar_named_c \gset
SELECT pg_temp.act_as(:'c');
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'eq-bar-c1', p_shift_id => %L, p_timestamp_local => now()::text, p_entered_by => %L)$q$,
  :well, :'s1', :'a')) AS bar_by_c \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 2 records a bar on operador 1''s shift, as their own',
  :'bar_b' = 'ok' AND EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'eq-bar-b1' AND operator_id = :'b');
INSERT INTO results SELECT 'p_entered_by: the partner uploads, the bar is the typist''s',
  :'bar_a' = 'ok' AND EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'eq-bar-a1' AND operator_id = :'a');
INSERT INTO results SELECT 'the audit row names the uploader',
  EXISTS (SELECT 1 FROM public.audit_log l JOIN public.drilling_bars b ON b.id::text = l.entity_id
          WHERE l.entity_type = 'drilling_bars' AND b.client_entry_id = 'eq-bar-a1'
            AND l.actor_id = :'a' AND l.metadata ->> 'uploaded_by' = :'b');
INSERT INTO results SELECT 'p_entered_by naming someone off the team is refused', :'bar_named_c' = '42501'
  AND NOT EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'eq-bar-x1');
INSERT INTO results SELECT 'a caller who is not crew is refused', :'bar_by_c' = '42501'
  AND NOT EXISTS (SELECT 1 FROM public.drilling_bars WHERE client_entry_id = 'eq-bar-c1');
INSERT INTO results SELECT 'after acting, the caller is the caller again',
  (SELECT auth.uid()) IS NULL;

-- Starting while the equipo's shift runs joins it.
SELECT pg_temp.act_as(:'b');
SELECT (public.start_shift(:well, 'bbbbbbbb-0000-4000-8000-0000000000e2', 'eq-shift-b')).id AS s_b \gset
SELECT public.join_shift(:'s1') \g /dev/null
SELECT public.join_shift(:'s1') \g /dev/null
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 2 starting during the shift gets the equipo''s shift', :'s_b' = :'s1';
INSERT INTO results SELECT 'both are participants, once each',
  (SELECT count(*) FROM public.shift_participants WHERE shift_id = :'s1') = 2
  AND EXISTS (SELECT 1 FROM public.shift_participants WHERE shift_id = :'s1' AND operator_id = :'a')
  AND EXISTS (SELECT 1 FROM public.shift_participants WHERE shift_id = :'s1' AND operator_id = :'b');

-- What the second operator can read.
SELECT pg_temp.act_as(:'b');
SELECT count(*) AS b_sees_shift FROM public.shifts WHERE id = :'s1' \gset
SELECT count(*) AS b_sees_participants FROM public.shift_participants WHERE shift_id = :'s1' \gset
SELECT pg_temp.act_as(:'c');
SELECT count(*) AS c_sees_shift FROM public.shifts WHERE id = :'s1' \gset
SELECT count(*) AS c_sees_participants FROM public.shift_participants WHERE shift_id = :'s1' \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 2 reads the equipo''s shift and its participants',
  :b_sees_shift = 1 AND :b_sees_participants = 2;
INSERT INTO results SELECT 'someone off the crew reads neither', :c_sees_shift = 0 AND :c_sees_participants = 0;

-- B ends A's shift.
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format('SELECT public.end_shift(%L, %L::jsonb)', :'s1', '[]')) AS ended \gset
SELECT pg_temp.try(format('SELECT public.join_shift(%L)', :'s1')) AS late_join \gset
SELECT pg_temp.act_as(:'c');
SELECT pg_temp.try(format('SELECT public.join_shift(%L)', :'s1')) AS c_join \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 2 ends operador 1''s shift',
  :'ended' = 'ok' AND (SELECT status FROM public.shifts WHERE id = :'s1') = 'closed';
INSERT INTO results SELECT 'a late join on a closed shift is a quiet no-op', :'late_join' = 'ok'
  AND (SELECT count(*) FROM public.shift_participants WHERE shift_id = :'s1') = 2;
INSERT INTO results SELECT 'someone off the crew cannot join', :'c_join' = '42501';

-- Both get the shift in their figures; the period filters.
SELECT pg_temp.act_as(:'admin');
SELECT (public.get_operator_accountability_metrics(:'a') ->> 'shifts_completed')::int AS a_done \gset
SELECT (public.get_operator_accountability_metrics(:'b') ->> 'shifts_completed')::int AS b_done \gset
SELECT (public.get_operator_accountability_metrics(:'b', current_date + 1, current_date + 1) ->> 'shifts_completed')::int AS b_tomorrow \gset
SELECT (public.get_operator_accountability_metrics(:'b', current_date - 1, current_date + 1) ->> 'bars_registered')::int AS b_bars \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'both operators get the equipo''s shift', :a_done = 1 AND :b_done = 1;
INSERT INTO results SELECT 'p_from / p_to limit the period', :b_tomorrow = 0 AND :b_bars = 1;

-- ---------------------------------------------------------------- pedidos and receipts
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format($q$SELECT public.create_pedido_v2(%s, 'empresa',
  '[{"material_name":"Cable","requested_quantity":2,"unit":"m"}]'::jsonb, 'eq-ped-b1', 'Hace falta cable')$q$, :well)) AS ped_b \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 2 creates an empresa pedido for the well', :'ped_b' = 'ok';

-- A seeded approved empresa item: make B operador 2 of that well and confirm its delivery.
SELECT pi.id AS item, p.project_id AS item_well FROM public.pedido_items pi JOIN public.pedidos p ON p.id = pi.pedido_id
WHERE pi.state = 'aprobado' AND p.kind = 'empresa' ORDER BY pi.id LIMIT 1 \gset
INSERT INTO public.project_secondary_operators (project_id, operator_id) VALUES (:item_well, :'b') ON CONFLICT DO NOTHING;
SELECT COALESCE(sum(current_quantity),0) AS receipt_stock_before FROM public.project_materials WHERE project_id=:item_well AND active \gset
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format($q$SELECT public.confirm_pedido_item_receipt(%s, 'eq-rcpt-b1', 'parcial', 1, 'Llegó una parte')$q$, :item)) AS rcpt \gset
SELECT pg_temp.try(format($q$SELECT public.confirm_pedido_item_receipt(%s, 'eq-rcpt-b1', 'parcial', 1, 'Llegó una parte')$q$, :item)) AS replay_rcpt \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'delivery replay adds stock once', :'replay_rcpt'='ok' AND (SELECT COALESCE(sum(current_quantity),0) FROM public.project_materials WHERE project_id=:item_well AND active)=:receipt_stock_before+1 AND (SELECT count(*) FROM public.pedido_receipts WHERE client_entry_id='eq-rcpt-b1')=1;
INSERT INTO results SELECT 'operador 2 confirms an empresa delivery',
  :'rcpt' = 'ok' AND EXISTS (SELECT 1 FROM public.pedido_receipts WHERE client_entry_id = 'eq-rcpt-b1' AND confirmed_by = :'b');

-- ---------------------------------------------------------------- the Ficha
-- A seeded v2 Ficha: B as operador 2 of its well gets past the permission gate
-- (whatever else the payload lacks is a different error, not 42501).
SELECT cr.id AS ficha, cr.project_id AS ficha_well FROM public.completion_reports cr JOIN public.projects p ON p.id=cr.project_id WHERE cr.format_version >= 2 AND public.project_status_key(p.status) IN ('active','closure_submitted') ORDER BY cr.id LIMIT 1 \gset
INSERT INTO public.project_secondary_operators (project_id, operator_id) VALUES (:ficha_well, :'b') ON CONFLICT DO NOTHING;
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format($q$SELECT public.resubmit_completion_v2(%s, 'eq-resub-b1', '{}'::jsonb, 'Equipo B')$q$, :ficha)) AS resub \gset
SELECT pg_temp.act_as(:'c');
SELECT pg_temp.try(format($q$SELECT public.resubmit_completion_v2(%s, 'eq-resub-c1', '{}'::jsonb, 'Fuera C')$q$, :ficha)) AS resub_c \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'operador 2 may resubmit a returned Ficha (SRV-4)', :'resub' <> '42501';
INSERT INTO results SELECT 'someone off the crew may not', :'resub_c' = '42501';

-- ---------------------------------------------------------------- admin: equipo, audit, sessions
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format('SELECT public.set_project_equipo(%s, %L, %L)', :well, :'a', :'c')) AS equipo_by_b \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try(format('SELECT public.set_project_equipo(%s, %L, %L)', :well, :'a', :'a')) AS equipo_same \gset
SELECT pg_temp.try(format('SELECT public.set_project_equipo(%s, %L, %L)', :well, :'a', :'c')) AS equipo \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'only an admin sets a well''s equipo', :'equipo_by_b' = '42501';
INSERT INTO results SELECT 'operador 2 must differ from operador 1', :'equipo_same' = '22023';
INSERT INTO results SELECT 'set_project_equipo swaps operador 2 in one call',
  :'equipo' = 'ok'
  AND EXISTS (SELECT 1 FROM public.project_secondary_operators WHERE project_id = :well AND operator_id = :'c')
  AND NOT EXISTS (SELECT 1 FROM public.project_secondary_operators WHERE project_id = :well AND operator_id = :'b');
INSERT INTO results SELECT 'crew changes leave audit rows (SEC-4)',
  EXISTS (SELECT 1 FROM public.audit_log WHERE entity_type = 'project_secondary_operators'
            AND action = 'project_secondary_operators.delete' AND project_id = :well)
  AND EXISTS (SELECT 1 FROM public.audit_log WHERE entity_type = 'project_secondary_operators'
            AND action = 'project_secondary_operators.insert' AND project_id = :well);

INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
VALUES (gen_random_uuid(), :'c', now(), now()), (gen_random_uuid(), :'c', now(), now());
SELECT pg_temp.act_as(:'admin');
UPDATE public.profiles SET is_active = false WHERE id = :'c';
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'deactivating an operator ends their sessions (SEC-5)',
  (SELECT count(*) FROM auth.sessions WHERE user_id = :'c') = 0;
INSERT INTO results SELECT 'and leaves an audit row',
  EXISTS (SELECT 1 FROM public.audit_log WHERE entity_type = 'profiles' AND entity_id = :'c'
            AND (after_data ->> 'is_active')::boolean IS FALSE);

\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed, '
  || count(*) FILTER (WHERE passed IS NOT TRUE) || ' FAILED' FROM results;
ROLLBACK;
