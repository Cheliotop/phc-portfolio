-- W-3: the 12-hour shift close must not depend on a client, or on the operator
-- happening to start another shift.
--
-- The rule already existed server-side, but only inside start_shift: an open
-- shift was auto-closed when its operator tried to begin the next one. Until
-- that moment the server kept reporting `open`, so the app told operator_05
-- "El turno superó 12 horas y se cerró automáticamente" while the server had
-- the same shift open at 116 hours with ended_at NULL. Every admin report,
-- duration figure and accountability metric read the server's answer.
--
-- getMine()/getAll() are direct PostgREST SELECTs on public.shifts, and a SELECT
-- cannot mutate, so there is no read path to hang the reap on. A schedule is the
-- only mechanism that converges without a client action.
--
-- Note that no sync message is needed between device and server: ended_at is
-- started_at + 12 hours, a pure function of a column both sides already agree
-- on, so both independently compute the SAME instant. The divergence was never
-- about transport — it was that one side never applied the rule.

-- ---------------------------------------------------------------------------
-- 1. One definition of the rule.
-- ---------------------------------------------------------------------------
-- Deliberately NOT a second copy of the 12-hour arithmetic. start_shift is
-- rewired below to call this, so the scheduled sweep and the start-time sweep
-- can never drift apart. Four copies of one write is exactly how A-6 happened.
--
-- Only 'open' -> 'report_pending'. A report_pending shift is one where the
-- operator still owes a usage report; advancing it to 'closed' here would
-- fabricate operational data nobody entered. It also stays "unresolved" for
-- shifts_one_unresolved_per_operator, so the operator is still correctly
-- blocked from starting another shift until they file that report.
CREATE OR REPLACE FUNCTION private.reap_expired_shifts(p_operator_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.shifts
     SET status = 'report_pending',
         ended_at = started_at + interval '12 hours',
         end_type = 'auto',
         -- The end instant is derived, never observed on a device. Flagging it
         -- keeps it distinguishable from an operator-reported time; this
         -- matches what start_shift already did.
         device_time_flag = true,
         updated_at = now()
   WHERE status = 'open'
     AND started_at <= now() - interval '12 hours'
     AND (p_operator_id IS NULL OR operator_id = p_operator_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION private.reap_expired_shifts(uuid) IS
  'W-3. Moves open shifts past 12h to report_pending. The single definition of '
  'the 12-hour rule server-side: called per-operator by start_shift and for '
  'everyone by the phc-reap-expired-shifts cron job. NULL operator = sweep all.';

-- Not reachable from PostgREST (only public and graphql_public are exposed),
-- but revoke explicitly rather than relying on that configuration staying put.
REVOKE ALL ON FUNCTION private.reap_expired_shifts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reap_expired_shifts(uuid) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rewire start_shift to the shared definition.
-- ---------------------------------------------------------------------------
-- Behaviour-identical to the inline block it replaces. Reproduced in full
-- because CREATE OR REPLACE cannot patch a single branch.
CREATE OR REPLACE FUNCTION private.start_shift_20260712_impl(
  p_project_id bigint,
  p_shift_id uuid,
  p_client_entry_id text,
  p_started_at timestamptz DEFAULT NULL,
  p_device_started_at timestamptz DEFAULT NULL
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_existing public.shifts;
  v_result public.shifts;
  v_started timestamptz := COALESCE(p_started_at, now());
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_team_member(p_project_id) AND NOT public.is_admin() THEN
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
    -- Was an inline UPDATE duplicating the 12-hour rule; now the one shared
    -- definition. Scoped to this operator, and shifts_one_unresolved_per_operator
    -- guarantees v_existing is their only unresolved row, so the reap can only
    -- touch the row already locked FOR UPDATE above. Re-read to pick up the
    -- change the function made.
    IF private.reap_expired_shifts(v_existing.operator_id) > 0 THEN
      SELECT * INTO v_existing FROM public.shifts WHERE id = v_existing.id;
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
$$;

-- ---------------------------------------------------------------------------
-- 3. Schedule the sweep.
-- ---------------------------------------------------------------------------
-- Wrapped so an environment without pg_cron in shared_preload_libraries still
-- gets the reaper and the start_shift dedup above; only the schedule is skipped,
-- loudly. Every 15 minutes bounds the lag at 12h15m. The scan is cheap:
-- shifts_one_unresolved_per_operator keeps the open set to at most one row per
-- operator no matter how large the table grows.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING
    'pg_cron unavailable (%): private.reap_expired_shifts() is installed but NOT scheduled. '
    'Expired shifts will still be closed when the operator starts their next shift. '
    'Enable pg_cron and re-run the schedule block to close them unattended.',
    SQLERRM;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Idempotent: re-running the migration must not stack duplicate jobs.
    PERFORM cron.unschedule('phc-reap-expired-shifts')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'phc-reap-expired-shifts');

    PERFORM cron.schedule(
      'phc-reap-expired-shifts',
      '*/15 * * * *',
      $job$SELECT private.reap_expired_shifts()$job$
    );
  END IF;
END;
$$;
