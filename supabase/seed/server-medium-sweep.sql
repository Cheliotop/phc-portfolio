-- Regression checks for 20261109160000_phc_server_medium_sweep.sql (SRV.md Medium/Low sweep).
-- LOCAL stack only. One transaction, rolled back: no rows left.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -q -f supabase/seed/server-medium-sweep.sql
--
-- now() is fixed for the whole transaction, so "earlier" and "later" are set by UPDATE as the
-- owner where a check needs a shift or material to be older or newer than the call.
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
-- Helpers whose errors become values: a missing function or column is a FAIL, not an aborted transaction.
CREATE FUNCTION pg_temp.fn_priv(p_role text, p_sig text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN RETURN has_function_privilege(p_role, p_sig, 'EXECUTE');
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE FUNCTION pg_temp.tab_priv(p_role text, p_table text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN RETURN has_table_privilege(p_role, p_table, 'SELECT');
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE FUNCTION pg_temp.read(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  EXECUTE p_sql INTO r;
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE;
END $$;
CREATE FUNCTION pg_temp.assign(p_project bigint, p_variant bigint, p_qty real, p_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r bigint;
BEGIN
  SELECT (public.assign_catalog_material_to_project(p_project, p_variant, p_qty, 'extras', NULL, p_key)).id INTO r;
  RETURN r::text;
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- Five operators: A (primary on most wells), B, C, D, E.
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.username || '@phc.local', '', now(), '{"provider":"email"}'::jsonb,
       jsonb_build_object('username', u.username, 'full_name', u.full_name),
       now(), now(), '', '', '', ''
FROM (VALUES ('aaaaaaaa-0000-4000-8000-0000000000f1'::uuid, 'sweep_a', 'Sweep A'),
             ('aaaaaaaa-0000-4000-8000-0000000000f2'::uuid, 'sweep_b', 'Sweep B'),
             ('aaaaaaaa-0000-4000-8000-0000000000f3'::uuid, 'sweep_c', 'Sweep C'),
             ('aaaaaaaa-0000-4000-8000-0000000000f4'::uuid, 'sweep_d', 'Sweep D'),
             ('aaaaaaaa-0000-4000-8000-0000000000f5'::uuid, 'sweep_e', 'Sweep E')) AS u(id, username, full_name);
\set a 'aaaaaaaa-0000-4000-8000-0000000000f1'
\set b 'aaaaaaaa-0000-4000-8000-0000000000f2'
\set c 'aaaaaaaa-0000-4000-8000-0000000000f3'
\set d 'aaaaaaaa-0000-4000-8000-0000000000f4'
\set e 'aaaaaaaa-0000-4000-8000-0000000000f5'
SELECT id AS admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1 \gset
SELECT id AS variant FROM public.catalog_variants WHERE active ORDER BY id LIMIT 1 \gset
\set fields '{"static_level":10,"dynamic_level":20,"flow_rate":5000,"maximum_flow_rate":6000,"pump_depth_m":30,"exploration_depth_m":50,"widening_depth_m":40,"casing_total_m":40,"casing_above_ground_m":1,"blind_casing_m":10,"filter_casing_m":30,"sediment_trap_m":0,"centralizer_count":2,"bottom_plug_details":"Tapon de fondo","bentonite_quantity":1,"gravel_quantity":1,"casing_layout":[{"type":"ciego","order":1,"meters":10},{"type":"filtro","order":2,"meters":30}]}'

INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep Ficha A', 'active', :'a') RETURNING id AS f1 \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep Ficha B', 'active', :'b') RETURNING id AS f2 \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep vida', 'active', :'c') RETURNING id AS life \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep forzar', 'active', :'c') RETURNING id AS fc \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep mano', 'active', :'a') RETURNING id AS hand \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep inicio', 'active', :'b') RETURNING id AS start_well \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep otro', 'active', :'d') RETURNING id AS other \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep sin flag', 'active', :'d') RETURNING id AS nf \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep metricas', 'active', :'e') RETURNING id AS met \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Sweep asignar', 'active', :'a') RETURNING id AS asg \gset
INSERT INTO public.project_secondary_operators (project_id, operator_id) VALUES (:other, :'b');
INSERT INTO public.project_secondary_operators (project_id, operator_id) VALUES (:start_well, :'a');

