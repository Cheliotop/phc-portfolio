-- ===========================================================================
-- ROLLBACK for the four migrations pushed to production on 2026-07-26
--   20260725120000_phc_photos_storage_bucket
--   20260725140000_phc_recompute_project_progress
--   20260725160000_phc_secondary_operators
--   20260726000000_phc_server_side_shift_reaper
--
-- Why this file exists instead of a pg_dump: the organisation is on the FREE
-- plan (no PITR, no automated backups) and the Supabase CLI could not
-- authenticate to the production database to take one (401, no
-- SUPABASE_DB_PASSWORD). So this is a surgical rollback generated from
-- production's own live state immediately before the push.
--
-- Scope check performed first: of the four migrations, only 20260725140000
-- mutates DATA (it backfills projects.progress_percentage for every project).
-- Everything else is DDL. No other row in the database is touched.
--
-- Run as the postgres role. Sections are independent; run only what you need.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Restore projects.progress_percentage
--
-- Captured from production 2026-07-26. These are the ONLY values in this file
-- that cannot be reconstructed from the repo, which is why they are first.
-- ---------------------------------------------------------------------------
UPDATE public.projects SET progress_percentage = 30 WHERE id = 25;
UPDATE public.projects SET progress_percentage = 0  WHERE id = 26;
UPDATE public.projects SET progress_percentage = 0  WHERE id = 27;
UPDATE public.projects SET progress_percentage = 0  WHERE id = 28;
UPDATE public.projects SET progress_percentage = 0  WHERE id = 29;
UPDATE public.projects SET progress_percentage = 0  WHERE id = 30;


-- ---------------------------------------------------------------------------
-- 2. Drop everything the four migrations created
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('phc-reap-expired-shifts')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'phc-reap-expired-shifts');

DROP FUNCTION IF EXISTS private.reap_expired_shifts(uuid);

DROP TRIGGER  IF EXISTS refresh_project_progress_on_drilling_bars ON public.drilling_bars;
DROP FUNCTION IF EXISTS private.drilling_bars_refresh_progress();
DROP FUNCTION IF EXISTS private.recompute_project_progress(bigint);

DROP POLICY IF EXISTS "Admins manage secondary operators"     ON public.project_secondary_operators;
DROP POLICY IF EXISTS "Team members read secondary assignments" ON public.project_secondary_operators;
DROP TABLE  IF EXISTS public.project_secondary_operators;

-- is_project_team_member / is_project_secondary_operator are NOT dropped here.
-- Sections 3 and 4 still reference them until the un-swap has run, so they are
-- dropped in section 5 instead. Run sections in order.


