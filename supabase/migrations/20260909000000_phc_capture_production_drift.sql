-- Records in the repo what production already has.
--
-- On 2026-09-09 these changes were applied to production by hand and never
-- reached this repo, so a database rebuilt from git silently lost them. They
-- are generated from production's own schema dump (backup of 2026-11-02), not
-- written by hand. Nothing changes on production when this runs: every statement
-- can be repeated and leaves the same result.
--
-- Left out on purpose, because no application code uses them:
--   public.llm_settings and its trigger, public.touch_updated_at()
--   private.pre_reset_snapshot_20260712, private.pre_v2_snapshot
--
-- Duplicate read policies were merged into one policy per table; the access they
-- allow was not meant to change (finding F1 in docs/audits/PHC_CODE_AUDIT_2026-10-30_IN_PROGRESS.md).

BEGIN;

-- 1. Replace the old policies with production's merged ones.
DROP POLICY IF EXISTS "Signed-in users can report their own errors" ON "public"."client_errors";
DROP POLICY IF EXISTS "Active operators view own completion reports" ON "public"."completion_reports";
DROP POLICY IF EXISTS "Admins can view all completion reports" ON "public"."completion_reports";
DROP POLICY IF EXISTS "Closing operators view project completion reports" ON "public"."completion_reports";
DROP POLICY IF EXISTS "Read own closing or admin completion reports" ON "public"."completion_reports";
DROP POLICY IF EXISTS "Active operators view own drilling bars" ON "public"."drilling_bars";
DROP POLICY IF EXISTS "Admins can view all drilling bars" ON "public"."drilling_bars";
DROP POLICY IF EXISTS "Closing operators view project bars" ON "public"."drilling_bars";
DROP POLICY IF EXISTS "Project operators view project bars" ON "public"."drilling_bars";
DROP POLICY IF EXISTS "Read own team closing or admin drilling bars" ON "public"."drilling_bars";
DROP POLICY IF EXISTS "Active operators view own consumption" ON "public"."material_consumption";
DROP POLICY IF EXISTS "Admins can view all consumption" ON "public"."material_consumption";
DROP POLICY IF EXISTS "Closing operators view project consumption" ON "public"."material_consumption";
DROP POLICY IF EXISTS "Project operators view project consumption" ON "public"."material_consumption";
DROP POLICY IF EXISTS "Read own team closing or admin consumption" ON "public"."material_consumption";
DROP POLICY IF EXISTS "Admins can view all transactions" ON "public"."material_transactions";
DROP POLICY IF EXISTS "Operators can view own transactions" ON "public"."material_transactions";
DROP POLICY IF EXISTS "Read own or admin transactions" ON "public"."material_transactions";
DROP POLICY IF EXISTS "Admins read all pedido items" ON "public"."pedido_items";
DROP POLICY IF EXISTS "Operators read own or assigned empresa pedido items" ON "public"."pedido_items";
DROP POLICY IF EXISTS "Read assigned empresa or admin pedido items" ON "public"."pedido_items";
DROP POLICY IF EXISTS "Admins read all pedido receipts" ON "public"."pedido_receipts";
DROP POLICY IF EXISTS "Operators read own or assigned empresa pedido receipts" ON "public"."pedido_receipts";
DROP POLICY IF EXISTS "Read assigned empresa or admin pedido receipts" ON "public"."pedido_receipts";
DROP POLICY IF EXISTS "Active operators view own or assigned empresa pedidos" ON "public"."pedidos";
DROP POLICY IF EXISTS "Admins can view all pedidos" ON "public"."pedidos";
DROP POLICY IF EXISTS "Read own empresa or admin pedidos" ON "public"."pedidos";
DROP POLICY IF EXISTS "Active operators view own project photos" ON "public"."photos";
DROP POLICY IF EXISTS "Admins can view all photos" ON "public"."photos";
DROP POLICY IF EXISTS "Closing operators view project photo metadata" ON "public"."photos";
DROP POLICY IF EXISTS "Read team closing or admin photos" ON "public"."photos";
DROP POLICY IF EXISTS "Active users update own profile" ON "public"."profiles";
DROP POLICY IF EXISTS "Active users view own profile" ON "public"."profiles";
DROP POLICY IF EXISTS "Admins can update any profile" ON "public"."profiles";
DROP POLICY IF EXISTS "Admins can view all profiles" ON "public"."profiles";
DROP POLICY IF EXISTS "Read own or admin profiles" ON "public"."profiles";
DROP POLICY IF EXISTS "Update own or admin profiles" ON "public"."profiles";
DROP POLICY IF EXISTS "Users view own profile for activation check" ON "public"."profiles";
DROP POLICY IF EXISTS "Active operators view own reports" ON "public"."progress_reports";
DROP POLICY IF EXISTS "Admins can view all reports" ON "public"."progress_reports";
DROP POLICY IF EXISTS "Read own or admin reports" ON "public"."progress_reports";
DROP POLICY IF EXISTS "Active operators view assigned project materials" ON "public"."project_materials";
DROP POLICY IF EXISTS "Admins can view all project materials" ON "public"."project_materials";
DROP POLICY IF EXISTS "Closing operators view project materials" ON "public"."project_materials";
DROP POLICY IF EXISTS "Read assigned closing or admin project materials" ON "public"."project_materials";
DROP POLICY IF EXISTS "Active operators view assigned projects" ON "public"."projects";
DROP POLICY IF EXISTS "Admins can view all projects" ON "public"."projects";
DROP POLICY IF EXISTS "Read assigned or admin projects" ON "public"."projects";
DROP POLICY IF EXISTS "Admins read all handovers" ON "public"."shift_handovers";
DROP POLICY IF EXISTS "Operators read own handovers" ON "public"."shift_handovers";
DROP POLICY IF EXISTS "Read own or admin handovers" ON "public"."shift_handovers";
DROP POLICY IF EXISTS "Admins read all shifts" ON "public"."shifts";
DROP POLICY IF EXISTS "Closing operators view project shifts" ON "public"."shifts";
DROP POLICY IF EXISTS "Operators read own shifts" ON "public"."shifts";
DROP POLICY IF EXISTS "Read own closing or admin shifts" ON "public"."shifts";
DROP POLICY IF EXISTS "Admins read all water samples" ON "public"."water_samples";
DROP POLICY IF EXISTS "Operators read project water samples" ON "public"."water_samples";
DROP POLICY IF EXISTS "Read team closing or admin water samples" ON "public"."water_samples";