-- ---------------------------------------------------------------- grants
INSERT INTO results SELECT 'anon cannot run the new force-close or assignment signatures',
  pg_temp.fn_priv('anon', 'public.force_close_shift(uuid, text, timestamp with time zone)') IS FALSE
  AND pg_temp.fn_priv('anon', 'public.assign_catalog_material_to_project(bigint, bigint, real, text, text, text)') IS FALSE;
INSERT INTO results SELECT 'clients cannot call the new private helpers or read the attempts table',
  pg_temp.fn_priv('authenticated', 'private.shift_paid_end(uuid, timestamp with time zone, timestamp with time zone, text)') IS FALSE
  AND pg_temp.fn_priv('authenticated', 'private.try_timestamptz(text)') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'private.catalog_assignment_attempts') IS FALSE;

-- ---------------------------------------------------------------- SRV-5: the override flag is the operator's
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format('SELECT public.submit_completion_v2(%s, %L, %L::jsonb, %L)', :f1, 'sweep-ficha-1', :'fields', 'Operador A')) AS sub1 \gset
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format('SELECT public.submit_completion_v2(%s, %L, %L::jsonb, %L)', :f2, 'sweep-ficha-2',
  (:'fields'::jsonb || '{"specific_flow_rate": 400}'::jsonb)::text, 'Operador B')) AS sub2 \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a Ficha sent without the specific flow is stored as computed, not overridden (SRV-5)',
  :'sub1' = 'ok' AND EXISTS (SELECT 1 FROM public.completion_reports WHERE client_entry_id = 'sweep-ficha-1'
    AND NOT specific_flow_overridden AND abs(specific_flow_rate - 500) < 0.01);
INSERT INTO results SELECT 'a Ficha with an operator-typed specific flow stays overridden, and the mismatch is kept',
  :'sub2' = 'ok' AND EXISTS (SELECT 1 FROM public.completion_reports WHERE client_entry_id = 'sweep-ficha-2'
    AND specific_flow_overridden AND abs(specific_flow_rate - 400) < 0.01 AND hydraulic_mismatch);
SELECT id AS rep1 FROM public.completion_reports WHERE client_entry_id = 'sweep-ficha-1' \gset

-- Admin returns Ficha 1; SRV-4 (11): the admin hands the returned Ficha's closing role to B.
SELECT pg_temp.act_as(:'admin');
SELECT (public.return_completion_v2(:rep1, 'Revisar la dinámica')).id AS ret1 \gset
SELECT pg_temp.try(format('SELECT public.set_project_closing_operator(%s, %L)', :f1, :'b')) AS reassign \gset
SELECT pg_temp.try(format('SELECT public.set_project_closing_operator(%s, %L)', :f2, :'a')) AS reassign_submitted \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the admin can hand a returned Ficha''s closing role to another operator (SRV-4)', :'reassign' = 'ok';
INSERT INTO results SELECT 'but not while the Ficha is still submitted for review', :'reassign_submitted' = '55000';

-- A returned Ficha is resubmitted with the computed flow: the stored value follows the new levels.
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format('SELECT public.resubmit_completion_v2(%s, %L, %L::jsonb, %L)', :rep1, 'sweep-resub-1',
  (:'fields'::jsonb || '{"dynamic_level": 25}'::jsonb)::text, 'Operador A')) AS resub1 \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a resubmitted Ficha recalculates the specific flow and is not overridden (SRV-5)',
  :'resub1' = 'ok' AND EXISTS (SELECT 1 FROM public.completion_reports WHERE id = :rep1
    AND NOT specific_flow_overridden AND abs(specific_flow_rate - 5000.0/15) < 0.01);

