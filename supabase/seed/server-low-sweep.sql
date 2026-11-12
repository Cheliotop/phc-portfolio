-- Regression checks for 20261110100000_phc_server_low_sweep.sql (docs/audits/2026-11-08-full-audit, Low items).
-- LOCAL stack only. One transaction, rolled back: no rows left.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -q -f supabase/seed/server-low-sweep.sql
--
-- now() is fixed for the whole transaction. Expected SQLSTATEs are checked, messages are not (except where a
-- client matches on them).
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
CREATE FUNCTION pg_temp.tab_priv(p_role text, p_table text, p_priv text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN RETURN has_table_privilege(p_role, p_table, p_priv);
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
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- Fixtures: operators A, B and E are active operators; I is an operator deactivated in this transaction.
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.username || '@phc.local', '', now(), '{"provider":"email"}'::jsonb,
       jsonb_build_object('username', u.username, 'full_name', u.full_name),
       now(), now(), '', '', '', ''
FROM (VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1'::uuid, 'low_a', 'Low A'),
             ('aaaaaaaa-0000-4000-8000-0000000000a2'::uuid, 'low_b', 'Low B'),
             ('aaaaaaaa-0000-4000-8000-0000000000a3'::uuid, 'low_i', 'Low I')) AS u(id, username, full_name);
\set a 'aaaaaaaa-0000-4000-8000-0000000000a1'
\set b 'aaaaaaaa-0000-4000-8000-0000000000a2'
\set i 'aaaaaaaa-0000-4000-8000-0000000000a3'
SELECT id AS admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1 \gset
UPDATE public.profiles SET is_active = false WHERE id = :'i';

-- ---------------------------------------------------------------- ADM-10: a well's operator is an active operator
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo asignado', 'active', :'a') RETURNING id AS asg \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo editable', 'active', :'b') RETURNING id AS edit_well \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo pausa', 'active', :'a') RETURNING id AS pause_well \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo fijo', 'active', :'b') RETURNING id AS fixed_well \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo activo', 'active', :'a') RETURNING id AS active_well \gset
-- An operator who is deactivated after being assigned keeps the well: rows that do not change the assignee are not checked.
UPDATE public.profiles SET is_active = false WHERE id = :'b';
UPDATE public.projects SET status = 'paused' WHERE id = :fixed_well;
INSERT INTO results SELECT 'a well stays with an operator deactivated since, when only other columns change (ADM-10)',
  pg_temp.try(format('UPDATE public.projects SET name = %L WHERE id = %s', 'Low pozo renombrado', :fixed_well)) = 'ok';
UPDATE public.profiles SET is_active = true WHERE id = :'b';

INSERT INTO results SELECT 'an admin cannot be made a well''s operator on update (ADM-10)',
  pg_temp.try(format('UPDATE public.projects SET assigned_operator_id = %L WHERE id = %s', :'admin', :asg)) = '22023';
INSERT INTO results SELECT 'an admin cannot be made a well''s operator on insert (ADM-10)',
  pg_temp.try(format('INSERT INTO public.projects (name, status, assigned_operator_id) VALUES (%L, %L, %L)', 'Low pozo admin', 'active', :'admin')) = '22023';
INSERT INTO results SELECT 'a deactivated operator cannot be assigned to a well (ADM-10)',
  pg_temp.try(format('UPDATE public.projects SET assigned_operator_id = %L WHERE id = %s', :'i', :asg)) = '22023';
INSERT INTO results SELECT 'an active operator can be assigned to a well (ADM-10)',
  pg_temp.try(format('UPDATE public.projects SET assigned_operator_id = %L WHERE id = %s', :'b', :asg)) = 'ok';
INSERT INTO results SELECT 'a well with no operator is still allowed (ADM-10)',
  pg_temp.try(format('UPDATE public.projects SET assigned_operator_id = NULL WHERE id = %s', :asg)) = 'ok';

-- ADM-10: an approval on a paused well is refused; on an active well it works.
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format($q$SELECT public.create_pedido_v2(%s, 'empresa', %L::jsonb, 'low-ped-pausa', 'Obra de prueba', 'Normal', NULL, NULL)$q$,
  :pause_well, '[{"material_name":"Cemento","requested_quantity":2,"unit":"bolsa"}]')) AS ped_pausa \gset
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format($q$SELECT public.create_pedido_v2(%s, 'empresa', %L::jsonb, 'low-ped-activo', 'Obra de prueba', 'Normal', NULL, NULL)$q$,
  :active_well, '[{"material_name":"Arena","requested_quantity":3,"unit":"m3"}]')) AS ped_activo \gset