CREATE POLICY "Read assigned closing or admin project materials" ON "public"."project_materials" FOR SELECT USING ((("public"."is_active_user"() AND "public"."is_project_team_member"("project_id")) OR "public"."is_admin"() OR "public"."is_closing_operator"("project_id")));
CREATE POLICY "Read assigned empresa or admin pedido items" ON "public"."pedido_items" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("public"."is_active_user"() AND (EXISTS ( SELECT 1
   FROM "public"."pedidos" "p"
  WHERE (("p"."id" = "pedido_items"."pedido_id") AND (("p"."operator_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."is_project_operator"("p"."project_id") AND ("p"."kind" = 'empresa'::"text")))))))));
CREATE POLICY "Read assigned empresa or admin pedido receipts" ON "public"."pedido_receipts" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("public"."is_active_user"() AND (EXISTS ( SELECT 1
   FROM ("public"."pedido_items" "pi"
     JOIN "public"."pedidos" "p" ON (("p"."id" = "pi"."pedido_id")))
  WHERE (("pi"."id" = "pedido_receipts"."pedido_item_id") AND (("p"."operator_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."is_project_operator"("p"."project_id") AND ("p"."kind" = 'empresa'::"text")))))))));
CREATE POLICY "Read assigned or admin projects" ON "public"."projects" FOR SELECT USING ((("public"."is_active_user"() AND (("assigned_operator_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."is_project_secondary_operator"("id"))) OR "public"."is_admin"()));
CREATE POLICY "Read own closing or admin completion reports" ON "public"."completion_reports" FOR SELECT USING ((("public"."is_active_user"() AND ("operator_id" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_closing_operator"("project_id") OR "public"."is_admin"()));
CREATE POLICY "Read own closing or admin shifts" ON "public"."shifts" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR "public"."is_closing_operator"("project_id") OR ("public"."is_active_user"() AND ("operator_id" = ( SELECT "auth"."uid"() AS "uid")))));
CREATE POLICY "Read own empresa or admin pedidos" ON "public"."pedidos" FOR SELECT USING ((("public"."is_active_user"() AND (("operator_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."is_project_operator"("project_id") AND ("kind" = 'empresa'::"text")))) OR "public"."is_admin"()));
CREATE POLICY "Read own or admin handovers" ON "public"."shift_handovers" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("public"."is_active_user"() AND ("confirmed_by" = ( SELECT "auth"."uid"() AS "uid")))));
CREATE POLICY "Read own or admin profiles" ON "public"."profiles" FOR SELECT USING ((("public"."is_active_user"() AND ("id" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_admin"() OR ("id" = ( SELECT "auth"."uid"() AS "uid"))));
CREATE POLICY "Read own or admin reports" ON "public"."progress_reports" FOR SELECT USING ((("public"."is_active_user"() AND ("reported_by" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_admin"()));
CREATE POLICY "Read own or admin transactions" ON "public"."material_transactions" FOR SELECT USING (("public"."is_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "created_by")));
CREATE POLICY "Read own team closing or admin consumption" ON "public"."material_consumption" FOR SELECT USING ((("public"."is_active_user"() AND ("operator_id" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_closing_operator"("project_id") OR ("public"."is_active_user"() AND "public"."is_project_team_member"("project_id")) OR "public"."is_admin"()));
CREATE POLICY "Read own team closing or admin drilling bars" ON "public"."drilling_bars" FOR SELECT USING ((("public"."is_active_user"() AND ("operator_id" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_closing_operator"("project_id") OR ("public"."is_active_user"() AND "public"."is_project_team_member"("project_id")) OR "public"."is_admin"()));
CREATE POLICY "Read team closing or admin photos" ON "public"."photos" FOR SELECT USING ((("public"."is_active_user"() AND "public"."is_project_team_member"("project_id")) OR "public"."is_admin"() OR "public"."is_closing_operator"("project_id")));
CREATE POLICY "Read team closing or admin water samples" ON "public"."water_samples" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("public"."is_project_team_member"("project_id") OR "public"."is_closing_operator"("project_id"))));
CREATE POLICY "Signed-in users can report their own errors" ON "public"."client_errors" FOR INSERT TO "authenticated" WITH CHECK ((("profile_id" IS NULL) OR ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));
CREATE POLICY "Update own or admin profiles" ON "public"."profiles" FOR UPDATE USING ((("public"."is_active_user"() AND ("id" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_admin"())) WITH CHECK ((("public"."is_active_user"() AND ("id" = ( SELECT "auth"."uid"() AS "uid"))) OR "public"."is_admin"()));

-- 2. Indexes covering foreign keys.
CREATE INDEX IF NOT EXISTS "idx_audit_log_actor_id" ON "public"."audit_log" USING "btree" ("actor_id");
CREATE INDEX IF NOT EXISTS "idx_audit_log_project_id" ON "public"."audit_log" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_materials_created_by" ON "public"."catalog_materials" USING "btree" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_catalog_variants_created_by" ON "public"."catalog_variants" USING "btree" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_catalog_variants_material_id" ON "public"."catalog_variants" USING "btree" ("material_id");
CREATE INDEX IF NOT EXISTS "idx_client_errors_profile_id" ON "public"."client_errors" USING "btree" ("profile_id");
CREATE INDEX IF NOT EXISTS "idx_completion_discrepancies_completion_report_id" ON "public"."completion_discrepancies" USING "btree" ("completion_report_id");
CREATE INDEX IF NOT EXISTS "idx_completion_discrepancies_project_id" ON "public"."completion_discrepancies" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_completion_discrepancies_reported_by" ON "public"."completion_discrepancies" USING "btree" ("reported_by");
CREATE INDEX IF NOT EXISTS "idx_completion_discrepancies_resolved_by" ON "public"."completion_discrepancies" USING "btree" ("resolved_by");
CREATE INDEX IF NOT EXISTS "idx_completion_reports_operator_id" ON "public"."completion_reports" USING "btree" ("operator_id");
CREATE INDEX IF NOT EXISTS "idx_completion_reports_returned_by" ON "public"."completion_reports" USING "btree" ("returned_by");
CREATE INDEX IF NOT EXISTS "idx_completion_resubmission_attempts_actor_id" ON "private"."completion_resubmission_attempts" USING "btree" ("actor_id");
CREATE INDEX IF NOT EXISTS "idx_completion_resubmission_attempts_project_id" ON "private"."completion_resubmission_attempts" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_completion_resubmission_attempts_report_id" ON "private"."completion_resubmission_attempts" USING "btree" ("report_id");
CREATE INDEX IF NOT EXISTS "idx_completion_submission_attempts_actor_id" ON "private"."completion_submission_attempts" USING "btree" ("actor_id");
CREATE INDEX IF NOT EXISTS "idx_completion_submission_attempts_project_id" ON "private"."completion_submission_attempts" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_completion_submission_attempts_report_id" ON "private"."completion_submission_attempts" USING "btree" ("report_id");
CREATE INDEX IF NOT EXISTS "idx_material_consumption_material_id" ON "public"."material_consumption" USING "btree" ("material_id");
CREATE INDEX IF NOT EXISTS "idx_material_consumption_project_material_id" ON "public"."material_consumption" USING "btree" ("project_material_id");
CREATE INDEX IF NOT EXISTS "idx_material_import_lines_catalog_variant_id" ON "public"."material_import_lines" USING "btree" ("catalog_variant_id");
CREATE INDEX IF NOT EXISTS "idx_material_import_lines_import_id" ON "public"."material_import_lines" USING "btree" ("import_id");
CREATE INDEX IF NOT EXISTS "idx_material_import_lines_project_material_id" ON "public"."material_import_lines" USING "btree" ("project_material_id");
CREATE INDEX IF NOT EXISTS "idx_material_imports_imported_by" ON "public"."material_imports" USING "btree" ("imported_by");
CREATE INDEX IF NOT EXISTS "idx_material_imports_project_id" ON "public"."material_imports" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_material_reconciliations_created_by" ON "public"."material_reconciliations" USING "btree" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_material_transactions_created_by" ON "public"."material_transactions" USING "btree" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_notification_event_claims_claimed_by" ON "public"."notification_event_claims" USING "btree" ("claimed_by");
CREATE INDEX IF NOT EXISTS "idx_notifications_related_material" ON "public"."notifications" USING "btree" ("related_material");
CREATE INDEX IF NOT EXISTS "idx_notifications_related_project" ON "public"."notifications" USING "btree" ("related_project");
CREATE INDEX IF NOT EXISTS "idx_pedido_items_catalog_variant_id" ON "public"."pedido_items" USING "btree" ("catalog_variant_id");
CREATE INDEX IF NOT EXISTS "idx_pedido_items_decided_by" ON "public"."pedido_items" USING "btree" ("decided_by");
CREATE INDEX IF NOT EXISTS "idx_pedido_items_pedido_id" ON "public"."pedido_items" USING "btree" ("pedido_id");
CREATE INDEX IF NOT EXISTS "idx_pedido_receipts_confirmed_by" ON "public"."pedido_receipts" USING "btree" ("confirmed_by");
CREATE INDEX IF NOT EXISTS "idx_pedido_receipts_pedido_item_id" ON "public"."pedido_receipts" USING "btree" ("pedido_item_id");
CREATE INDEX IF NOT EXISTS "idx_pedidos_approved_by" ON "public"."pedidos" USING "btree" ("approved_by");
CREATE INDEX IF NOT EXISTS "idx_pedidos_closed_by" ON "public"."pedidos" USING "btree" ("closed_by");
CREATE INDEX IF NOT EXISTS "idx_pedidos_project_id" ON "public"."pedidos" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_photos_report_id" ON "public"."photos" USING "btree" ("report_id");
CREATE INDEX IF NOT EXISTS "idx_photos_uploaded_by" ON "public"."photos" USING "btree" ("uploaded_by");
CREATE INDEX IF NOT EXISTS "idx_progress_reports_reported_by" ON "public"."progress_reports" USING "btree" ("reported_by");
CREATE INDEX IF NOT EXISTS "idx_project_attachments_project_id" ON "public"."project_attachments" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_attachments_uploaded_by" ON "public"."project_attachments" USING "btree" ("uploaded_by");
CREATE INDEX IF NOT EXISTS "idx_project_attachments_water_sample_id" ON "public"."project_attachments" USING "btree" ("water_sample_id");
CREATE INDEX IF NOT EXISTS "idx_project_closing_assignments_assigned_by" ON "public"."project_closing_assignments" USING "btree" ("assigned_by");
CREATE INDEX IF NOT EXISTS "idx_project_closing_assignments_project_id" ON "public"."project_closing_assignments" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_materials_material_id" ON "public"."project_materials" USING "btree" ("material_id");
CREATE INDEX IF NOT EXISTS "idx_project_secondary_operators_assigned_by" ON "public"."project_secondary_operators" USING "btree" ("assigned_by");
CREATE INDEX IF NOT EXISTS "idx_project_secondary_operators_project_id" ON "public"."project_secondary_operators" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_projects_created_by" ON "public"."projects" USING "btree" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_record_corrections_corrected_by" ON "public"."record_corrections" USING "btree" ("corrected_by");
CREATE INDEX IF NOT EXISTS "idx_record_corrections_project_id" ON "public"."record_corrections" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_shift_handovers_confirmed_by" ON "public"."shift_handovers" USING "btree" ("confirmed_by");
CREATE INDEX IF NOT EXISTS "idx_shifts_operator_id" ON "public"."shifts" USING "btree" ("operator_id");
CREATE INDEX IF NOT EXISTS "idx_shifts_project_id" ON "public"."shifts" USING "btree" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_water_samples_operator_id" ON "public"."water_samples" USING "btree" ("operator_id");
CREATE INDEX IF NOT EXISTS "idx_water_samples_project_id" ON "public"."water_samples" USING "btree" ("project_id");

-- 3. Function definitions as they run on production.
CREATE OR REPLACE FUNCTION "backups"."restore_table"("p_snapshot_id" bigint, "p_truncate" boolean DEFAULT false) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  s        backups.snapshots;
  v_cols   text;
  v_oid    oid;
  v_loaded integer;
BEGIN
  SELECT * INTO s FROM backups.snapshots WHERE id = p_snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No snapshot with id %', p_snapshot_id USING ERRCODE = 'P0002';
  END IF;
  IF s.data IS NULL THEN
    RAISE EXCEPTION 'Snapshot % holds no data (table was skipped for size)', p_snapshot_id
      USING ERRCODE = '22023';
  END IF;

  v_oid := format('%I.%I', s.schema_name, s.table_name)::regclass;

  -- Generated columns excluded: Postgres rejects any non-DEFAULT value for
  -- them, which is what made the first off-site dump unrestorable.
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = v_oid AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

  IF p_truncate THEN
    EXECUTE format('TRUNCATE %I.%I CASCADE', s.schema_name, s.table_name);
  END IF;

  EXECUTE format(
    'INSERT INTO %I.%I (%s) SELECT %s FROM jsonb_populate_recordset(NULL::%I.%I, $1)',
    s.schema_name, s.table_name, v_cols, v_cols, s.schema_name, s.table_name
  ) USING s.data;

  GET DIAGNOSTICS v_loaded = ROW_COUNT;
  RETURN v_loaded;
END;
$_$;
CREATE OR REPLACE FUNCTION "backups"."take_snapshot"("p_label" "text" DEFAULT NULL::"text", "p_retain_days" integer DEFAULT 14, "p_exclude" "text"[] DEFAULT '{}'::"text"[], "p_max_rows_per_tbl" integer DEFAULT 50000) RETURNS TABLE("schema_name" "text", "table_name" "text", "row_count" integer, "skipped" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  r       record;
  v_json  jsonb;
  v_count integer;
  v_snap  timestamptz := now();
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND n.nspname IN ('public', 'private')
       AND (n.nspname || '.' || c.relname) <> ALL (p_exclude)
     ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.s, r.t) INTO v_count;

    IF v_count > p_max_rows_per_tbl THEN
      INSERT INTO backups.snapshots (taken_at, label, schema_name, table_name, row_count, data)
      VALUES (v_snap, p_label, r.s, r.t, v_count, NULL);
      -- ::text casts required, not cosmetic: nspname/relname are type `name`
      -- and RETURN QUERY against RETURNS TABLE(text,...) fails without them.
      RETURN QUERY SELECT r.s::text, r.t::text, v_count, true;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT coalesce(jsonb_agg(x), ''[]''::jsonb) FROM %I.%I x', r.s, r.t)
      INTO v_json;

    INSERT INTO backups.snapshots (taken_at, label, schema_name, table_name, row_count, data)
    VALUES (v_snap, p_label, r.s, r.t, v_count, v_json);

    RETURN QUERY SELECT r.s::text, r.t::text, v_count, false;
  END LOOP;

  IF p_retain_days IS NOT NULL THEN
    DELETE FROM backups.snapshots
     WHERE taken_at < v_snap - make_interval(days => p_retain_days);
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION "private"."confirm_pedido_item_receipt_20260712_impl"("p_item_id" bigint, "p_client_entry_id" "text", "p_outcome" "text", "p_quantity_received" real DEFAULT 0, "p_incident_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_item public.pedido_items;
  v_pedido public.pedidos;
  v_existing public.pedido_receipts;
  v_receipt public.pedido_receipts;
  v_variant public.catalog_variants;
  v_material public.catalog_materials;
  v_assignment public.project_materials;
  v_new_received real;
  v_new_state text;
  v_epsilon real;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('recibido', 'parcial', 'no_recibido') THEN
    RAISE EXCEPTION 'Resultado de recepción inválido' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(COALESCE(p_client_entry_id, ''))) = 0 THEN
    RAISE EXCEPTION 'client_entry_id requerido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_item FROM public.pedido_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pedido FROM public.pedidos WHERE id = v_item.pedido_id FOR UPDATE;
  IF v_pedido.operator_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND NOT (public.is_project_operator(v_pedido.project_id) AND v_pedido.kind = 'empresa') THEN
    RAISE EXCEPTION 'Only the requesting operator can confirm receipt'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_allows_closure_change(v_pedido.project_id) THEN
    RAISE EXCEPTION 'El proyecto no admite recepciones en su estado actual'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_existing
  FROM public.pedido_receipts
  WHERE client_entry_id = p_client_entry_id;
  IF FOUND THEN
    IF v_existing.pedido_item_id IS DISTINCT FROM p_item_id
       OR v_existing.outcome IS DISTINCT FROM p_outcome
       OR v_existing.quantity_received IS DISTINCT FROM COALESCE(p_quantity_received, 0) THEN
      RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('receipt', to_jsonb(v_existing), 'item', to_jsonb(v_item), 'idempotent_replay', true);
  END IF;

  IF v_item.state NOT IN ('aprobado', 'parcial') THEN
    RAISE EXCEPTION 'El ítem no espera recepción (estado: %)', v_item.state USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'no_recibido' THEN
    IF COALESCE(p_quantity_received, 0) <> 0 OR length(btrim(COALESCE(p_incident_note, ''))) < 3 THEN
      RAISE EXCEPTION 'No recibido requiere cantidad 0 y una explicación'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_quantity_received IS NULL OR p_quantity_received <= 0 THEN
      RAISE EXCEPTION 'Cantidad recibida debe ser positiva' USING ERRCODE = '22023';
    END IF;
    IF p_outcome = 'parcial' AND length(btrim(COALESCE(p_incident_note, ''))) < 3 THEN
      RAISE EXCEPTION 'Una entrega parcial requiere una nota' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_received := v_item.received_quantity + COALESCE(p_quantity_received, 0);
  v_epsilon := greatest(abs(COALESCE(v_item.approved_quantity, 0)) * 0.000001, 0.00001);
  IF v_new_received > COALESCE(v_item.approved_quantity, 0) + v_epsilon THEN
    RAISE EXCEPTION 'La recepción supera la cantidad aprobada' USING ERRCODE = '22023';
  END IF;
  IF abs(v_new_received - COALESCE(v_item.approved_quantity, 0)) <= v_epsilon THEN
    v_new_received := v_item.approved_quantity;
  END IF;
  IF p_outcome = 'recibido' AND v_new_received < v_item.approved_quantity - v_epsilon THEN
    RAISE EXCEPTION 'Usa parcial hasta completar exactamente la cantidad aprobada'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('phc.audit_reason', COALESCE(p_incident_note, 'Recepción de pedido'), true);

  INSERT INTO public.pedido_receipts (
    client_entry_id, pedido_item_id, outcome, quantity_received,
    incident_note, confirmed_by
  ) VALUES (
    p_client_entry_id, p_item_id, p_outcome, COALESCE(p_quantity_received, 0),
    NULLIF(btrim(COALESCE(p_incident_note, '')), ''), auth.uid()
  ) RETURNING * INTO v_receipt;

  IF v_pedido.kind = 'empresa' AND COALESCE(p_quantity_received, 0) > 0 THEN
    IF v_item.catalog_variant_id IS NOT NULL THEN
      SELECT * INTO v_variant FROM public.catalog_variants WHERE id = v_item.catalog_variant_id;
      SELECT * INTO v_material FROM public.catalog_materials WHERE id = v_variant.material_id;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'pedido-receipt-material:' || v_pedido.project_id::text || ':' || v_item.layer || ':' ||
        COALESCE(v_item.catalog_variant_id::text, public.normalize_catalog_name(v_item.material_name_snapshot)),
        0
      )
    );
    SELECT * INTO v_assignment
    FROM public.project_materials pm
    WHERE pm.project_id = v_pedido.project_id
      AND pm.layer = v_item.layer
      AND pm.active IS TRUE
      AND (
        (v_item.catalog_variant_id IS NOT NULL AND pm.catalog_variant_id = v_item.catalog_variant_id)
        OR (
          v_item.catalog_variant_id IS NULL
          AND public.normalize_catalog_name(pm.material_name) =
              public.normalize_catalog_name(v_item.material_name_snapshot)
        )
      )
    LIMIT 1 FOR UPDATE;

    IF FOUND THEN
      UPDATE public.project_materials
      SET initial_quantity = COALESCE(initial_quantity, 0) + p_quantity_received,
          quantity_allocated = COALESCE(quantity_allocated, initial_quantity, 0) + p_quantity_received,
          current_quantity = COALESCE(current_quantity, 0) + p_quantity_received,
          updated_at = now()
      WHERE id = v_assignment.id;
    ELSE
      INSERT INTO public.project_materials (
        project_id, catalog_variant_id, material_name, quantity_allocated,
        initial_quantity, current_quantity, unit, layer, assigned_date, notes, active
      ) VALUES (
        v_pedido.project_id, v_item.catalog_variant_id, v_item.material_name_snapshot,
        p_quantity_received, p_quantity_received, p_quantity_received,
        v_item.unit_snapshot, v_item.layer, now(),
        'Recepción pedido ' || COALESCE(v_pedido.pedido_number, v_pedido.id::text), true
      );
    END IF;
  END IF;

  v_new_state := CASE
    WHEN p_outcome = 'no_recibido' THEN 'no_recibido'
    WHEN v_new_received = v_item.approved_quantity THEN 'recibido'
    ELSE 'parcial'
  END;
  UPDATE public.pedido_items
  SET received_quantity = v_new_received,
      state = v_new_state,
      incident_note = CASE
        WHEN p_incident_note IS NULL THEN incident_note
        ELSE concat_ws(' · ', incident_note, btrim(p_incident_note))
      END,
      closed_at = CASE WHEN v_new_state IN ('recibido', 'no_recibido') THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_item_id
  RETURNING * INTO v_item;
  PERFORM private.recompute_pedido_status(v_item.pedido_id);

  PERFORM private.write_audit(
    v_pedido.project_id, 'pedido_item.received', 'pedido_items', v_item.id::text,
    NULL, to_jsonb(v_item), p_incident_note,
    jsonb_build_object('receipt_id', v_receipt.id, 'kind', v_pedido.kind)
  );
  RETURN jsonb_build_object('receipt', to_jsonb(v_receipt), 'item', to_jsonb(v_item), 'idempotent_replay', false);
END;
$$;
CREATE OR REPLACE FUNCTION "private"."reap_expired_shifts"("p_operator_id" "uuid" DEFAULT NULL::"uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.shifts
     SET status = 'report_pending',
         ended_at = started_at + interval '12 hours',
         end_type = 'auto',
         device_time_flag = true,
         updated_at = now()
   WHERE status = 'open'
     AND started_at <= now() - interval '12 hours'
     AND (p_operator_id IS NULL OR operator_id = p_operator_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION "backups"."restore_table"("p_snapshot_id" bigint, "p_truncate" boolean) IS 'Restores one row of backups.snapshots back into its source table. Excludes generated columns, which Postgres refuses to be given a value. Callers must SET session_replication_role = replica first: the immutability triggers that protect field data also block restoring it.';

-- 4. Predicate helpers callable by anon: empty results rather than 42501 errors.
GRANT ALL ON FUNCTION "public"."is_active_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_closing_operator"("p_project_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_project_operator"("p_project_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_project_secondary_operator"("p_project_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_project_team_member"("p_project_id" bigint) TO "anon";

COMMIT;