-- ---------------------------------------------------------------- SRV-7: a submitted Ficha cannot be cancelled or reactivated away
SELECT pg_temp.act_as(:'c');
SELECT pg_temp.try(format('SELECT public.submit_completion_v2(%s, %L, %L::jsonb, %L)', :life, 'sweep-life-1', :'fields', 'Operador C')) AS sub_life \gset
SELECT id AS rep_life FROM public.completion_reports WHERE client_entry_id = 'sweep-life-1' \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try(format('UPDATE public.projects SET status = %L WHERE id = %s', 'cancelled', :life)) AS cancel_submitted \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a well with a submitted Ficha cannot be cancelled (SRV-7)',
  :'sub_life' = 'ok' AND :'cancel_submitted' = '55000'
  AND (SELECT status FROM public.projects WHERE id = :life) = 'closure_submitted';

SELECT pg_temp.act_as(:'admin');
SELECT (public.return_completion_v2(:rep_life, 'Falta el caudal')).id AS ret_life \gset
SELECT pg_temp.try(format('UPDATE public.projects SET status = %L WHERE id = %s', 'cancelled', :life)) AS cancel_returned \gset
SELECT pg_temp.try(format('UPDATE public.projects SET status = %L WHERE id = %s', 'active', :life)) AS reactivate \gset
SELECT pg_temp.act_as(:'c');
SELECT pg_temp.try(format('SELECT public.resubmit_completion_v2(%s, %L, %L::jsonb, %L)', :rep_life, 'sweep-life-resub',
  :'fields', 'Operador C')) AS resub_life \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a returned Ficha may be cancelled and reactivated (guard)',
  :'cancel_returned' = 'ok' AND :'reactivate' = 'ok';
INSERT INTO results SELECT 'a Ficha resubmitted on a reactivated well locks the well for review (SRV-7)',
  :'resub_life' = 'ok' AND (SELECT status FROM public.projects WHERE id = :life) = 'closure_submitted';

-- ---------------------------------------------------------------- SRV-6: a handover queued before a material change
SELECT pg_temp.act_as_owner();
INSERT INTO public.project_materials (project_id, material_name, quantity_allocated, initial_quantity, current_quantity, unit, layer, active)
VALUES (:hand, 'Sweep caño', 20, 20, 20, 'm', 'presupuesto', true) RETURNING id AS m1 \gset
INSERT INTO public.project_materials (project_id, material_name, quantity_allocated, initial_quantity, current_quantity, unit, layer, active)
VALUES (:hand, 'Sweep bentonita', 5, 5, 5, 'kg', 'presupuesto', true) RETURNING id AS m2 \gset
INSERT INTO public.project_materials (project_id, material_name, quantity_allocated, initial_quantity, current_quantity, unit, layer, active, created_at, updated_at)
VALUES (:hand, 'Sweep viejo', 1, 1, 1, 'kg', 'presupuesto', false, now() - interval '2 days', now() - interval '1 day') RETURNING id AS m5 \gset

SELECT pg_temp.act_as(:'a');
SELECT (public.start_shift(:hand, 'cccccccc-0000-4000-8000-0000000000a1', 'sweep-hand-1')).id AS s_hand \gset
-- A material removed before the shift is still refused when the phone names it.
SELECT pg_temp.try(format('SELECT public.confirm_shift_handover(%L, %L::jsonb)', :'s_hand',
  format('[{"project_material_id":%s},{"project_material_id":%s},{"project_material_id":%s}]', :m1, :m2, :m5))) AS hand_old_removed \gset
SELECT pg_temp.act_as_owner();
-- The bentonite is removed during the shift; the crew's phone still lists it.
UPDATE public.project_materials SET active = false, updated_at = now() WHERE id = :m2;
-- A material added during the shift; the phone cannot know it yet.
INSERT INTO public.project_materials (project_id, material_name, quantity_allocated, initial_quantity, current_quantity, unit, layer, active, created_at)
VALUES (:hand, 'Sweep agregado', 3, 3, 3, 'm', 'presupuesto', true, now() + interval '1 minute') RETURNING id AS m3 \gset
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format('SELECT public.confirm_shift_handover(%L, %L::jsonb)', :'s_hand',
  format('[{"project_material_id":%s},{"project_material_id":%s}]', :m1, :m2))) AS hand_changed \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an operator names a material removed before the shift and is refused (guard)', :'hand_old_removed' = '22023';
