-- A queued close survives the admin changing the well's materials meanwhile
-- (code read D5, 2026-11-08). end_shift requires the usage list to name exactly
-- every active material of the well. A close queued on the phone before the admin
-- added or removed a material was refused for good, and since a shift its operator
-- can't close now blocks the well (20261106120000), the next operator waited for a
-- force-close.
--
-- Two cases change, both ones the phone cannot avoid:
--   * A material added after the shift started may be missing from the list. The
--     phone may never have seen it, so it counts as zero use.
--   * A material removed during the shift may still be in the list. Its use is
--     recorded and flagged as an anomaly for the admin.
-- Leaving out a material that existed when the shift started, or naming another
-- well's material, is still refused. Everything else is the definition from
-- 20261108120000.

CREATE OR REPLACE FUNCTION public.end_shift(p_shift_id uuid, p_usage jsonb, p_notes text DEFAULT NULL::text, p_device_ended_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_type text DEFAULT 'manual'::text)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_shift public.shifts;
  v_item jsonb;
  v_usage jsonb := COALESCE(p_usage, '[]'::jsonb);
  v_assignment public.project_materials;
  v_existing public.material_consumption;
  v_quantity real;
  v_client_entry_id text;
  v_anomaly boolean;
  v_end_payload jsonb;
  v_line_payload jsonb;
  v_authoritative_end timestamptz;
  v_device_end_server_time timestamptz;
  v_effective_end_type text;
  v_effective_date date;
  v_note text;
  v_approximate boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_end_type NOT IN ('manual', 'auto') THEN
    RAISE EXCEPTION 'Invalid shift end type' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_usage) <> 'array' THEN
    RAISE EXCEPTION 'usage must be an array' USING ERRCODE = '22023';
  END IF;
  v_end_payload := jsonb_strip_nulls(jsonb_build_object(
    'usage', v_usage,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'device_ended_at', p_device_ended_at,
    'requested_end_type', p_end_type
  ));

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002'; END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Access denied to this shift' USING ERRCODE = '42501';
  END IF;
  IF v_shift.status = 'closed' AND v_shift.usage_report_submitted THEN
    IF v_shift.request_payload -> 'end' IS DISTINCT FROM v_end_payload THEN
      RAISE EXCEPTION 'Idempotency replay does not match the submitted shift report'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_shift;
  END IF;
  IF v_shift.status NOT IN ('open', 'report_pending') THEN
    RAISE EXCEPTION 'Shift cannot be closed from status %', v_shift.status
      USING ERRCODE = '22023';
  END IF;
  IF v_shift.handover_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm the shift handover before closing the shift'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_usage) item
    WHERE public.safe_bigint(item ->> 'project_material_id') IS NULL
       OR public.safe_bigint(item ->> 'project_material_id') <= 0
  ) THEN
    RAISE EXCEPTION 'Each usage line needs a valid project_material_id'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_usage) item
    GROUP BY public.safe_bigint(item ->> 'project_material_id')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cada material debe aparecer una sola vez en el informe de turno'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id AND pm.active IS TRUE
      -- Added during the shift: the phone may not know it, so it counts as zero.
      AND pm.created_at <= v_shift.started_at
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_usage) item
        WHERE public.safe_bigint(item ->> 'project_material_id') = pm.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_usage) item
    LEFT JOIN public.project_materials pm
      ON pm.id = public.safe_bigint(item ->> 'project_material_id')
     AND pm.project_id = v_shift.project_id
     -- Removed during the shift: still this well's, so its use is recorded.
     AND (pm.active IS TRUE OR pm.updated_at >= v_shift.started_at)
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'El informe debe incluir exactamente cada material activo del proyecto'
      USING ERRCODE = '22023';
  END IF;

  -- A shift starts on the server's clock, so its end must be on that clock too, or a
  -- wrong phone clock changes the hours the admin pays. Bars convert the same way.
  v_device_end_server_time := p_device_ended_at
    - COALESCE(v_shift.start_device_time - v_shift.started_at, interval '0');
  v_authoritative_end := now();
  IF v_device_end_server_time IS NOT NULL
     AND v_device_end_server_time >= v_shift.started_at
     AND v_device_end_server_time <= now() + interval '15 minutes' THEN
    v_authoritative_end := least(v_device_end_server_time, now());
  END IF;
  -- A shift the 12-hour sweep marked report_pending keeps its 12-hour end, unless
  -- the operator's own close says it ended earlier: closed offline at hour 8 and
  -- synced at hour 13, it ended at hour 8, not 12, and it isn't a missing report.
  IF v_authoritative_end >= v_shift.started_at + interval '12 hours'
     OR (v_shift.status = 'report_pending'
         AND (p_end_type IS DISTINCT FROM 'manual' OR v_device_end_server_time IS NULL
              OR v_device_end_server_time < v_shift.started_at
              OR v_device_end_server_time > now() + interval '15 minutes')) THEN
    v_authoritative_end := v_shift.started_at + interval '12 hours';
    v_effective_end_type := 'auto';
  ELSE
    v_effective_end_type := p_end_type;
  END IF;
  PERFORM set_config('phc.audit_reason', COALESCE(p_notes, 'Cierre de turno'), true);

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_usage) LOOP
    BEGIN
      v_quantity := COALESCE((v_item ->> 'quantity_used')::real, 0);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Usage quantity is invalid' USING ERRCODE = '22023';
    END;
    IF private.is_finite_real(v_quantity) IS NOT TRUE OR v_quantity < 0 OR v_quantity > 1000000 THEN
      RAISE EXCEPTION 'Cada consumo debe estar entre 0 y 1.000.000' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = public.safe_bigint(v_item ->> 'project_material_id')
      AND project_id = v_shift.project_id
      AND (active IS TRUE OR updated_at >= v_shift.started_at)
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assigned material not found in shift project'
        USING ERRCODE = 'P0002';
    END IF;
    IF v_quantity > 0 THEN
      v_client_entry_id := 'shift-usage:' || p_shift_id::text || ':' || v_assignment.id::text;
      v_effective_date := COALESCE((v_item ->> 'date')::date, CURRENT_DATE);
      v_note := NULLIF(v_item ->> 'notes', '');
      v_approximate := COALESCE((v_item ->> 'approximate')::boolean, false);
      -- Use of a material removed during the shift is kept, and flagged for the admin.
      v_anomaly := v_quantity > COALESCE(v_assignment.current_quantity, 0)
        OR v_assignment.active IS NOT TRUE;
      v_line_payload := jsonb_strip_nulls(jsonb_build_object(
        'project_id', v_shift.project_id,
        'quantity_used', v_quantity,
        'project_material_id', v_assignment.id,
        'material_id', v_assignment.material_id,
        'material_name', v_assignment.material_name,
        'unit', v_assignment.unit,
        'date', v_effective_date,
        'notes', v_note,
        'shift_id', v_shift.id,
        'approximate', v_approximate
      ));

      SELECT * INTO v_existing
      FROM public.material_consumption
      WHERE client_entry_id = v_client_entry_id
      FOR UPDATE;
      IF FOUND THEN
        IF v_existing.operator_id IS DISTINCT FROM v_shift.operator_id
           OR v_existing.project_id IS DISTINCT FROM v_shift.project_id
           OR v_existing.shift_id IS DISTINCT FROM v_shift.id
           OR v_existing.project_material_id IS DISTINCT FROM v_assignment.id
           OR v_existing.quantity_used IS DISTINCT FROM v_quantity
           OR v_existing.date IS DISTINCT FROM v_effective_date
           OR v_existing.notes IS DISTINCT FROM v_note
           OR v_existing.approximate IS DISTINCT FROM v_approximate THEN
          RAISE EXCEPTION 'Shift usage idempotency key payload mismatch'
            USING ERRCODE = '23505';
        END IF;
      ELSE
        INSERT INTO public.material_consumption (
          client_entry_id, project_id, operator_id, shift_id,
          project_material_id, material_id, material_name, quantity_used,
          unit, date, notes, approximate, anomaly_flag, request_payload
        ) VALUES (
          v_client_entry_id, v_shift.project_id, v_shift.operator_id, v_shift.id,
          v_assignment.id, v_assignment.material_id, v_assignment.material_name,
          v_quantity, v_assignment.unit, v_effective_date, v_note,
          v_approximate, v_anomaly, v_line_payload
        );
        UPDATE public.project_materials
        SET current_quantity = COALESCE(current_quantity, 0) - v_quantity,
            updated_at = now()
        WHERE id = v_assignment.id;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.shifts
  SET status = 'closed', ended_at = v_authoritative_end,
      end_device_time = COALESCE(p_device_ended_at, end_device_time),
      end_type = v_effective_end_type, usage_report_submitted = true,
      notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
      device_time_flag = device_time_flag OR (
        v_device_end_server_time IS NOT NULL AND (
          v_device_end_server_time < started_at
          OR v_device_end_server_time > now() + interval '15 minutes'
        )
      ) OR v_effective_end_type = 'auto',
      request_payload = COALESCE(request_payload, '{}'::jsonb)
        || jsonb_build_object('end', v_end_payload),
      updated_at = now()
  WHERE id = p_shift_id
  RETURNING * INTO v_shift;

  PERFORM private.write_audit(
    v_shift.project_id, 'shift.closed', 'shifts', v_shift.id::text,
    NULL, to_jsonb(v_shift), p_notes,
    jsonb_build_object('usage_lines', jsonb_array_length(v_usage))
  );
  RETURN v_shift;
END;
$function$;