SELECT pg_temp.act_as_owner();
SELECT pi.id AS item_pausa FROM public.pedido_items pi JOIN public.pedidos p ON p.id = pi.pedido_id WHERE p.client_entry_id = 'low-ped-pausa' \gset
SELECT pi.id AS item_activo FROM public.pedido_items pi JOIN public.pedidos p ON p.id = pi.pedido_id WHERE p.client_entry_id = 'low-ped-activo' \gset
UPDATE public.projects SET status = 'paused' WHERE id = :pause_well;
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try(format('SELECT public.decide_pedido_item(%s, %L)', :item_pausa, 'aprobado')) AS approve_paused \gset
SELECT pg_temp.try(format('SELECT public.decide_pedido_item(%s, %L)', :item_activo, 'aprobado')) AS approve_active \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an item on a paused well cannot be approved (ADM-10)', :'approve_paused' = '55000';
INSERT INTO results SELECT 'an item on an active well is still approved (ADM-10)', :'approve_active' = 'ok';


-- ---------------------------------------------------------------- SEC-11: dead write policies are gone
INSERT INTO results SELECT 'the ten dead write policies are dropped (SEC-11)',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname IN (
     'Admins can update any drilling bar', 'Only admins can update pedidos status',
     'Only admins can update completion reports', 'Only admins can insert materials',
     'Only admins can update materials', 'Only admins can manage project materials',
     'Only admins can update project materials', 'Only admins can delete project materials',
     'Users can insert own transactions', 'Operators can submit reports')) = 0;
-- The tables still have no write grant for signed-in users, so nothing reopened (SEC-11).
INSERT INTO results SELECT 'the tables behind them still grant no write to signed-in users (SEC-11)',
  pg_temp.tab_priv('authenticated', 'public.drilling_bars', 'UPDATE') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'public.completion_reports', 'UPDATE') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'public.pedidos', 'UPDATE') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'public.materials', 'INSERT') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'public.project_materials', 'DELETE') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'public.material_transactions', 'INSERT') IS FALSE
  AND pg_temp.tab_priv('authenticated', 'public.progress_reports', 'INSERT') IS FALSE;
-- The live policies on the same tables are untouched.
INSERT INTO results SELECT 'the live read policies on those tables are kept (SEC-11)',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drilling_bars'
     AND policyname = 'Read own team closing or admin drilling bars') = 1
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'project_materials'
     AND policyname = 'Read assigned closing or admin project materials') = 1;


-- ---------------------------------------------------------------- SEC-12: photos stay in their own well's folder
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo fotos', 'active', :'a') RETURNING id AS photo_well \gset
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo ajeno', 'active', :'b') RETURNING id AS other_well \gset
SELECT pg_temp.act_as(:'a');
SELECT (public.start_shift(:photo_well, 'bbbbbbbb-0000-4000-8000-0000000000f1', 'low-shift-fotos')).id AS s_foto \gset
SELECT pg_temp.try(format('SELECT public.confirm_shift_handover(%L, %L::jsonb)', :'s_foto', '[]')) AS foto_handover \gset
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'low-bar-ajena', p_shift_id => %L, p_timestamp_local => now()::text,
  p_photo_paths => %L)$q$, :photo_well, :'s_foto', format('[{"id": 1, "filename": "%s/otra.jpg"}]', :other_well))) AS bar_ajena \gset
SELECT pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'low-bar-propia', p_shift_id => %L, p_timestamp_local => now()::text,
  p_photo_paths => %L)$q$, :photo_well, :'s_foto', format('[{"id": 2, "filename": "%s/propia.jpg"}, "sin-nombre"]', :photo_well))) AS bar_propia \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the shift for the photo checks starts and confirms (SEC-12)', :'foto_handover' = 'ok' AND :'s_foto' IS NOT NULL;
INSERT INTO results SELECT 'a bar whose photo sits in another well''s folder is refused (SEC-12)', :'bar_ajena' = '22023';
INSERT INTO results SELECT 'a bar with its own well''s photo, and an entry without a filename, is accepted (SEC-12)', :'bar_propia' = 'ok';

-- ---------------------------------------------------------------- SEC-12: client_errors text is cut to 8000 characters
INSERT INTO public.client_errors (client_entry_id, occurred_at, app_version, message, stack)
VALUES ('low-err-1', now(), '1.0.0', repeat('m', 100000), repeat('s', 20000))
RETURNING length(message) AS msg_len, length(stack) AS stack_len \gset
INSERT INTO results SELECT 'a client error message and stack are capped at 8000 characters, not refused (SEC-12)',
  :msg_len = 8000 AND :stack_len = 8000;
INSERT INTO public.client_errors (client_entry_id, occurred_at, app_version, message)
VALUES ('low-err-2', now(), '1.0.0', 'corto') RETURNING message AS short_msg \gset
INSERT INTO results SELECT 'a short client error is stored unchanged (SEC-12)', :'short_msg' = 'corto';