INSERT INTO results SELECT 'a handover queued before a material was added or removed is accepted (SRV-6)',
  :'hand_changed' = 'ok'
  AND EXISTS (SELECT 1 FROM public.shift_handovers WHERE shift_id = :'s_hand' AND project_material_id = :m2)
  AND NOT EXISTS (SELECT 1 FROM public.shift_handovers WHERE shift_id = :'s_hand' AND project_material_id = :m3);

-- ---------------------------------------------------------------- SRV-13: a bar recorded before the previous one arrived late
UPDATE public.shifts SET started_at = now() - interval '2 hours' WHERE id = :'s_hand';
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'sweep-bar-1', p_shift_id => %L, p_timestamp_local => %L)$q$, :hand, :'s_hand',
  (now() - interval '30 minutes')::text)) AS bar1 \gset
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'sweep-bar-2', p_shift_id => %L, p_timestamp_local => %L)$q$, :hand, :'s_hand',
  (now() - interval '60 minutes')::text)) AS bar2 \gset
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'sweep-bar-3', p_shift_id => %L, p_timestamp_local => %L)$q$, :hand, :'s_hand',
  (now() - interval '10 minutes')::text)) AS bar3 \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the bar recorded before the well''s previous bar is marked arrived late (SRV-13)',
  :'bar1' = 'ok' AND :'bar2' = 'ok' AND :'bar3' = 'ok'
  AND pg_temp.read($q$SELECT arrived_late::text FROM public.drilling_bars WHERE client_entry_id = 'sweep-bar-2'$q$) = 'true'
  AND pg_temp.read($q$SELECT arrived_late::text FROM public.drilling_bars WHERE client_entry_id = 'sweep-bar-1'$q$) = 'false'
  AND pg_temp.read($q$SELECT arrived_late::text FROM public.drilling_bars WHERE client_entry_id = 'sweep-bar-3'$q$) = 'false';
-- The late bar stays at the end of the well.
INSERT INTO results SELECT 'a late bar keeps its place at the end of the well (numbering unchanged)',
  (SELECT bar_number FROM public.drilling_bars WHERE client_entry_id = 'sweep-bar-2') = 2;

-- Close the handover shift cleanly (auto-check of the new end_shift rules).
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format('SELECT public.end_shift(%L, %L::jsonb)', :'s_hand',
  format('[{"project_material_id":%s,"quantity_used":0}]', :m1))) AS end_hand \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the shift with the changed materials closes (SRV-6)', :'end_hand' = 'ok';

-- ---------------------------------------------------------------- SRV-10: an assignment retried with its key is added once
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.assign(:asg, :variant, 120, 'sweep-assign-1') AS asg1 \gset
SELECT pg_temp.assign(:asg, :variant, 120, 'sweep-assign-1') AS asg2 \gset
SELECT pg_temp.try(format('SELECT public.assign_catalog_material_to_project(%s, %s, 50, %L, NULL, %L)',
  :asg, :variant, 'extras', 'sweep-assign-1')) AS asg_other \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a retried assignment returns the first row and adds nothing (SRV-10)',
  :'asg1' NOT LIKE 'ERR%' AND :'asg1' = :'asg2'
  AND (SELECT count(*) FROM public.project_materials WHERE project_id = :asg AND catalog_variant_id = :variant AND active) = 1
  AND (SELECT current_quantity::text FROM public.project_materials WHERE id::text = :'asg1') = '120';
INSERT INTO results SELECT 'the same key with another quantity is refused', :'asg_other' = '23505';

-- ---------------------------------------------------------------- SRV-12 (D3) and SRV-15: the server starts the shift
SELECT pg_temp.act_as(:'b');
SELECT (public.start_shift(:start_well, 'cccccccc-0000-4000-8000-0000000000b1', 'sweep-d3-1',
  now() - interval '3 hours', now() - interval '3 hours')).id AS s6 \gset
SELECT pg_temp.try(format('SELECT public.start_shift(%s, %L::uuid, %L)', :other, 'cccccccc-0000-4000-8000-0000000000b2', 'sweep-d3-other')) AS other_well \gset
SELECT pg_temp.act_as(:'d');
SELECT (public.start_shift(:nf, 'cccccccc-0000-4000-8000-0000000000d1', 'sweep-d3-nf',
  now() - interval '5 minutes', now() - interval '5 minutes')).id AS s_nf \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the start time is the server clock, not the phone''s (D3)',
  (SELECT started_at >= now() - interval '1 minute' FROM public.shifts WHERE id = :'s6')
  AND (SELECT start_device_time = now() - interval '3 hours' FROM public.shifts WHERE id = :'s6');
