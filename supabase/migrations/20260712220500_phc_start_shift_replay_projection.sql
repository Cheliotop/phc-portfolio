-- A shift's request_payload is intentionally extended by handover and end
-- testimony after it starts. Exact start retries compare only the immutable
-- start projection so later lifecycle evidence cannot break idempotency.

CREATE OR REPLACE FUNCTION public.start_shift(
  p_project_id bigint,
  p_shift_id uuid,
  p_client_entry_id text,
  p_started_at timestamptz DEFAULT NULL,
  p_device_started_at timestamptz DEFAULT NULL
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.shifts;
  v_started timestamptz;
  v_payload jsonb;
  v_existing_start_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF p_shift_id IS NULL OR length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'shift_id and client_entry_id are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('start_shift:' || p_client_entry_id, 0)
  );

  SELECT * INTO v_existing FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_existing
    FROM public.shifts WHERE client_entry_id = p_client_entry_id FOR UPDATE;
  END IF;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM p_shift_id
       OR v_existing.client_entry_id IS DISTINCT FROM p_client_entry_id
       OR v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id THEN
      RAISE EXCEPTION 'Idempotency key belongs to another shift'
        USING ERRCODE = '23505';
    END IF;
    v_started := COALESCE(
      p_started_at,
      NULLIF(v_existing.request_payload ->> 'started_at', '')::timestamptz,
      v_existing.started_at
    );
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'project_id', p_project_id,
      'started_at', v_started,
      'device_started_at', p_device_started_at
    ));
    v_existing_start_payload := jsonb_strip_nulls(jsonb_build_object(
      'project_id', v_existing.request_payload -> 'project_id',
      'started_at', v_existing.request_payload -> 'started_at',
      'device_started_at', v_existing.request_payload -> 'device_started_at'
    ));
    IF v_existing_start_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  RETURN private.start_shift_20260712_impl(
    p_project_id, p_shift_id, p_client_entry_id,
    p_started_at, p_device_started_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_shift(bigint, uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_shift(bigint, uuid, text, timestamptz, timestamptz)
  TO authenticated, service_role;