-- ---------------------------------------------------------------- SEC-15: the project_allows_* helpers are not for clients
INSERT INTO results SELECT 'signed-in and anonymous users cannot call the three project_allows_* helpers (SEC-15)',
  pg_temp.fn_priv('authenticated', 'public.project_allows_field_work(bigint)') IS FALSE
  AND pg_temp.fn_priv('authenticated', 'public.project_allows_closure_change(bigint)') IS FALSE
  AND pg_temp.fn_priv('authenticated', 'public.project_allows_planning_change(bigint)') IS FALSE
  AND pg_temp.fn_priv('anon', 'public.project_allows_field_work(bigint)') IS FALSE
  AND pg_temp.fn_priv('anon', 'public.project_allows_closure_change(bigint)') IS FALSE
  AND pg_temp.fn_priv('anon', 'public.project_allows_planning_change(bigint)') IS FALSE
  AND pg_temp.fn_priv('public', 'public.project_allows_field_work(bigint)') IS FALSE;
INSERT INTO results SELECT 'service_role keeps EXECUTE on the helpers (SEC-15)',
  pg_temp.fn_priv('service_role', 'public.project_allows_field_work(bigint)') IS TRUE
  AND pg_temp.fn_priv('service_role', 'public.project_allows_closure_change(bigint)') IS TRUE
  AND pg_temp.fn_priv('service_role', 'public.project_allows_planning_change(bigint)') IS TRUE;
-- The definer RPCs that use them still work for an operator (create_pedido_v2 checks field work).
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.try(format($q$SELECT public.create_pedido_v2(%s, 'empresa', %L::jsonb, 'low-ped-sec15', 'Obra de prueba', 'Normal', NULL, NULL)$q$,
  :active_well, '[{"material_name":"Grava","requested_quantity":1,"unit":"m3"}]')) AS sec15_ped \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'an operator can still create a pedido on an open well through the definer RPC (SEC-15)', :'sec15_ped' = 'ok';


-- ---------------------------------------------------------------- SRV-14: Spanish (vos) refusals for operators
-- Returns 'ok' or 'SQLSTATE message'.
CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END $$;
-- B is not on A's well: closing its shift is refused in Spanish, same SQLSTATE as before (42501).
SELECT pg_temp.act_as(:'b');
SELECT pg_temp.err(format('SELECT public.end_shift(%L, %L::jsonb, %L)', :'s_foto', '[]', 'prueba')) AS end_ajeno \gset
SELECT pg_temp.act_as(:'a');
-- A bar without a shift, on a well that is not yet shift-bound: the stable marker stays first.
SELECT pg_temp.err(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => 'Arena',
  p_client_entry_id => 'low-bar-sin-turno')$q$, :photo_well)) AS sin_turno \gset
-- A bar with no soil type: Spanish, 22023.
SELECT pg_temp.err(format($q$SELECT public.create_drilling_bar(p_project_id => %s, p_soil_type => '',
  p_client_entry_id => 'low-bar-sin-suelo', p_shift_id => %L, p_timestamp_local => now()::text)$q$, :photo_well, :'s_foto')) AS sin_suelo \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'closing a shift that is not yours is refused in Spanish, 42501 kept (SRV-14)',
  (:'end_ajeno' LIKE '42501 No tenés acceso a este turno%' OR :'end_ajeno' LIKE '42501 No tenés acceso a este pozo%');
INSERT INTO results SELECT 'a bar without a shift keeps its SHIFT_REQUIRED marker, now with Spanish text (SRV-14)',
  :'sin_turno' LIKE '0A000 SHIFT_REQUIRED: %' AND :'sin_turno' NOT LIKE '%update the app%';
INSERT INTO results SELECT 'a bar with no soil type is refused in Spanish with 22023 (SRV-14)',
  :'sin_suelo' = '22023 Falta el tipo de suelo';
-- Strings that clients match on stay exactly as they were.
INSERT INTO results SELECT 'the confirmed-handover idempotency message keeps its English prefix (coordinator constraint)',
  (SELECT prosrc FROM pg_proc WHERE proname = 'confirm_shift_handover_core') LIKE '%Idempotency replay does not match the confirmed handover%';
INSERT INTO results SELECT 'the English refusals that clients match on are still in the function text (SRV-14)',
  (SELECT prosrc FROM pg_proc WHERE proname = 'end_shift_core') LIKE '%Shift cannot be closed from status %'
  AND (SELECT prosrc FROM pg_proc WHERE proname = 'end_shift_core') LIKE '%Idempotency replay does not match%'
  AND (SELECT prosrc FROM pg_proc WHERE proname = 'start_shift_core') LIKE '%Idempotency key%'
  AND (SELECT prosrc FROM pg_proc WHERE proname = 'create_drilling_bar_20260712_impl') LIKE '%SHIFT_REQUIRED%';