INSERT INTO results SELECT 'a phone start more than 10 minutes off is flagged',
  (SELECT device_time_flag FROM public.shifts WHERE id = :'s6')
  AND NOT (SELECT device_time_flag FROM public.shifts WHERE id = :'s_nf');
INSERT INTO results SELECT 'a start on another well while the open shift is elsewhere is refused (SRV-15)',
  :'other_well' = '55000'
  AND (SELECT count(*) FROM public.shifts WHERE client_entry_id = 'sweep-d3-other') = 0;

-- ---------------------------------------------------------------- SRV-11 and the force-close pay decision
SELECT pg_temp.act_as(:'c');
SELECT (public.start_shift(:fc, 'cccccccc-0000-4000-8000-0000000000c1', 'sweep-fc-1')).id AS s_fc \gset
SELECT pg_temp.act_as_owner();
UPDATE public.shifts SET started_at = now() - interval '5 hours' WHERE id = :'s_fc';
SELECT now() - interval '2 hours' AS real_end \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try(format('SELECT public.force_close_shift(%L, %L, %L::timestamptz)', :'s_fc', 'Cierre con hora real', :'real_end')) AS fc_real \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an admin force-close can give the real end time (pay decision)',
  :'fc_real' = 'ok' AND (SELECT ended_at = :'real_end'::timestamptz AND status = 'closed' AND end_type = 'admin'
                         FROM public.shifts WHERE id = :'s_fc');

SELECT pg_temp.act_as(:'c');
SELECT (public.start_shift(:fc, 'cccccccc-0000-4000-8000-0000000000c2', 'sweep-fc-2')).id AS s_fc2 \gset
SELECT pg_temp.act_as_owner();
UPDATE public.shifts SET started_at = now() - interval '20 hours' WHERE id = :'s_fc2';
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try(format('SELECT public.force_close_shift(%L, %L, %L::timestamptz)', :'s_fc2', 'Demasiado tarde', now() - interval '1 hour')) AS fc_long \gset
SELECT pg_temp.try(format('SELECT public.force_close_shift(%L, %L, %L::timestamptz)', :'s_fc2', 'Futuro', now() + interval '1 hour')) AS fc_future \gset
SELECT pg_temp.try(format('SELECT public.force_close_shift(%L, %L, %L::timestamptz)', :'s_fc2', 'Antes del inicio', now() - interval '30 hours')) AS fc_before \gset
SELECT pg_temp.try(format('SELECT public.force_close_shift(%L, %L)', :'s_fc2', 'Sin hora real')) AS fc_default \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a force-close more than 12 hours after the start is refused', :'fc_long' = '22023';
INSERT INTO results SELECT 'a force-close in the future is refused', :'fc_future' = '22023';
INSERT INTO results SELECT 'a force-close before the start is refused', :'fc_before' = '22023';
INSERT INTO results SELECT 'without a real end time the close is capped at 12 hours', :'fc_default' = 'ok'
  AND (SELECT ended_at = started_at + interval '12 hours' FROM public.shifts WHERE id = :'s_fc2');

-- SRV-11: an auto-closed shift pays up to its last activity, and is counted as abandoned.
SELECT pg_temp.act_as(:'e');
SELECT (public.start_shift(:met, 'cccccccc-0000-4000-8000-0000000000e1', 'sweep-met-1')).id AS s_met \gset
SELECT pg_temp.act_as_owner();
UPDATE public.shifts SET started_at = now() - interval '13 hours', status = 'report_pending',
  ended_at = now() - interval '1 hour', end_type = 'auto', device_time_flag = true
WHERE id = :'s_met';
INSERT INTO public.drilling_bars (client_entry_id, project_id, operator_id, bar_number, depth_start, depth_end,
  length, soil_type, shift_id, created_at)
