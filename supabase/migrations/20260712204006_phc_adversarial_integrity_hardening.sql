-- ============================================================================
-- PHC adversarial integrity hardening
--
-- Forward-only correction after 20260712130919. Keeps all caller identities
-- behind RLS/RPC authorization while making retries exact, numeric inputs
-- finite, Storage deletion physical, and notification leases service-only.
-- ============================================================================

CREATE OR REPLACE FUNCTION private.is_finite_real(p_value real)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = ''
AS $$
  SELECT p_value::text NOT IN ('NaN', 'Infinity', '-Infinity');
$$;

REVOKE ALL ON FUNCTION private.is_finite_real(real)
  FROM PUBLIC, anon, authenticated;

-- Persisted floating-point fields must never hold non-finite sentinels. The
-- production preflight found no existing violations; NOT VALID keeps the add
-- phase low-risk and VALIDATE makes that fact a database invariant.
DO $do$
DECLARE
  v_column record;
  v_constraint_name text;
BEGIN
  FOR v_column IN
    SELECT columns.table_schema, columns.table_name, columns.column_name
    FROM information_schema.columns AS columns
    JOIN pg_namespace AS namespaces
      ON namespaces.nspname = columns.table_schema
    JOIN pg_class AS relations
      ON relations.relnamespace = namespaces.oid
     AND relations.relname = columns.table_name
     AND relations.relkind IN ('r', 'p')
    WHERE columns.table_schema IN ('public', 'private')
      AND columns.udt_name IN ('float4', 'float8')
    ORDER BY columns.table_schema, columns.table_name, columns.ordinal_position
  LOOP
    v_constraint_name := left(
      v_column.table_name || '_' || v_column.column_name || '_finite_', 53
    ) || substr(md5(
      v_column.table_schema || '.' || v_column.table_name || '.' || v_column.column_name
    ), 1, 8);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conrelid = format('%I.%I', v_column.table_schema, v_column.table_name)::regclass
        AND c.conname = v_constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I::text NOT IN (''NaN'', ''Infinity'', ''-Infinity'')) NOT VALID',
        v_column.table_schema, v_column.table_name, v_constraint_name,
        v_column.column_name, v_column.column_name
      );
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
      v_column.table_schema, v_column.table_name, v_constraint_name
    );
  END LOOP;
END
$do$;

CREATE UNIQUE INDEX IF NOT EXISTS photos_storage_path_uidx
  ON public.photos(storage_path);