-- ---------------------------------------------------------------- SRV-18: a zero line for a removed material does not block the close
INSERT INTO public.projects (name, status, assigned_operator_id) VALUES ('Low pozo materiales', 'active', :'a') RETURNING id AS mat_well \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:mat_well, 'Low material vigente', 5, 5, 'u', true) RETURNING id AS mat_on \gset
-- Removed long before this shift (an UPDATE would stamp updated_at with now(), so it is inserted removed).
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active, created_at, updated_at)
VALUES (:mat_well, 'Low material quitado', 5, 5, 'u', false, '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00') RETURNING id AS mat_off \gset
SELECT pg_temp.act_as(:'a');
-- A closes the photo-check shift first: one open shift per operator.
SELECT pg_temp.err(format('SELECT public.end_shift(%L, %L::jsonb, %L, now(), %L)', :'s_foto', '[]', 'cierre', 'manual')) AS cierre_foto \gset
SELECT (public.start_shift(:mat_well, 'bbbbbbbb-0000-4000-8000-0000000000f2', 'low-shift-mat')).id AS s_mat \gset
SELECT pg_temp.try(format('SELECT public.confirm_shift_handover(%L, %L::jsonb)', :'s_mat',
  format('[{"project_material_id": %s}]', :mat_on))) AS mat_handover \gset
SELECT pg_temp.err(format('SELECT public.end_shift(%L, %L::jsonb, %L, now(), %L)', :'s_mat',
  format('[{"project_material_id": %s, "quantity_used": 0}, {"project_material_id": %s, "quantity_used": 0}]', :mat_on, :mat_off),
  'prueba', 'manual')) AS mat_close \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a zero-quantity line for a material removed before the shift does not fail the close (SRV-18)',
  :'mat_handover' = 'ok' AND :'mat_close' = 'ok'
  AND (SELECT status FROM public.shifts WHERE id = :'s_mat') = 'closed';


-- ---------------------------------------------------------------- SRV-19: retries and client JSON
-- The admin's retry of the approval already stored (lost response) returns the item; a different decision is still refused.
SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.err(format('SELECT public.decide_pedido_item(%s, %L)', :item_activo, 'aprobado')) AS retry_same \gset
SELECT pg_temp.err(format('SELECT public.decide_pedido_item(%s, %L, NULL, %L)', :item_activo, 'rechazado', 'cambio tardio')) AS retry_other \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a retry of the stored approval returns the item instead of failing (SRV-19)', :'retry_same' = 'ok';
INSERT INTO results SELECT 'a different decision on an item already decided is still refused (SRV-19)', :'retry_other' LIKE '22023 %';

-- Client JSON with a bad quantity or variant id gets a Spanish 22023, not a raw cast error.
SELECT pg_temp.act_as(:'a');
SELECT pg_temp.err(format($q$SELECT public.create_pedido_v2(%s, 'empresa', %L::jsonb, 'low-ped-cant-mala', 'Obra de prueba', 'Normal', NULL, NULL)$q$,
  :active_well, '[{"material_name":"Grava","requested_quantity":"abc","unit":"m3"}]')) AS cant_mala \gset
SELECT pg_temp.err(format($q$SELECT public.create_pedido_v2(%s, 'empresa', %L::jsonb, 'low-ped-var-mala', 'Obra de prueba', 'Normal', NULL, NULL)$q$,
  :active_well, '[{"material_name":"Grava","requested_quantity":1,"unit":"m3","catalog_variant_id":"xyz"}]')) AS var_mala \gset
SELECT pg_temp.err(format($q$SELECT public.create_pedido_v2(%s, 'empresa', %L::jsonb, 'low-ped-nan', 'Obra de prueba', 'Normal', NULL, NULL)$q$,
  :active_well, '[{"material_name":"Grava","requested_quantity":"NaN","unit":"m3"}]')) AS cant_nan \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'a non-numeric requested quantity in create_pedido_v2 gives a Spanish 22023 (SRV-19)',
  :'cant_mala' LIKE '22023 La cantidad solicitada%';
INSERT INTO results SELECT 'a non-numeric catalog variant id in create_pedido_v2 gives a Spanish 22023 (SRV-19)',
  :'var_mala' LIKE '22023 El identificador de la variante%';
INSERT INTO results SELECT 'a NaN requested quantity is refused, not stored (SRV-19)', :'cant_nan' LIKE '22023 %';

\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed, '
  || count(*) FILTER (WHERE passed IS NOT TRUE) || ' FAILED' FROM results;
ROLLBACK;