VALUES ('sweep-met-bar', :met, :'e', 1, 0, 3, 3, 'Arena', :'s_met', now() - interval '12 hours');
SELECT pg_temp.act_as(:'e');
SELECT pg_temp.read($q$SELECT public.get_operator_accountability_metrics() ->> 'hours_worked'$q$) AS hours_e \gset
SELECT pg_temp.read($q$SELECT public.get_operator_accountability_metrics() ->> 'abandoned_shifts'$q$) AS abandoned_e \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an abandoned shift pays up to its last recorded activity (SRV-11)', :'hours_e' IN ('1', '1.00');
INSERT INTO results SELECT 'abandoned shifts are counted separately (SRV-11)', :'abandoned_e' = '1';

-- ---------------------------------------------------------------- SRV-8: the operator's own mark, whoever reported it
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.try(format($q$SELECT public.report_rejected_work('sweep-sent-1', %L, 'pedido_v2', 'local-1', 'UPSERT',
  %L::jsonb, 'denied (42501)', now())$q$, :'a', jsonb_build_object('projectId', :start_well)::text)) AS rep_sent \gset
SELECT pg_temp.act_as(:'a');
SELECT public.mark_rejected_work_sent('sweep-sent-1') AS marked \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the operator can mark work another crew member reported as sent (SRV-8)',
  :'rep_sent' = 'ok' AND :'marked' = 't'
  AND EXISTS (SELECT 1 FROM public.rejected_work_reports WHERE client_entry_id = 'sweep-sent-1' AND sent_later_at IS NOT NULL);

-- ---------------------------------------------------------------- SRV-9: a receipt confirmed before a manual close still lands
-- A seeded approved empresa item. The admin closes its pedido by hand; then the crew's queued
-- "recibido" for the full quantity arrives. It is booked, and the pedido stays closed.
SELECT pi.id AS late_item, pi.approved_quantity AS late_qty, p.id AS late_pedido,
       p.operator_id AS late_op, p.project_id AS late_well
FROM public.pedido_items pi JOIN public.pedidos p ON p.id = pi.pedido_id
WHERE pi.state = 'aprobado' AND p.kind = 'empresa' ORDER BY pi.id LIMIT 1 \gset
SELECT COALESCE(sum(current_quantity), 0) AS late_stock_before FROM public.project_materials
WHERE project_id = :late_well AND active \gset
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try(format($q$SELECT public.close_pedido_manually(%s, 'No llegó, se cierra')$q$, :late_pedido)) AS late_close \gset
SELECT pg_temp.act_as(:'late_op');
SELECT pg_temp.try(format($q$SELECT public.confirm_pedido_item_receipt(%s, 'sweep-late-rcpt', 'recibido', %s)$q$,
  :late_item, :late_qty)) AS late_rcpt \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a delivery confirmed before a manual close is accepted after it (SRV-9)',
  :'late_close' = 'ok' AND :'late_rcpt' = 'ok'
  AND EXISTS (SELECT 1 FROM public.pedido_receipts WHERE client_entry_id = 'sweep-late-rcpt');
INSERT INTO results SELECT 'it books the stock, closes the item as recibido and the pedido stays Cerrado (SRV-9)',
  (SELECT COALESCE(sum(current_quantity), 0) FROM public.project_materials WHERE project_id = :late_well AND active)
    = :late_stock_before + :late_qty
  AND EXISTS (SELECT 1 FROM public.pedido_items WHERE id = :late_item AND state = 'recibido'
              AND received_quantity = :late_qty AND incident_note LIKE '%antes del cierre manual%')
  AND EXISTS (SELECT 1 FROM public.pedidos WHERE id = :late_pedido AND status = 'Cerrado' AND closed_manually);
-- A second, different receipt for the same item is still refused: nothing more is awaited.
SELECT pg_temp.act_as(:'late_op');
SELECT pg_temp.try(format($q$SELECT public.confirm_pedido_item_receipt(%s, 'sweep-late-rcpt-2', 'parcial', 1, 'otra')$q$,
  :late_item)) AS late_rcpt2 \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a further receipt on that item is refused (SRV-9)', :'late_rcpt2' = '22023';

\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed, '
  || count(*) FILTER (WHERE passed IS NOT TRUE) || ' FAILED' FROM results;
ROLLBACK;
