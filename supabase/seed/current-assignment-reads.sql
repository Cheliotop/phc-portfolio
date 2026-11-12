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

INSERT INTO public.project_materials(project_id,material_name,current_quantity,initial_quantity,unit,active) VALUES (:well,'Scope pipe',10,10,'u',true) RETURNING id AS mat \gset
INSERT INTO public.notifications(user_id,type,title,message,related_project) VALUES (:'a','scope','Local fixture','Project detail',:well);
INSERT INTO storage.objects(bucket_id,name) VALUES ('phc-photos', :well || '/scope.jpg');
SELECT pg_temp.act_as(:'a');
SELECT (public.start_shift(:well, 'bbbbbbbb-0000-4000-8000-0000000000f1', 'scope-shift')).id AS shift_id \gset
SELECT public.confirm_shift_handover(:'shift_id', jsonb_build_array(jsonb_build_object('project_material_id',:mat)));
SELECT public.record_material_consumption(p_project_id=>:well,p_quantity_used=>2,p_client_entry_id=>'scope-consume',p_project_material_id=>:mat,p_shift_id=>:'shift_id');
SELECT public.record_material_consumption(p_project_id=>:well,p_quantity_used=>2,p_client_entry_id=>'scope-consume',p_project_material_id=>:mat,p_shift_id=>:'shift_id');
INSERT INTO results SELECT 'consumption replay preserves assigned minus consumed',initial_quantity=10 AND current_quantity=8 FROM public.project_materials WHERE id=:mat;
INSERT INTO results SELECT 'consumption accepted once',count(*)=1 FROM public.material_consumption WHERE client_entry_id='scope-consume';
SELECT public.record_material_consumption(p_project_id=>:well,p_quantity_used=>99,p_client_entry_id=>'scope-excess',p_project_material_id=>:mat,p_shift_id=>:'shift_id');
INSERT INTO results SELECT 'overconsumption is flagged without hiding actual usage',anomaly_flag FROM public.material_consumption WHERE client_entry_id='scope-excess';
INSERT INTO results SELECT 'overconsumption retains arithmetic invariant',initial_quantity-101=current_quantity FROM public.project_materials WHERE id=:mat;
SELECT public.create_drilling_bar(p_project_id => :well, p_soil_type => 'Arena', p_client_entry_id => 'scope-bar', p_shift_id => :'shift_id', p_timestamp_local => now()::text);
INSERT INTO results SELECT 'principal sees bar', count(*) = 1 FROM public.drilling_bars WHERE project_id=:well;
SELECT pg_temp.act_as(:'b');
INSERT INTO results SELECT 'secondary reads project photo object', count(*)=1 FROM storage.objects WHERE name=:well || '/scope.jpg';
INSERT INTO results SELECT 'secondary sees bar', count(*) = 1 FROM public.drilling_bars WHERE project_id=:well;
SELECT pg_temp.act_as(:'c');
INSERT INTO results SELECT 'unrelated sees no bars', count(*) = 0 FROM public.drilling_bars WHERE project_id=:well;
SELECT pg_temp.act_as_owner();
UPDATE public.projects SET assigned_operator_id=:'c' WHERE id=:well;
DELETE FROM public.project_secondary_operators WHERE project_id=:well;
SELECT pg_temp.act_as(:'a');
INSERT INTO results SELECT 'revoked cannot select photo object', count(*)=0 FROM storage.objects WHERE name=:well || '/scope.jpg';
INSERT INTO results SELECT 'revoked cannot update allocations', pg_temp.try(format('UPDATE public.project_materials SET current_quantity=999 WHERE project_id=%s',:well)) <> 'ok' ;
INSERT INTO results SELECT 'revoked cannot read project-linked notification',count(*)=0 FROM public.notifications WHERE related_project=:well;
INSERT INTO results SELECT 'revoked author sees no bars', count(*) = 0 FROM public.drilling_bars WHERE project_id=:well;
INSERT INTO results SELECT 'revoked owner sees no shifts', count(*) = 0 FROM public.shifts WHERE project_id=:well;
INSERT INTO results SELECT 'revoked participant sees no participation', count(*) = 0 FROM public.shift_participants WHERE shift_id=:'shift_id';
INSERT INTO results SELECT 'revoked cannot write bar', pg_temp.try(format($q$SELECT public.create_drilling_bar(p_project_id=>%s,p_soil_type=>'Arena',p_client_entry_id=>'scope-denied',p_shift_id=>%L,p_timestamp_local=>now()::text)$q$,:well,:'shift_id')) <> 'ok';
INSERT INTO results SELECT 'revoked cannot end shift through RPC', pg_temp.try(format('SELECT public.end_shift(%L, %L::jsonb)', :'shift_id','[]'))='42501';
INSERT INTO results SELECT 'revoked metrics reveal no shift or bars',
 (public.get_operator_accountability_metrics()->'current_shift')='null'::jsonb
 AND COALESCE((public.get_operator_accountability_metrics()->>'bars_recorded')::int,0)=0;
SELECT pg_temp.act_as_owner();
INSERT INTO public.project_closing_assignments(project_id,operator_id,assigned_by) VALUES (:well,:'a',:'admin') ON CONFLICT DO NOTHING;
SELECT pg_temp.act_as(:'a');
INSERT INTO results SELECT 'closing-only assignment cannot retrieve Ficha history', pg_temp.try(format('SELECT public.get_closing_ficha_preview(%s)',:well))='42501';
INSERT INTO results SELECT 'closing-only cannot browse materials', count(*)=0 FROM public.project_materials WHERE project_id=:well;
SELECT pg_temp.act_as(:'b');
INSERT INTO results SELECT 'revoked secondary sees no bars', count(*) = 0 FROM public.drilling_bars WHERE project_id=:well;
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active=false WHERE id=:'c';
SELECT pg_temp.act_as(:'c');
INSERT INTO results SELECT 'deactivated principal sees no project', count(*) = 0 FROM public.projects WHERE id=:well;
SELECT pg_temp.act_as_owner();
UPDATE public.profiles SET is_active=true WHERE id=:'c';
-- Retained principal assignment does not expose completed history.
UPDATE public.projects SET status='completed' WHERE id=:well;
SELECT pg_temp.act_as(:'c');
INSERT INTO results SELECT 'completed project hidden', count(*) = 0 FROM public.projects WHERE id=:well;
INSERT INTO results SELECT 'completed bars hidden', count(*) = 0 FROM public.drilling_bars WHERE project_id=:well;
SELECT pg_temp.act_as(:'admin');
INSERT INTO results SELECT 'admin retains completed history', count(*) = 1 FROM public.drilling_bars WHERE project_id=:well;
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'all field read boundaries are restrictive', count(*)=19 FROM pg_policies WHERE policyname='current_assignment_read_boundary' AND permissive='RESTRICTIVE' AND schemaname='public';
INSERT INTO results SELECT 'anonymous cannot call new helper', NOT has_function_privilege('anon','public.can_read_current_project(bigint)','EXECUTE');
\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS ' ELSE 'FAIL ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed' FROM results;
SELECT bool_and(passed IS TRUE) AS success FROM results \gset
\if :success
ROLLBACK;
\else
DO $$ BEGIN RAISE EXCEPTION 'assignment regression failed'; END $$;
\endif
