-- Regression checks for 20261109120000_phc_reconciliation_tolerance.sql.
-- LOCAL stack only. Creates its own users, well, and material assignments, and
-- runs inside one transaction that is rolled back, so it leaves no rows behind.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -f supabase/seed/reconciliation-tolerance.sql
--
-- Prints one PASS/FAIL line per check.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o /dev/null
BEGIN;

CREATE TEMP TABLE results (check_name text, passed boolean) ON COMMIT DROP;
GRANT ALL ON results TO authenticated;

\set admin 'cccccccc-0000-4000-8000-000000000021'
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
VALUES (
  '00000000-0000-0000-0000-000000000000', :'admin', 'authenticated', 'authenticated',
  'reconciliation_admin@phc.local', '', now(), '{"provider":"email"}'::jsonb,
  '{"username":"reconciliation_admin","full_name":"Admin Reconciliación"}'::jsonb,
  now(), now(), '', '', '', ''
);
UPDATE public.profiles SET role = 'admin' WHERE id = :'admin';

INSERT INTO public.projects (name, status, assigned_operator_id)
VALUES ('Pozo reconciliación tolerancia', 'active', NULL) RETURNING id AS well \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Manguera fraccionaria', 20, 20, 'm', true) RETURNING id AS fractional \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Manguera fraccionaria rechazada', 20, 20, 'm', true) RETURNING id AS too_much \gset
INSERT INTO public.project_materials (project_id, material_name, current_quantity, initial_quantity, unit, active)
VALUES (:well, 'Material entero', 10, 10, 'u', true) RETURNING id AS integer_case \gset

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
CREATE FUNCTION pg_temp.try_reconcile(p_well bigint, p_material bigint, p_returned real) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.save_material_reconciliation(p_well, p_material, p_returned, 'Prueba de tolerancia');
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

-- Model one consumption using the same float4 subtraction as the stock RPC.
UPDATE public.project_materials
SET current_quantity = current_quantity - 17.85::real
WHERE id IN (:fractional, :too_much);
UPDATE public.project_materials SET current_quantity = current_quantity - 3::real WHERE id = :integer_case;

SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try_reconcile(:well, :fractional, 2.15::real) AS exact_result \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT '20 less one 17.85 consumption accepts 2.15 with zero missing',
  :'exact_result' = 'ok'
  AND EXISTS (
    SELECT 1 FROM public.material_reconciliations
    WHERE project_material_id = :fractional
      AND returned_quantity = 2.15::real AND missing_quantity = 0::real
  );

SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try_reconcile(:well, :too_much, 2.16::real) AS too_much_result \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT '2.16 remains above the allowed returned quantity',
  :'too_much_result' = '22023'
  AND NOT EXISTS (SELECT 1 FROM public.material_reconciliations WHERE project_material_id = :too_much);

SELECT pg_temp.act_as(:'admin');
SELECT pg_temp.try_reconcile(:well, :integer_case, 7::real) AS integer_result \gset
SELECT pg_temp.act_as_owner();
INSERT INTO results SELECT 'the normal integer reconciliation still works',
  :'integer_result' = 'ok'
  AND EXISTS (
    SELECT 1 FROM public.material_reconciliations
    WHERE project_material_id = :integer_case
      AND sent_quantity = 10::real AND consumed_quantity = 3::real
      AND returned_quantity = 7::real AND missing_quantity = 0::real
  );

\o
SELECT CASE WHEN passed IS TRUE THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed IS TRUE) || '/' || count(*) || ' passed, '
  || count(*) FILTER (WHERE passed IS NOT TRUE) || ' FAILED' FROM results;
ROLLBACK;
