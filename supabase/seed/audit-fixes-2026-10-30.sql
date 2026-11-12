-- Regression checks for 20261030230000_phc_full_audit_fixes.sql.
-- LOCAL stack only, after seed-local.js. Everything runs inside one
-- transaction that is rolled back, so it leaves no rows behind.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -f supabase/seed/audit-fixes-2026-10-30.sql
--
-- Prints one PASS/FAIL line per check.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN;

CREATE TEMP TABLE results (check_name text, passed boolean) ON COMMIT DROP;
GRANT ALL ON results TO authenticated;

-- Fixture: one active project, its primary operator, a subcontractor.
SELECT p.id AS project_id, p.assigned_operator_id AS primary_id
FROM public.projects p
WHERE public.project_status_key(p.status) = 'active' AND p.assigned_operator_id IS NOT NULL
ORDER BY p.id LIMIT 1 \gset
SELECT id AS secondary_id FROM public.profiles
WHERE role = 'operator' AND is_active AND id <> :'primary_id'
ORDER BY username LIMIT 1 \gset
SELECT id AS admin_id FROM public.profiles WHERE role = 'admin' AND is_active LIMIT 1 \gset
SELECT set_config('phc.project_id', :'project_id', true),
       set_config('phc.secondary_id', :'secondary_id', true) \g /dev/null
INSERT INTO public.project_secondary_operators (project_id, operator_id)
VALUES (:project_id, :'secondary_id') ON CONFLICT DO NOTHING;
-- Clear the well as well as the operator: a well's shifts cannot overlap (20261106120000).
UPDATE public.shifts SET status = 'closed', ended_at = LEAST(started_at + interval '1 hour', now()),
       usage_report_submitted = true
WHERE (operator_id = :'secondary_id' OR project_id = :project_id)
  AND status IN ('open', 'report_pending');
-- F10 overlaps one operator across wells, the only overlap still allowed.
INSERT INTO public.projects (name, status, assigned_operator_id)
SELECT 'F10 pozo ' || i, 'active', :'secondary_id' FROM generate_series(1, 3) AS i;

-- F2
INSERT INTO results VALUES ('F2 authenticated has no TRUNCATE on public tables',
  NOT has_table_privilege('authenticated', 'public.projects', 'TRUNCATE'));

SET LOCAL role authenticated;

-- F6: subcontractor uploads and reads a project photo.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'secondary_id', 'role', 'authenticated')::text, true) \g /dev/null
DO $$
DECLARE v_ok boolean := true;
BEGIN
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
    VALUES ('phc-photos', current_setting('phc.project_id') || '/audit-probe.jpg',
            current_setting('phc.secondary_id'), '{"mimetype":"image/jpeg"}');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := false;
  END;
  INSERT INTO results VALUES ('F6 subcontractor can upload a project photo', v_ok);
  INSERT INTO results VALUES ('F6 subcontractor can read the project photo',
    EXISTS (SELECT 1 FROM storage.objects
            WHERE name = current_setting('phc.project_id') || '/audit-probe.jpg'));
END $$;

-- F3: an operator may change their phone but not their name.
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  UPDATE public.profiles SET phone = '+595 000' WHERE id = auth.uid();
  BEGIN
    UPDATE public.profiles SET full_name = 'Otra Persona' WHERE id = auth.uid();
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  INSERT INTO results VALUES ('F3 operator can update own phone',
    (SELECT phone = '+595 000' FROM public.profiles WHERE id = auth.uid()));
  INSERT INTO results VALUES ('F3 operator cannot rename themselves', v_blocked);
END $$;

-- F10: three shifts backdated to the same start count 11 hours, not 33.
DO $$
DECLARE v_well bigint; s uuid; t timestamptz := now() - interval '11 hours'; v jsonb; v_before numeric;
BEGIN
  -- The seeded operator already has shifts, so measure what these three add. It
  -- can be under 11 when they also overlap a seeded shift, but never 33.
  v_before := (public.get_operator_accountability_metrics() ->> 'hours_worked')::numeric;
  FOR v_well IN SELECT id FROM public.projects WHERE name LIKE 'F10 pozo %' ORDER BY id LOOP
    s := gen_random_uuid();
    PERFORM public.start_shift(v_well, s, 'audit-overlap-' || v_well, t, t);
    -- D3: the server starts the shift now; backdate it here (owner role) to keep the overlap.
    PERFORM set_config('role', 'postgres', true);
    UPDATE public.shifts SET started_at = t WHERE id = s;
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.confirm_shift_handover(s, '[]'::jsonb);
    PERFORM public.end_shift(s, '[]'::jsonb, 'audit', now(), 'manual');
  END LOOP;
  v := public.get_operator_accountability_metrics();
  INSERT INTO results VALUES ('F10 overlapping shifts count once in hours_worked',
    (v ->> 'hours_worked')::numeric - v_before BETWEEN 0.1 AND 11.1);
  INSERT INTO results VALUES ('F10 overlapping starts are flagged',
    (v ->> 'flagged_shifts')::int >= 3);
END $$;

-- F12: absurd bar length and consumption are refused.
DO $$
DECLARE s uuid := gen_random_uuid(); v_bar boolean := false; v_qty boolean := false;
BEGIN
  PERFORM public.start_shift(current_setting('phc.project_id')::bigint, s, 'audit-bounds', now(), now());
  PERFORM public.confirm_shift_handover(s, (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('project_material_id', pm.id)), '[]'::jsonb)
    FROM public.project_materials pm
    WHERE pm.project_id = current_setting('phc.project_id')::bigint AND pm.active));
  BEGIN
    PERFORM public.create_drilling_bar(current_setting('phc.project_id')::bigint, 'arcilla',
      'audit-bar-huge', 3e30::real, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now()::text, s);
  EXCEPTION WHEN invalid_parameter_value THEN v_bar := true;
  END;
  BEGIN
    PERFORM public.record_material_consumption(current_setting('phc.project_id')::bigint,
      2e6::real, 'audit-qty-huge', (
        SELECT pm.id FROM public.project_materials pm
        WHERE pm.project_id = current_setting('phc.project_id')::bigint AND pm.active LIMIT 1),
      NULL, NULL, NULL, NULL, NULL, s);
  EXCEPTION WHEN invalid_parameter_value THEN v_qty := true;
  END;
  INSERT INTO results VALUES ('F12 bar longer than 50 m is refused', v_bar);
  INSERT INTO results VALUES ('F12 consumption above 1,000,000 is refused', v_qty);
END $$;

-- F4: even an admin cannot promote through the API.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'admin_id', 'role', 'authenticated')::text, true) \g /dev/null
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'admin' WHERE id = current_setting('phc.secondary_id')::uuid;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  INSERT INTO results VALUES ('F4 admin cannot change a role through the API', v_blocked);
END $$;

RESET role;
SELECT CASE WHEN passed THEN 'PASS  ' ELSE 'FAIL  ' END || check_name FROM results;
SELECT count(*) FILTER (WHERE passed) || '/' || count(*) || ' passed, '
       || count(*) FILTER (WHERE NOT passed) || ' FAILED' FROM results;
ROLLBACK;