-- ---------------------------------------------------------------------------
-- 3. Reverse the mechanical widening
--
-- 20260725160000 widened six policies and eight functions by a pure string
-- replacement, is_project_operator( -> is_project_team_member(. The exact
-- inverse is the same block with the arguments swapped, which is why this file
-- does not need to carry 40 KB of captured definitions.
--
-- Re-run safe: on a second run the strings are already narrow and the replace
-- is a no-op.
-- ---------------------------------------------------------------------------

-- 3a. policies
DO $unswap_policies$
DECLARE
  r       record;
  v_qual  text;
  v_check text;
  v_sql   text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, qual, with_check, roles
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (tablename, policyname) IN (
         ('drilling_bars',        'Project operators view project bars'),
         ('material_consumption', 'Project operators view project consumption'),
         ('photos',               'Active operators view own project photos'),
         ('photos',               'Active project operators upload photo metadata'),
         ('project_materials',    'Active operators view assigned project materials'),
         ('water_samples',        'Operators read project water samples')
       )
  LOOP
    v_qual  := replace(COALESCE(r.qual, ''),       'is_project_team_member(', 'is_project_operator(');
    v_check := replace(COALESCE(r.with_check, ''), 'is_project_team_member(', 'is_project_operator(');

    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);

    v_sql := format('CREATE POLICY %I ON public.%I FOR %s TO %s',
                    r.policyname, r.tablename, r.cmd,
                    array_to_string(r.roles, ', '));
    -- An INSERT policy takes WITH CHECK only; Postgres rejects USING on it,
    -- which is why each clause is emitted conditionally.
    IF v_qual  <> '' THEN v_sql := v_sql || format(' USING (%s)', v_qual);      END IF;
    IF v_check <> '' THEN v_sql := v_sql || format(' WITH CHECK (%s)', v_check); END IF;
    EXECUTE v_sql;
  END LOOP;
END;
$unswap_policies$;

-- 3b. the projects SELECT policy, which 20260725160000 replaced outright
DROP POLICY IF EXISTS "Active operators view assigned projects" ON public.projects;
CREATE POLICY "Active operators view assigned projects"
  ON public.projects FOR SELECT
  TO authenticated
  USING (
    public.is_active_user()
    AND assigned_operator_id = (SELECT auth.uid())
  );

-- 3c. seven of the eight functions
--
-- start_shift_20260712_impl is deliberately EXCLUDED here: 20260726000000
-- replaced its body wholesale (inline auto-close -> reap_expired_shifts call),
-- so a string un-swap cannot restore it. Section 4 restores it explicitly.
DO $unswap_functions$
DECLARE
  r     record;
  v_def text;
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prokind = 'f'
       AND (n.nspname, p.proname) IN (
         ('public',  'start_shift'),
         ('public',  'create_drilling_bar'),
         ('private', 'create_drilling_bar_20260712_impl'),
         ('public',  'record_material_consumption'),
         ('private', 'record_material_consumption_20260712_impl'),
         ('public',  'register_water_sample'),
         ('private', 'register_water_sample_20260712_impl')
       )
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(v_def, 'public.is_project_team_member(', 'public.is_project_operator(');
    EXECUTE v_def;
  END LOOP;
END;
$unswap_functions$;


-- ---------------------------------------------------------------------------
-- 4. Restore private.start_shift_20260712_impl
--
-- Captured verbatim from production on 2026-07-26, before the push. Note the
-- INLINE 12-hour auto-close in the `IF FOUND THEN` branch — that is the state
-- W-3 replaced with a call to private.reap_expired_shifts(), and restoring it
-- is what makes section 2's DROP of that function safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.start_shift_20260712_impl(
  p_project_id bigint,
  p_shift_id uuid,
  p_client_entry_id text,
  p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_device_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing public.shifts;
  v_result public.shifts;
  v_started timestamptz := COALESCE(p_started_at, now());
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_field_work(p_project_id) THEN
    RAISE EXCEPTION 'Project is not open for a new shift' USING ERRCODE = '55000';
  END IF;
  IF p_shift_id IS NULL OR length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'shift_id and client_entry_id are required' USING ERRCODE = '22023';
  END IF;
  IF v_started > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Shift start cannot be more than 15 minutes in the future'
      USING ERRCODE = '22023';
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id,
    'started_at', v_started,
    'device_started_at', p_device_started_at
  ));

  -- Authorize first, then honor an idempotent replay only for the same actor
  -- and project. A globally guessed key can never return another user's row.
  SELECT * INTO v_existing
  FROM public.shifts
  WHERE id = p_shift_id OR client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key belongs to another shift' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_existing
  FROM public.shifts
  WHERE operator_id = auth.uid() AND status IN ('open', 'report_pending')
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'open' AND v_existing.started_at <= now() - interval '12 hours' THEN
      UPDATE public.shifts
      SET status = 'report_pending',
          ended_at = v_existing.started_at + interval '12 hours',
          end_type = 'auto',
          device_time_flag = true,
          updated_at = now()
      WHERE id = v_existing.id
      RETURNING * INTO v_existing;
    END IF;
    -- Returning the unresolved shift (instead of raising) commits the
    -- auto-close. The client must inspect status and finish its usage report.
    RETURN v_existing;
  END IF;

  INSERT INTO public.shifts (
    id, client_entry_id, project_id, operator_id, status,
    started_at, ended_at, start_device_time, end_type,
    device_time_flag, request_payload
  ) VALUES (
    p_shift_id, p_client_entry_id, p_project_id, auth.uid(),
    CASE WHEN v_started <= now() - interval '12 hours' THEN 'report_pending' ELSE 'open' END,
    v_started,
    CASE WHEN v_started <= now() - interval '12 hours' THEN v_started + interval '12 hours' END,
    p_device_started_at,
    CASE WHEN v_started <= now() - interval '12 hours' THEN 'auto' END,
    abs(extract(epoch FROM (now() - v_started))) > 900
      OR (p_device_started_at IS NOT NULL AND abs(extract(epoch FROM (v_started - p_device_started_at))) > 900),
    v_payload
  ) RETURNING * INTO v_result;

  RETURN v_result;
END;
$function$;


-- ---------------------------------------------------------------------------
-- 5. Now that nothing references them, drop the membership helpers
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_project_team_member(bigint);
DROP FUNCTION IF EXISTS public.is_project_secondary_operator(bigint);


-- ---------------------------------------------------------------------------
-- 6. Un-record the migrations so the history matches reality again
-- ---------------------------------------------------------------------------
DELETE FROM supabase_migrations.schema_migrations
 WHERE version IN ('20260725120000','20260725140000','20260725160000','20260726000000');


-- ---------------------------------------------------------------------------
-- Not rolled back on purpose
--
-- 20260725120000 (phc-photos bucket) is an INSERT ... ON CONFLICT DO NOTHING
-- and the bucket already existed on production before the push, so it changed
-- nothing. Dropping the bucket here would destroy real photo objects.
-- ---------------------------------------------------------------------------