CREATE TABLE IF NOT EXISTS private.completion_submission_attempts (
  client_entry_id text PRIMARY KEY,
  report_id bigint NOT NULL REFERENCES public.completion_reports(id) ON DELETE RESTRICT,
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.completion_submission_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.completion_submission_attempts
  FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.completion_resubmission_attempts (
  client_entry_id text PRIMARY KEY,
  report_id bigint NOT NULL REFERENCES public.completion_reports(id) ON DELETE RESTRICT,
  project_id bigint NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.completion_resubmission_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.completion_resubmission_attempts
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.validate_completion_final_fields_strict(
  p_fields jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_key text;
  v_value real;
  v_row jsonb;
  v_type text;
  v_meters real;
  v_total real := 0;
  v_blind real := 0;
  v_filter real := 0;
  v_trap real := 0;
BEGIN
  v_result := private.validate_completion_final_fields(p_fields);

  FOREACH v_key IN ARRAY ARRAY[
    'static_level', 'dynamic_level', 'flow_rate', 'specific_flow_rate',
    'maximum_flow_rate', 'pump_depth_m', 'exploration_depth_m',
    'widening_depth_m', 'casing_total_m', 'casing_above_ground_m',
    'blind_casing_m', 'filter_casing_m', 'sediment_trap_m',
    'bentonite_quantity', 'gravel_quantity', 'compressor_hours',
    'pump_hours', 'installed_meters', 'perforated_meters'
  ]
  LOOP
    IF v_result ? v_key AND NULLIF(btrim(v_result ->> v_key), '') IS NOT NULL THEN
      BEGIN
        v_value := (v_result ->> v_key)::real;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Campo numérico inválido en la Ficha: %', v_key
          USING ERRCODE = '22023';
      END;
      IF private.is_finite_real(v_value) IS NOT TRUE THEN
        RAISE EXCEPTION 'La Ficha no admite valores no finitos: %', v_key
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(v_result -> 'casing_layout')
    ORDER BY (value ->> 'order')::integer
  LOOP
    v_type := v_row ->> 'type';
    IF v_type NOT IN ('ciego', 'filtro', 'deposito', 'otro') THEN
      RAISE EXCEPTION 'Tipo de tramo de entubado inválido: %', v_type
        USING ERRCODE = '22023';
    END IF;
    v_meters := (v_row ->> 'meters')::real;
    IF private.is_finite_real(v_meters) IS NOT TRUE OR v_meters <= 0 THEN
      RAISE EXCEPTION 'Metros inválidos en el esquema de entubado'
        USING ERRCODE = '22023';
    END IF;
    v_total := v_total + v_meters;
    IF v_type = 'ciego' THEN v_blind := v_blind + v_meters; END IF;
    IF v_type = 'filtro' THEN v_filter := v_filter + v_meters; END IF;
    IF v_type = 'deposito' THEN v_trap := v_trap + v_meters; END IF;
  END LOOP;

  RETURN v_result || jsonb_build_object(
    'casing_total_m', v_total,
    'blind_casing_m', v_blind,
    'filter_casing_m', v_filter,
    'sediment_trap_m', v_trap
  );
END;
$$;

REVOKE ALL ON FUNCTION private.validate_completion_final_fields_strict(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.completion_submission_payload(
  p_report public.completion_reports
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_fields jsonb;
BEGIN
  v_fields := private.validate_completion_final_fields_strict(
    jsonb_strip_nulls(jsonb_build_object(
      'static_level', p_report.static_level,
      'dynamic_level', p_report.dynamic_level,
      'flow_rate', p_report.flow_rate,
      'specific_flow_rate', p_report.specific_flow_rate,
      'maximum_flow_rate', p_report.maximum_flow_rate,
      'pump_depth_m', p_report.pump_depth_m,
      'exploration_depth_m', p_report.exploration_depth_m,
      'widening_depth_m', p_report.widening_depth_m,
      'casing_total_m', p_report.casing_total_m,
      'casing_above_ground_m', p_report.casing_above_ground_m,
      'blind_casing_m', p_report.blind_casing_m,
      'filter_casing_m', p_report.filter_casing_m,
      'sediment_trap_m', p_report.sediment_trap_m,
      'centralizer_count', p_report.centralizer_count,
      'bottom_plug_details', p_report.bottom_plug_details,
      'bentonite_quantity', p_report.bentonite_quantity,
      'gravel_quantity', p_report.gravel_quantity,
      'casing_layout', p_report.casing_layout,
      'compressor_hours', p_report.compressor_hours,
      'pump_hours', p_report.pump_hours,
      'water_quality', p_report.water_quality,
      'installed_meters', p_report.installed_meters,
      'perforated_meters', p_report.perforated_meters
    ))
  );
  RETURN jsonb_build_object(
    'final_fields', v_fields - ARRAY[
      '_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'
    ],
    'operator_signature', btrim(p_report.operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_report.completion_notes, '')), ''),
    'pdf_url', p_report.pdf_url
  );
END;
$$;

REVOKE ALL ON FUNCTION private.completion_submission_payload(public.completion_reports)
  FROM PUBLIC, anon, authenticated;

-- Catalog-backed pedido lines take their identity and unit only from the
-- catalog. Caller text remains available only for genuinely free-text lines.
CREATE OR REPLACE FUNCTION private.canonicalize_pedido_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
  v_result jsonb := '[]'::jsonb;
  v_variant public.catalog_variants;
  v_material public.catalog_materials;
  v_name text;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' THEN RETURN p_items; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF public.safe_bigint(v_item ->> 'catalog_variant_id') IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.catalog_variants
      WHERE id = public.safe_bigint(v_item ->> 'catalog_variant_id');
      IF FOUND THEN
        SELECT * INTO v_material
        FROM public.catalog_materials WHERE id = v_variant.material_id;
        IF FOUND THEN
          v_name := CASE
            WHEN public.normalize_catalog_name(v_variant.display_name) = 'estandar'
              THEN v_material.name
            ELSE v_material.name || ' · ' || v_variant.display_name
          END;
          v_item := v_item || jsonb_build_object(
            'catalog_variant_id', v_variant.id,
            'material_name', v_name,
            'unit', v_material.unit
          );
        END IF;
      END IF;
    END IF;
    v_result := v_result || jsonb_build_array(v_item);
  END LOOP;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.canonicalize_pedido_items(jsonb)
  FROM PUBLIC, anon, authenticated;

-- Notification leases are server internals. Authenticated clients authorize
-- and render through the Edge Function but cannot claim or mark events.
DROP FUNCTION IF EXISTS public.claim_notification_event(text, bigint);
DROP FUNCTION IF EXISTS public.mark_notification_event_sent(text, bigint);
DROP FUNCTION IF EXISTS public.release_notification_event_claim(text, bigint);

CREATE FUNCTION public.claim_notification_event(
  p_event_type text,
  p_entity_id bigint,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles;
  v_claimed boolean := false;
BEGIN
  IF p_event_type NOT IN ('pedido_created', 'completion_signed')
     OR p_entity_id IS NULL OR p_entity_id <= 0 OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Invalid notification event' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'active notification actor required' USING ERRCODE = '42501';
  END IF;
  IF p_event_type = 'pedido_created' AND NOT EXISTS (
    SELECT 1 FROM public.pedidos p
    WHERE p.id = p_entity_id
      AND (p.operator_id = p_actor_id OR v_actor.role = 'admin')
  ) THEN
    RAISE EXCEPTION 'Actor is not authorized for this pedido event'
      USING ERRCODE = '42501';
  END IF;
  IF p_event_type = 'completion_signed' AND (
    v_actor.role <> 'admin' OR NOT EXISTS (
      SELECT 1 FROM public.completion_reports cr
      WHERE cr.id = p_entity_id
        AND cr.status = 'approved'
        AND cr.admin_signature IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Actor is not authorized for this completion event'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.notification_event_claims (
    event_type, entity_id, claimed_by, claimed_at
  ) VALUES (p_event_type, p_entity_id, p_actor_id, now())
  ON CONFLICT (event_type, entity_id) DO UPDATE
    SET claimed_by = EXCLUDED.claimed_by, claimed_at = EXCLUDED.claimed_at
    WHERE public.notification_event_claims.sent_at IS NULL
      AND public.notification_event_claims.claimed_at < now() - interval '15 minutes'
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

CREATE FUNCTION public.mark_notification_event_sent(
  p_event_type text,
  p_entity_id bigint,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_marked boolean;
BEGIN
  UPDATE public.notification_event_claims
  SET sent_at = COALESCE(sent_at, now())
  WHERE event_type = p_event_type AND entity_id = p_entity_id
    AND claimed_by = p_actor_id
  RETURNING true INTO STRICT v_marked;
  RETURN true;
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION 'Notification claim is missing or belongs to another actor'
      USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public.release_notification_event_claim(
  p_event_type text,
  p_entity_id bigint,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted boolean := false;
BEGIN
  DELETE FROM public.notification_event_claims
  WHERE event_type = p_event_type AND entity_id = p_entity_id
    AND claimed_by = p_actor_id AND sent_at IS NULL
  RETURNING true INTO v_deleted;
  IF v_deleted THEN RETURN true; END IF;
  IF EXISTS (
    SELECT 1 FROM public.notification_event_claims
    WHERE event_type = p_event_type AND entity_id = p_entity_id
      AND claimed_by = p_actor_id AND sent_at IS NOT NULL
  ) THEN
    RETURN true;
  END IF;
  RAISE EXCEPTION 'Notification claim is missing or belongs to another actor'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_notification_event(text, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_notification_event_sent(text, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_notification_event_claim(text, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_event(text, bigint, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_notification_event_sent(text, bigint, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_notification_event_claim(text, bigint, uuid)
  TO service_role;

-- Physical deletion is performed by admin-delete-project-attachment through
-- the Storage API. Only its service-role finalize step may remove metadata.
DROP FUNCTION IF EXISTS public.delete_project_attachment(bigint, text);

CREATE OR REPLACE FUNCTION public.finalize_project_attachment_delete(
  p_attachment_id bigint,
  p_expected_storage_path text,
  p_reason text,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attachment public.project_attachments;
BEGIN
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo requerido' USING ERRCODE = '22023';
  END IF;
  -- The Edge Function proves the caller is active before Storage removal.
  -- Finalization deliberately accepts that same admin if they are deactivated
  -- during the two-phase operation, preventing an orphaned metadata row after
  -- the physical object has already been removed.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin actor required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_attachment
  FROM public.project_attachments
  WHERE id = p_attachment_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_attachment.storage_path IS DISTINCT FROM p_expected_storage_path THEN
    RAISE EXCEPTION 'Attachment path changed during deletion'
      USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', p_actor_id::text, true);
  PERFORM set_config('phc.audit_reason', btrim(p_reason), true);
  PERFORM private.write_audit(
    v_attachment.project_id, 'attachment.deleted', 'project_attachments',
    v_attachment.id::text, to_jsonb(v_attachment), NULL, p_reason,
    jsonb_build_object('storage_removed_via_api', true)
  );
  DELETE FROM public.project_attachments WHERE id = p_attachment_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_project_attachment_delete(bigint, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_project_attachment_delete(bigint, text, text, uuid)
  TO service_role;

-- --------------------------------------------------------------------------
-- Replay-first wrappers for keyed operational mutations
-- --------------------------------------------------------------------------

ALTER FUNCTION public.start_shift(bigint, uuid, text, timestamptz, timestamptz)
  SET SCHEMA private;
ALTER FUNCTION private.start_shift(bigint, uuid, text, timestamptz, timestamptz)
  RENAME TO start_shift_20260712_impl;
REVOKE ALL ON FUNCTION private.start_shift_20260712_impl(bigint, uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.start_shift(
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
    IF v_existing.request_payload IS DISTINCT FROM v_payload THEN
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

ALTER FUNCTION public.create_drilling_bar(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid)
  SET SCHEMA private;
ALTER FUNCTION private.create_drilling_bar(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid)
  RENAME TO create_drilling_bar_20260712_impl;
REVOKE ALL ON FUNCTION private.create_drilling_bar_20260712_impl(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.create_drilling_bar(
  p_project_id bigint,
  p_soil_type text,
  p_client_entry_id text DEFAULT NULL,
  p_length real DEFAULT NULL,
  p_diameter text DEFAULT NULL,
  p_start_time text DEFAULT NULL,
  p_end_time text DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL,
  p_water_level real DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_photo_paths text DEFAULT NULL,
  p_timestamp_local text DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL
)
RETURNS public.drilling_bars
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.drilling_bars;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF p_client_entry_id IS NOT NULL
     AND length(btrim(p_client_entry_id)) = 0 THEN
    RAISE EXCEPTION 'client_entry_id cannot be blank' USING ERRCODE = '22023';
  END IF;
  IF p_shift_id IS NOT NULL AND p_client_entry_id IS NULL THEN
    RAISE EXCEPTION 'Shift-bound bars require client_entry_id' USING ERRCODE = '22023';
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'soil_type', btrim(p_soil_type),
    'length', p_length, 'diameter', p_diameter,
    'start_time', p_start_time, 'end_time', p_end_time,
    'duration_minutes', p_duration_minutes, 'water_level', p_water_level,
    'notes', p_notes, 'photo_paths', p_photo_paths,
    'timestamp_local', p_timestamp_local, 'shift_id', p_shift_id
  ));
  IF p_client_entry_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('create_drilling_bar:' || p_client_entry_id, 0)
    );
    SELECT * INTO v_existing
    FROM public.drilling_bars
    WHERE client_entry_id = p_client_entry_id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.operator_id IS DISTINCT FROM auth.uid()
         OR v_existing.project_id IS DISTINCT FROM p_project_id
         OR v_existing.request_payload IS DISTINCT FROM v_payload THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;
  RETURN private.create_drilling_bar_20260712_impl(
    p_project_id, p_soil_type, p_client_entry_id, p_length, p_diameter,
    p_start_time, p_end_time, p_duration_minutes, p_water_level, p_notes,
    p_photo_paths, p_timestamp_local, p_shift_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_drilling_bar(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_drilling_bar(bigint, text, text, real, text, text, text, integer, real, text, text, text, uuid)
  TO authenticated, service_role;

ALTER FUNCTION public.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean)
  SET SCHEMA private;
ALTER FUNCTION private.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean)
  RENAME TO record_material_consumption_20260712_impl;
REVOKE ALL ON FUNCTION private.record_material_consumption_20260712_impl(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.record_material_consumption(
  p_project_id bigint,
  p_quantity_used real,
  p_client_entry_id text DEFAULT NULL,
  p_project_material_id bigint DEFAULT NULL,
  p_material_id bigint DEFAULT NULL,
  p_material_name text DEFAULT NULL,
  p_unit text DEFAULT NULL,
  p_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_approximate boolean DEFAULT false
)
RETURNS public.material_consumption
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.material_consumption;
  v_assignment public.project_materials;
  v_payload jsonb;
  v_legacy_payload jsonb;
  v_material_id bigint := p_material_id;
  v_material_name text := p_material_name;
  v_unit text := p_unit;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF p_client_entry_id IS NOT NULL AND length(btrim(p_client_entry_id)) = 0 THEN
    RAISE EXCEPTION 'client_entry_id cannot be blank' USING ERRCODE = '22023';
  END IF;
  IF p_shift_id IS NOT NULL AND p_client_entry_id IS NULL THEN
    RAISE EXCEPTION 'Shift-bound consumption requires client_entry_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_project_material_id IS NOT NULL THEN
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = p_project_material_id AND project_id = p_project_id;
    IF FOUND THEN
      v_material_id := v_assignment.material_id;
      v_material_name := v_assignment.material_name;
      v_unit := v_assignment.unit;
    END IF;
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'quantity_used', p_quantity_used,
    'project_material_id', p_project_material_id, 'material_id', v_material_id,
    'material_name', v_material_name, 'unit', v_unit, 'date', p_date,
    'notes', p_notes, 'shift_id', p_shift_id,
    'approximate', COALESCE(p_approximate, false)
  ));
  v_legacy_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'quantity_used', p_quantity_used,
    'project_material_id', p_project_material_id, 'material_id', p_material_id,
    'material_name', p_material_name, 'unit', p_unit, 'date', p_date,
    'notes', p_notes, 'shift_id', p_shift_id,
    'approximate', COALESCE(p_approximate, false)
  ));
  IF p_client_entry_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('record_material_consumption:' || p_client_entry_id, 0)
    );
    SELECT * INTO v_existing
    FROM public.material_consumption
    WHERE client_entry_id = p_client_entry_id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.operator_id IS DISTINCT FROM auth.uid()
         OR v_existing.project_id IS DISTINCT FROM p_project_id
         OR (
           v_existing.request_payload IS DISTINCT FROM v_payload
           AND v_existing.request_payload IS DISTINCT FROM v_legacy_payload
         ) THEN
        RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  RETURN private.record_material_consumption_20260712_impl(
    p_project_id, p_quantity_used, p_client_entry_id, p_project_material_id,
    v_material_id, v_material_name, v_unit, p_date, p_notes,
    p_shift_id, p_approximate
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_material_consumption(bigint, real, text, bigint, bigint, text, text, date, text, uuid, boolean)
  TO authenticated, service_role;

ALTER FUNCTION public.create_pedido_v2(bigint, text, jsonb, text, text, text, date, text)
  SET SCHEMA private;
ALTER FUNCTION private.create_pedido_v2(bigint, text, jsonb, text, text, text, date, text)
  RENAME TO create_pedido_v2_20260712_impl;
REVOKE ALL ON FUNCTION private.create_pedido_v2_20260712_impl(bigint, text, jsonb, text, text, text, date, text)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.create_pedido_v2(
  p_project_id bigint,
  p_kind text,
  p_items jsonb,
  p_client_entry_id text,
  p_justification text DEFAULT NULL,
  p_priority text DEFAULT 'Normal',
  p_needed_by date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.pedidos;
  v_items jsonb;
  v_payload jsonb;
  v_legacy_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;
  v_items := private.canonicalize_pedido_items(p_items);
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'kind', p_kind, 'items', v_items,
    'justification', NULLIF(btrim(COALESCE(p_justification, '')), ''),
    'priority', COALESCE(p_priority, 'Normal'), 'needed_by', p_needed_by,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
  ));
  v_legacy_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'kind', p_kind, 'items', p_items,
    'justification', NULLIF(btrim(COALESCE(p_justification, '')), ''),
    'priority', COALESCE(p_priority, 'Normal'), 'needed_by', p_needed_by,
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('create_pedido_v2:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_existing
  FROM public.pedidos
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.kind IS DISTINCT FROM p_kind
       OR (
         v_existing.request_payload IS DISTINCT FROM v_payload
         AND v_existing.request_payload IS DISTINCT FROM v_legacy_payload
       ) THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'pedido', to_jsonb(v_existing),
      'items', (
        SELECT COALESCE(jsonb_agg(to_jsonb(pi) ORDER BY pi.id), '[]'::jsonb)
        FROM public.pedido_items pi WHERE pi.pedido_id = v_existing.id
      ),
      'idempotent_replay', true
    );
  END IF;
  RETURN private.create_pedido_v2_20260712_impl(
    p_project_id, p_kind, v_items, p_client_entry_id,
    p_justification, p_priority, p_needed_by, p_notes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_pedido_v2(bigint, text, jsonb, text, text, text, date, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pedido_v2(bigint, text, jsonb, text, text, text, date, text)
  TO authenticated, service_role;

ALTER FUNCTION public.confirm_pedido_item_receipt(bigint, text, text, real, text)
  SET SCHEMA private;
ALTER FUNCTION private.confirm_pedido_item_receipt(bigint, text, text, real, text)
  RENAME TO confirm_pedido_item_receipt_20260712_impl;
REVOKE ALL ON FUNCTION private.confirm_pedido_item_receipt_20260712_impl(bigint, text, text, real, text)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.confirm_pedido_item_receipt(
  p_item_id bigint,
  p_client_entry_id text,
  p_outcome text,
  p_quantity_received real DEFAULT 0,
  p_incident_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item public.pedido_items;
  v_pedido public.pedidos;
  v_existing public.pedido_receipts;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.pedido_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = v_item.pedido_id;
  IF v_pedido.operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the requesting operator can confirm receipt'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('confirm_pedido_item_receipt:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_existing
  FROM public.pedido_receipts
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.confirmed_by IS DISTINCT FROM auth.uid()
       OR v_existing.pedido_item_id IS DISTINCT FROM p_item_id
       OR v_existing.outcome IS DISTINCT FROM p_outcome
       OR v_existing.quantity_received IS DISTINCT FROM COALESCE(p_quantity_received, 0)
       OR v_existing.incident_note IS DISTINCT FROM
          NULLIF(btrim(COALESCE(p_incident_note, '')), '') THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'receipt', to_jsonb(v_existing),
      'item', to_jsonb(v_item),
      'idempotent_replay', true
    );
  END IF;
  RETURN private.confirm_pedido_item_receipt_20260712_impl(
    p_item_id, p_client_entry_id, p_outcome,
    p_quantity_received, p_incident_note
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_pedido_item_receipt(bigint, text, text, real, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_pedido_item_receipt(bigint, text, text, real, text)
  TO authenticated, service_role;

ALTER FUNCTION public.submit_completion_v2(bigint, text, jsonb, text, text, text)
  SET SCHEMA private;
ALTER FUNCTION private.submit_completion_v2(bigint, text, jsonb, text, text, text)
  RENAME TO submit_completion_v2_20260712_impl;
REVOKE ALL ON FUNCTION private.submit_completion_v2_20260712_impl(bigint, text, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.submit_completion_v2(
  p_project_id bigint,
  p_client_entry_id text,
  p_final_fields jsonb,
  p_operator_signature text,
  p_completion_notes text DEFAULT NULL,
  p_pdf_url text DEFAULT NULL
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.completion_reports;
  v_attempt private.completion_submission_attempts;
  v_fields jsonb;
  v_payload jsonb;
  v_existing_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  -- Operator testimony cannot be manufactured through an admin bypass.
  IF NOT public.is_closing_operator(p_project_id) THEN
    RAISE EXCEPTION 'Only the responsible closing operator may submit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(btrim(COALESCE(p_operator_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Identificador y firma del operador requeridos'
      USING ERRCODE = '22023';
  END IF;
  v_fields := private.validate_completion_final_fields_strict(p_final_fields);
  v_payload := jsonb_build_object(
    'final_fields', v_fields - ARRAY[
      '_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'
    ],
    'operator_signature', btrim(p_operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
    'pdf_url', p_pdf_url
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('submit_completion_v2:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_attempt
  FROM private.completion_submission_attempts
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_attempt.project_id IS DISTINCT FROM p_project_id
       OR v_attempt.actor_id IS DISTINCT FROM auth.uid()
       OR v_attempt.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_existing
    FROM public.completion_reports WHERE id = v_attempt.report_id;
    RETURN v_existing;
  END IF;
  SELECT * INTO v_existing
  FROM public.completion_reports
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    v_existing_payload := COALESCE(
      v_existing.submission_payload,
      CASE WHEN v_existing.format_version >= 2
        THEN private.completion_submission_payload(v_existing)
      END
    );
    IF v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    INSERT INTO private.completion_submission_attempts (
      client_entry_id, report_id, project_id, actor_id, request_payload
    ) VALUES (
      p_client_entry_id, v_existing.id, p_project_id, auth.uid(), v_payload
    );
    RETURN v_existing;
  END IF;
  v_existing := private.submit_completion_v2_20260712_impl(
    p_project_id, p_client_entry_id, v_fields, p_operator_signature,
    p_completion_notes, p_pdf_url
  );
  INSERT INTO private.completion_submission_attempts (
    client_entry_id, report_id, project_id, actor_id, request_payload
  ) VALUES (
    p_client_entry_id, v_existing.id, p_project_id, auth.uid(), v_payload
  );
  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_completion_v2(bigint, text, jsonb, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_completion_v2(bigint, text, jsonb, text, text, text)
  TO authenticated, service_role;

ALTER FUNCTION public.resubmit_completion_v2(bigint, text, jsonb, text, text, text)
  SET SCHEMA private;
ALTER FUNCTION private.resubmit_completion_v2(bigint, text, jsonb, text, text, text)
  RENAME TO resubmit_completion_v2_20260712_impl;
REVOKE ALL ON FUNCTION private.resubmit_completion_v2_20260712_impl(bigint, text, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.resubmit_completion_v2(
  p_report_id bigint,
  p_client_entry_id text,
  p_final_fields jsonb,
  p_operator_signature text,
  p_completion_notes text DEFAULT NULL,
  p_pdf_url text DEFAULT NULL
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_report public.completion_reports;
  v_attempt private.completion_resubmission_attempts;
  v_fields jsonb;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0
     OR length(btrim(COALESCE(p_operator_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Identificador y firma del operador requeridos'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report FROM public.completion_reports WHERE id = p_report_id;
  IF NOT FOUND OR v_report.format_version < 2 THEN
    RAISE EXCEPTION 'Ficha v2 no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_closing_operator(v_report.project_id)
     OR v_report.operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the responsible closing operator may resubmit the Ficha'
      USING ERRCODE = '42501';
  END IF;
  v_fields := private.validate_completion_final_fields_strict(p_final_fields);
  v_payload := jsonb_build_object(
    'final_fields', v_fields - ARRAY[
      '_specific_flow_calculated', '_specific_flow_overridden', '_hydraulic_mismatch'
    ],
    'operator_signature', btrim(p_operator_signature),
    'completion_notes', NULLIF(btrim(COALESCE(p_completion_notes, '')), ''),
    'pdf_url', p_pdf_url
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('resubmit_completion_v2:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_attempt
  FROM private.completion_resubmission_attempts
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_attempt.report_id IS DISTINCT FROM p_report_id
       OR v_attempt.project_id IS DISTINCT FROM v_report.project_id
       OR v_attempt.actor_id IS DISTINCT FROM auth.uid()
       OR v_attempt.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_report FROM public.completion_reports WHERE id = v_attempt.report_id;
    RETURN v_report;
  END IF;

  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF v_report.last_resubmission_id = p_client_entry_id THEN
    IF v_report.submission_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    INSERT INTO private.completion_resubmission_attempts (
      client_entry_id, report_id, project_id, actor_id, request_payload
    ) VALUES (
      p_client_entry_id, p_report_id, v_report.project_id, auth.uid(), v_payload
    );
    RETURN v_report;
  END IF;

  v_report := private.resubmit_completion_v2_20260712_impl(
    p_report_id, p_client_entry_id, v_fields, p_operator_signature,
    p_completion_notes, p_pdf_url
  );
  INSERT INTO private.completion_resubmission_attempts (
    client_entry_id, report_id, project_id, actor_id, request_payload
  ) VALUES (
    p_client_entry_id, p_report_id, v_report.project_id, auth.uid(), v_payload
  );
  RETURN v_report;
END;
$$;

REVOKE ALL ON FUNCTION public.resubmit_completion_v2(bigint, text, jsonb, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resubmit_completion_v2(bigint, text, jsonb, text, text, text)
  TO authenticated, service_role;

ALTER FUNCTION public.register_water_sample(bigint, text, timestamptz, real, text, text, text, integer, timestamptz)
  SET SCHEMA private;
ALTER FUNCTION private.register_water_sample(bigint, text, timestamptz, real, text, text, text, integer, timestamptz)
  RENAME TO register_water_sample_20260712_impl;
REVOKE ALL ON FUNCTION private.register_water_sample_20260712_impl(bigint, text, timestamptz, real, text, text, text, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.register_water_sample(
  p_project_id bigint,
  p_client_entry_id text,
  p_taken_at timestamptz,
  p_depth_m real DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_bottle_photo_path text DEFAULT NULL,
  p_sample_number integer DEFAULT NULL,
  p_timestamp_local timestamptz DEFAULT NULL
)
RETURNS public.water_samples
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.water_samples;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_project_operator(p_project_id) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to this project' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 OR p_taken_at IS NULL THEN
    RAISE EXCEPTION 'client_entry_id and taken_at required' USING ERRCODE = '22023';
  END IF;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id, 'taken_at', p_taken_at,
    'depth_m', p_depth_m, 'stage', NULLIF(btrim(COALESCE(p_stage, '')), ''),
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''),
    'bottle_photo_path', p_bottle_photo_path,
    'sample_number', p_sample_number, 'timestamp_local', p_timestamp_local
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('register_water_sample:' || p_client_entry_id, 0)
  );
  SELECT * INTO v_existing
  FROM public.water_samples
  WHERE client_entry_id = p_client_entry_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operator_id IS DISTINCT FROM auth.uid()
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  RETURN private.register_water_sample_20260712_impl(
    p_project_id, p_client_entry_id, p_taken_at, p_depth_m, p_stage,
    p_notes, p_bottle_photo_path, p_sample_number, p_timestamp_local
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_water_sample(bigint, text, timestamptz, real, text, text, text, integer, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_water_sample(bigint, text, timestamptz, real, text, text, text, integer, timestamptz)
  TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- Canonical, collision-safe shift testimony and usage batches
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_shift_handover(
  p_shift_id uuid,
  p_items jsonb
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shift public.shifts;
  v_item jsonb;
  v_items jsonb := COALESCE(p_items, '[]'::jsonb);
  v_payload jsonb;
  v_assignment public.project_materials;
  v_existing public.shift_handovers;
  v_status text;
  v_client_entry_id text;
  v_observed real;
  v_note text;
  v_photo_path text;
  v_was_confirmed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.operator_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the operator can confirm this shift handover'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'items must be an array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) item
    WHERE public.safe_bigint(item ->> 'project_material_id') IS NULL
       OR public.safe_bigint(item ->> 'project_material_id') <= 0
  ) THEN
    RAISE EXCEPTION 'Each handover item needs a valid project_material_id'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) item
    GROUP BY public.safe_bigint(item ->> 'project_material_id')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Each handover material may appear only once'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) item
    LEFT JOIN public.project_materials pm
      ON pm.id = public.safe_bigint(item ->> 'project_material_id')
     AND pm.project_id = v_shift.project_id
     AND pm.active IS TRUE
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'A handover item is not an active material in this project'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_materials pm
    WHERE pm.project_id = v_shift.project_id AND pm.active IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_items) item
        WHERE public.safe_bigint(item ->> 'project_material_id') = pm.id
      )
  ) THEN
    RAISE EXCEPTION 'The handover must explicitly include every active project material'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(
    (value - 'project_material_id') || jsonb_build_object(
      'project_material_id', public.safe_bigint(value ->> 'project_material_id')
    ) ORDER BY public.safe_bigint(value ->> 'project_material_id')
  ), '[]'::jsonb)
  INTO v_payload
  FROM jsonb_array_elements(v_items);

  v_was_confirmed := v_shift.handover_confirmed IS TRUE;
  IF v_was_confirmed AND v_shift.request_payload ? 'handover' THEN
    IF v_shift.request_payload -> 'handover' IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Idempotency replay does not match the confirmed handover'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_shift;
  END IF;
  IF NOT v_was_confirmed AND v_shift.status NOT IN ('open', 'report_pending') THEN
    RAISE EXCEPTION 'Only an unresolved shift can confirm a handover'
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_was_confirmed
     AND NOT public.project_allows_field_work(v_shift.project_id) THEN
    RAISE EXCEPTION 'Project is not open for field work' USING ERRCODE = '55000';
  END IF;

  FOR v_assignment IN
    SELECT * FROM public.project_materials
    WHERE project_id = v_shift.project_id AND active IS TRUE
    ORDER BY id
    FOR UPDATE
  LOOP
    v_item := NULL;
    SELECT value INTO v_item
    FROM jsonb_array_elements(v_items)
    WHERE public.safe_bigint(value ->> 'project_material_id') = v_assignment.id
    LIMIT 1;
    v_status := COALESCE(v_item ->> 'status', 'confirmed');
    v_client_entry_id := COALESCE(
      NULLIF(v_item ->> 'client_entry_id', ''),
      'handover:' || p_shift_id::text || ':' || v_assignment.id::text
    );
    IF v_status NOT IN ('confirmed', 'flagged') THEN
      RAISE EXCEPTION 'Invalid handover status' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_observed := NULLIF(v_item ->> 'observed_quantity', '')::real;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Observed handover quantity is invalid' USING ERRCODE = '22023';
    END;
    IF v_observed IS NOT NULL
       AND (private.is_finite_real(v_observed) IS NOT TRUE OR v_observed < 0) THEN
      RAISE EXCEPTION 'Observed handover quantity must be finite and nonnegative'
        USING ERRCODE = '22023';
    END IF;
    IF v_status = 'flagged' AND v_observed IS NULL THEN
      RAISE EXCEPTION 'A flagged handover requires the observed quantity'
        USING ERRCODE = '22023';
    END IF;
    v_note := NULLIF(v_item ->> 'note', '');
    v_photo_path := NULLIF(v_item ->> 'photo_path', '');
    IF v_status = 'flagged' AND length(btrim(COALESCE(v_note, ''))) < 3 THEN
      RAISE EXCEPTION 'A flagged handover requires an explanatory note'
        USING ERRCODE = '22023';
    END IF;
    IF v_photo_path IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.photos ph
      WHERE ph.project_id = v_shift.project_id
        AND ph.shift_id = v_shift.id
        AND ph.storage_path = v_photo_path
        AND ph.uploaded_by = auth.uid()
        AND ph.evidence_kind = 'field'
    ) THEN
      RAISE EXCEPTION 'Handover photo is missing or outside this shift'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_existing
    FROM public.shift_handovers
    WHERE shift_id = p_shift_id AND project_material_id = v_assignment.id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.client_entry_id IS DISTINCT FROM v_client_entry_id
         OR v_existing.status IS DISTINCT FROM v_status
         OR v_existing.observed_quantity IS DISTINCT FROM v_observed
         OR v_existing.note IS DISTINCT FROM v_note
         OR v_existing.photo_path IS DISTINCT FROM v_photo_path
         OR v_existing.confirmed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Idempotency replay does not match handover testimony'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      IF v_was_confirmed THEN
        RAISE EXCEPTION 'Confirmed handover testimony is incomplete'
          USING ERRCODE = '23505';
      END IF;
      INSERT INTO public.shift_handovers (
        client_entry_id, shift_id, project_material_id, status,
        expected_quantity, observed_quantity, note, photo_path, confirmed_by
      ) VALUES (
        v_client_entry_id, p_shift_id, v_assignment.id, v_status,
        COALESCE(v_assignment.current_quantity, 0), v_observed,
        v_note, v_photo_path, auth.uid()
      );
    END IF;
  END LOOP;

  UPDATE public.shifts
  SET handover_confirmed = true,
      request_payload = COALESCE(request_payload, '{}'::jsonb)
        || jsonb_build_object('handover', v_payload),
      updated_at = now()
  WHERE id = p_shift_id
  RETURNING * INTO v_shift;

  IF NOT v_was_confirmed THEN
    PERFORM private.write_audit(
      v_shift.project_id, 'shift.handover_confirmed', 'shifts', v_shift.id::text,
      NULL, to_jsonb(v_shift), NULL,
      jsonb_build_object('item_count', jsonb_array_length(v_items))
    );
  END IF;
  RETURN v_shift;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_shift(
  p_shift_id uuid,
  p_usage jsonb,
  p_notes text DEFAULT NULL,
  p_device_ended_at timestamptz DEFAULT NULL,
  p_end_type text DEFAULT 'manual'
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
     AND pm.active IS TRUE
    WHERE pm.id IS NULL
  ) THEN
    RAISE EXCEPTION 'El informe debe incluir exactamente cada material activo del proyecto'
      USING ERRCODE = '22023';
  END IF;

  v_authoritative_end := now();
  IF p_device_ended_at IS NOT NULL
     AND p_device_ended_at >= v_shift.started_at
     AND p_device_ended_at <= now() + interval '15 minutes' THEN
    v_authoritative_end := least(p_device_ended_at, now());
  END IF;
  IF v_authoritative_end >= v_shift.started_at + interval '12 hours'
     OR v_shift.status = 'report_pending' THEN
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
    IF private.is_finite_real(v_quantity) IS NOT TRUE OR v_quantity < 0 THEN
      RAISE EXCEPTION 'Usage must be finite and nonnegative' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_assignment
    FROM public.project_materials
    WHERE id = public.safe_bigint(v_item ->> 'project_material_id')
      AND project_id = v_shift.project_id AND active IS TRUE
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
      v_anomaly := v_quantity > COALESCE(v_assignment.current_quantity, 0);
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
        p_device_ended_at IS NOT NULL AND (
          p_device_ended_at < started_at
          OR p_device_ended_at > now() + interval '15 minutes'
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
$$;

-- --------------------------------------------------------------------------
-- Replay-safe admin finalization and complete signed dossier evidence
-- --------------------------------------------------------------------------

ALTER FUNCTION public.register_project_attachment(bigint, text, text, text, text, text, bigint)
  SET SCHEMA private;
ALTER FUNCTION private.register_project_attachment(bigint, text, text, text, text, text, bigint)
  RENAME TO register_project_attachment_20260712_impl;
REVOKE ALL ON FUNCTION private.register_project_attachment_20260712_impl(bigint, text, text, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.register_project_attachment(
  p_project_id bigint,
  p_kind text,
  p_storage_path text,
  p_filename text DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_water_sample_id bigint DEFAULT NULL
)
RETURNS public.project_attachments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.project_attachments;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_storage_path, ''))) = 0 THEN
    RAISE EXCEPTION 'storage_path required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('register_project_attachment:' || p_storage_path, 0)
  );
  SELECT * INTO v_existing
  FROM public.project_attachments
  WHERE storage_path = p_storage_path
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.kind IS DISTINCT FROM p_kind
       OR v_existing.filename IS DISTINCT FROM p_filename
       OR (p_mime_type IS NOT NULL AND v_existing.mime_type IS DISTINCT FROM p_mime_type)
       OR v_existing.notes IS DISTINCT FROM p_notes
       OR v_existing.water_sample_id IS DISTINCT FROM p_water_sample_id
       OR v_existing.uploaded_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Attachment path idempotency mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  RETURN private.register_project_attachment_20260712_impl(
    p_project_id, p_kind, p_storage_path, p_filename,
    p_mime_type, p_notes, p_water_sample_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_project_attachment(bigint, text, text, text, text, text, bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_project_attachment(bigint, text, text, text, text, text, bigint)
  TO authenticated, service_role;

ALTER FUNCTION public.attach_completion_pdf(bigint, text) SET SCHEMA private;
ALTER FUNCTION private.attach_completion_pdf(bigint, text)
  RENAME TO attach_completion_pdf_20260712_impl;
REVOKE ALL ON FUNCTION private.attach_completion_pdf_20260712_impl(bigint, text)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.attach_completion_pdf(
  p_report_id bigint,
  p_storage_path text
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_report public.completion_reports;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('attach_completion_pdf:' || p_report_id::text, 0)
  );
  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.signed_pdf_attached_at IS NOT NULL THEN
    IF v_report.pdf_url IS DISTINCT FROM p_storage_path THEN
      RAISE EXCEPTION 'A different signed PDF is already attached'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_report;
  END IF;
  RETURN private.attach_completion_pdf_20260712_impl(p_report_id, p_storage_path);
END;
$$;

REVOKE ALL ON FUNCTION public.attach_completion_pdf(bigint, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_completion_pdf(bigint, text)
  TO authenticated, service_role;

ALTER FUNCTION public.sign_completion_report(bigint, text, boolean, boolean)
  SET SCHEMA private;
ALTER FUNCTION private.sign_completion_report(bigint, text, boolean, boolean)
  RENAME TO sign_completion_report_20260712_impl;
REVOKE ALL ON FUNCTION private.sign_completion_report_20260712_impl(bigint, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.sign_completion_report(
  p_report_id bigint,
  p_admin_signature text,
  p_complete_project boolean DEFAULT true,
  p_acknowledge_open_pedidos boolean DEFAULT false
)
RETURNS public.completion_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_report public.completion_reports;
  v_open_pedidos integer;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_admin_signature, ''))) < 2 THEN
    RAISE EXCEPTION 'Firma del administrador requerida' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sign_completion_report:' || p_report_id::text, 0)
  );
  SELECT * INTO v_report
  FROM public.completion_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.admin_signature IS NOT NULL AND btrim(v_report.admin_signature) <> '' THEN
    IF btrim(v_report.admin_signature) IS DISTINCT FROM btrim(p_admin_signature) THEN
      RAISE EXCEPTION 'Signing replay payload mismatch' USING ERRCODE = '23505';
    END IF;
    IF v_report.format_version >= 2 AND p_complete_project IS NOT TRUE THEN
      RAISE EXCEPTION 'A signed Ficha v2 must keep the project completed'
        USING ERRCODE = '23505';
    END IF;
    IF p_complete_project IS TRUE AND NOT EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = v_report.project_id
        AND public.project_status_key(p.status) = 'completed'
    ) THEN
      RAISE EXCEPTION 'Signed report/project state mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO v_open_pedidos
    FROM public.pedidos p
    WHERE p.project_id = v_report.project_id
      AND p.kind = 'empresa'
      AND p.status NOT IN ('Cerrado', 'Rechazado');
    IF v_report.format_version >= 2 AND v_open_pedidos > 0
       AND p_acknowledge_open_pedidos IS NOT TRUE THEN
      RAISE EXCEPTION 'Signing replay must preserve the open-pedido acknowledgement'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_report;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.shift_handovers h
    JOIN public.shifts s ON s.id = h.shift_id
    LEFT JOIN public.material_reconciliations r
      ON r.project_id = s.project_id
     AND r.project_material_id = h.project_material_id
     AND r.updated_at >= h.created_at
    WHERE s.project_id = v_report.project_id
      AND h.status = 'flagged'
      AND r.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Reconcile every flagged shift handover before signing'
      USING ERRCODE = '55000';
  END IF;
  RETURN private.sign_completion_report_20260712_impl(
    p_report_id, p_admin_signature, p_complete_project,
    p_acknowledge_open_pedidos
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sign_completion_report(bigint, text, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_completion_report(bigint, text, boolean, boolean)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_closing_ficha_preview(p_project_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() AND NOT public.is_closing_operator(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to Ficha preview' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'project', (SELECT to_jsonb(p) FROM public.projects p WHERE p.id = p_project_id),
    'bars', (SELECT COALESCE(jsonb_agg(
               private.apply_record_corrections(to_jsonb(b), 'drilling_bars', b.id::text)
               ORDER BY b.bar_number), '[]'::jsonb)
             FROM public.drilling_bars b WHERE b.project_id = p_project_id),
    'shifts', (SELECT COALESCE(jsonb_agg(
                 private.apply_record_corrections(to_jsonb(s), 'shifts', s.id::text)
                 ORDER BY s.started_at), '[]'::jsonb)
               FROM public.shifts s WHERE s.project_id = p_project_id),
    'shift_handovers', (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.created_at, h.id), '[]'::jsonb)
                        FROM public.shift_handovers h
                        JOIN public.shifts s ON s.id = h.shift_id
                        WHERE s.project_id = p_project_id),
    'photos', (SELECT COALESCE(jsonb_agg(to_jsonb(ph) ORDER BY ph.created_at, ph.id), '[]'::jsonb)
               FROM public.photos ph WHERE ph.project_id = p_project_id),
    'materials', (SELECT COALESCE(jsonb_agg(to_jsonb(pm) ORDER BY pm.layer, pm.material_name), '[]'::jsonb)
                  FROM public.project_materials pm WHERE pm.project_id = p_project_id AND pm.active IS TRUE),
    'consumption', (SELECT COALESCE(jsonb_agg(
                      private.apply_record_corrections(to_jsonb(mc), 'material_consumption', mc.id::text)
                      ORDER BY mc.created_at), '[]'::jsonb)
                    FROM public.material_consumption mc WHERE mc.project_id = p_project_id),
    'samples', (SELECT COALESCE(jsonb_agg(
                  private.apply_record_corrections(to_jsonb(ws), 'water_samples', ws.id::text)
                  ORDER BY ws.sample_number), '[]'::jsonb)
                FROM public.water_samples ws WHERE ws.project_id = p_project_id),
    'company_pedidos', (
      SELECT COALESCE(jsonb_agg(
        to_jsonb(p) || jsonb_build_object(
          'items', (
            SELECT COALESCE(jsonb_agg(
              to_jsonb(pi) || jsonb_build_object(
                'receipts', (
                  SELECT COALESCE(jsonb_agg(to_jsonb(pr) ORDER BY pr.created_at, pr.id), '[]'::jsonb)
                  FROM public.pedido_receipts pr WHERE pr.pedido_item_id = pi.id
                )
              ) ORDER BY pi.id
            ), '[]'::jsonb)
            FROM public.pedido_items pi WHERE pi.pedido_id = p.id
          )
        ) ORDER BY p.created_at
      ), '[]'::jsonb)
      FROM public.pedidos p WHERE p.project_id = p_project_id AND p.kind = 'empresa'
    ),
    'corrections', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at), '[]'::jsonb)
                    FROM public.record_corrections c WHERE c.project_id = p_project_id),
    'discrepancies', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]'::jsonb)
                      FROM public.completion_discrepancies d WHERE d.project_id = p_project_id),
    'completion', (SELECT private.apply_record_corrections(
                     to_jsonb(cr), 'completion_reports', cr.id::text)
                   FROM public.completion_reports cr
                   WHERE cr.project_id = p_project_id ORDER BY cr.created_at DESC LIMIT 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_project_dossier(p_project_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_base jsonb;
  v_snapshot jsonb;
  v_completion public.completion_reports;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_completion
  FROM public.completion_reports cr
  WHERE cr.project_id = p_project_id
  ORDER BY cr.finalized_at DESC NULLS LAST, cr.created_at DESC
  LIMIT 1;
  v_snapshot := v_completion.finalized_snapshot;
  IF v_snapshot IS NOT NULL THEN
    -- The original signing transaction snapshots evidence before flipping the
    -- project to completed. Overlay the now-immutable canonical project row so
    -- the signed read model reflects the atomic final lifecycle state.
    v_snapshot := jsonb_set(
      v_snapshot,
      ARRAY['project'],
      (SELECT to_jsonb(p) FROM public.projects p WHERE p.id = p_project_id),
      true
    );
    v_snapshot := jsonb_set(
      v_snapshot,
      ARRAY['completion'],
      COALESCE(v_snapshot -> 'completion', '{}'::jsonb)
        || (to_jsonb(v_completion) - 'finalized_snapshot'),
      true
    );
    RETURN v_snapshot || jsonb_build_object(
      -- Projects completed before this corrective migration may have an older
      -- snapshot shape. These sources are immutable after signing, so overlay
      -- their canonical rows to give every signed dossier the complete model.
      'shift_handovers', (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.created_at, h.id), '[]'::jsonb)
                          FROM public.shift_handovers h
                          JOIN public.shifts s ON s.id = h.shift_id
                          WHERE s.project_id = p_project_id),
      'photos', (SELECT COALESCE(jsonb_agg(to_jsonb(ph) ORDER BY ph.created_at, ph.id), '[]'::jsonb)
                 FROM public.photos ph WHERE ph.project_id = p_project_id),
      'company_pedidos', (
        SELECT COALESCE(jsonb_agg(
          to_jsonb(p) || jsonb_build_object(
            'items', (
              SELECT COALESCE(jsonb_agg(
                to_jsonb(pi) || jsonb_build_object(
                  'receipts', (
                    SELECT COALESCE(jsonb_agg(to_jsonb(pr) ORDER BY pr.created_at, pr.id), '[]'::jsonb)
                    FROM public.pedido_receipts pr WHERE pr.pedido_item_id = pi.id
                  )
                ) ORDER BY pi.id
              ), '[]'::jsonb)
              FROM public.pedido_items pi WHERE pi.pedido_id = p.id
            )
          ) ORDER BY p.created_at
        ), '[]'::jsonb)
        FROM public.pedidos p WHERE p.project_id = p_project_id AND p.kind = 'empresa'
      ),
      'reconciliations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
                          FROM public.material_reconciliations r WHERE r.project_id = p_project_id),
      'attachments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at), '[]'::jsonb)
                      FROM public.project_attachments a WHERE a.project_id = p_project_id),
      'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(al) ORDER BY al.created_at), '[]'::jsonb)
                FROM public.audit_log al WHERE al.project_id = p_project_id),
      'signed_snapshot', true
    );
  END IF;

  v_base := public.get_closing_ficha_preview(p_project_id);
  RETURN v_base || jsonb_build_object(
    'attachments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at), '[]'::jsonb)
                    FROM public.project_attachments a WHERE a.project_id = p_project_id),
    'reconciliations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
                        FROM public.material_reconciliations r WHERE r.project_id = p_project_id),
    'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(al) ORDER BY al.created_at), '[]'::jsonb)
              FROM public.audit_log al WHERE al.project_id = p_project_id)
  );
END;
$$;
