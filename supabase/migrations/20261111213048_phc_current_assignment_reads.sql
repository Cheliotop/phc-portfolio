-- Current assignment is the read boundary. Closing-only assignments and old
-- open shifts do not authorize browsing former wells. Recovery remains through
-- rejected_work_reports/admin review; Personal requests remain private to author.
CREATE OR REPLACE FUNCTION public.can_read_current_project(p_project_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 SELECT public.is_admin() OR (public.is_active_user() AND EXISTS (
 SELECT 1 FROM public.projects p WHERE p.id=p_project_id
 AND public.project_status_key(p.status) IN ('planning','active','closure_submitted')
 AND (p.assigned_operator_id=auth.uid() OR EXISTS (
 SELECT 1 FROM public.project_secondary_operators s WHERE s.project_id=p.id AND s.operator_id=auth.uid()))));
$$;
REVOKE ALL ON FUNCTION public.can_read_current_project(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_current_project(bigint) TO authenticated, service_role;

-- Open/report-pending shift ownership is not current crew membership. Existing
-- end_shift recovery remains own-shift guarded; new field submissions require crew.
CREATE OR REPLACE FUNCTION public.is_project_team_member(p_project_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 SELECT public.is_project_crew(p_project_id);
$$;
CREATE POLICY current_assignment_read_boundary ON public.projects AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(id));
CREATE POLICY current_assignment_read_boundary ON public.drilling_bars AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.material_consumption AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.project_materials AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.material_transactions AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.progress_reports AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.photos AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.water_samples AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.completion_reports AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.completion_discrepancies AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.project_closing_assignments AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.project_secondary_operators AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.shifts AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.shift_participants AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.shifts s WHERE s.id=shift_id AND public.can_read_current_project(s.project_id)));
CREATE POLICY current_assignment_read_boundary ON public.shift_handovers AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.shifts s WHERE s.id=shift_id AND public.can_read_current_project(s.project_id)));
CREATE POLICY current_assignment_read_boundary ON public.pedidos AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_admin() OR (public.is_active_user() AND kind='personal' AND operator_id=auth.uid()) OR public.can_read_current_project(project_id));
CREATE POLICY current_assignment_read_boundary ON public.pedido_items AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.pedidos p WHERE p.id=pedido_id));
CREATE POLICY current_assignment_read_boundary ON public.pedido_receipts AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.pedido_items i WHERE i.id=pedido_item_id));
CREATE POLICY current_assignment_read_boundary ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
 USING (bucket_id NOT IN ('phc-photos','phc-reports') OR public.can_read_current_project(public.storage_project_id(name)));

CREATE OR REPLACE FUNCTION public.get_closing_ficha_preview(p_project_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.can_read_current_project(p_project_id) THEN RAISE EXCEPTION 'Current assignment required' USING ERRCODE='42501'; END IF;
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
$function$

;

CREATE OR REPLACE FUNCTION public.get_operator_accountability_metrics(p_operator_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_operator_id uuid := COALESCE(p_operator_id, auth.uid());
  v_last_activity timestamptz;
  v_from timestamptz := CASE WHEN p_from IS NULL THEN '-infinity'::timestamptz
                             ELSE (p_from::timestamp AT TIME ZONE 'America/Asuncion') END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN 'infinity'::timestamptz
                           ELSE ((p_to + 1)::timestamp AT TIME ZONE 'America/Asuncion') END;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF v_operator_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied to operator metrics' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_to < p_from THEN
    RAISE EXCEPTION 'El período termina antes de empezar' USING ERRCODE = '22023';
  END IF;
  SELECT max(activity_at) INTO v_last_activity FROM (
    SELECT max(created_at) activity_at FROM (SELECT * FROM public.drilling_bars WHERE public.can_read_current_project(project_id)) WHERE operator_id = v_operator_id
    UNION ALL SELECT max(created_at) FROM (SELECT * FROM public.material_consumption WHERE public.can_read_current_project(project_id)) WHERE operator_id = v_operator_id
    UNION ALL SELECT max(created_at) FROM (SELECT * FROM public.pedidos WHERE public.can_read_current_project(project_id)) WHERE operator_id = v_operator_id
    UNION ALL SELECT max(s.updated_at) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
              JOIN public.shift_participants sp ON sp.shift_id = s.id
              WHERE sp.operator_id = v_operator_id
  ) a;

  RETURN jsonb_build_object(
    'operator_id', v_operator_id,
    'period_from', p_from,
    'period_to', p_to,
    'current_project', (SELECT to_jsonb(p) FROM (SELECT * FROM public.projects WHERE public.can_read_current_project(id)) p
                        WHERE (p.assigned_operator_id = v_operator_id
                               OR EXISTS (SELECT 1 FROM public.project_secondary_operators so
                                          WHERE so.project_id = p.id AND so.operator_id = v_operator_id))
                          AND public.project_status_key(p.status) IN ('planning', 'active', 'closure_submitted')
                        ORDER BY p.updated_at DESC LIMIT 1),
    'current_shift', (SELECT to_jsonb(s) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
                      JOIN public.shift_participants sp ON sp.shift_id = s.id
                      WHERE sp.operator_id = v_operator_id AND s.status IN ('open', 'report_pending')
                      ORDER BY s.started_at DESC LIMIT 1),
    'shifts_completed', (SELECT count(*) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
                         JOIN public.shift_participants sp ON sp.shift_id = s.id
                         WHERE sp.operator_id = v_operator_id AND s.status = 'closed'
                           AND s.started_at >= v_from AND s.started_at < v_to),
    'hours_worked', (
      SELECT COALESCE(round((sum(extract(epoch FROM (island.ended_at - island.started_at))) / 3600)::numeric, 2), 0)
      FROM (
        SELECT min(marked.started_at) AS started_at, max(marked.ended_at) AS ended_at
        FROM (
          SELECT ordered.started_at, ordered.ended_at,
                 sum(ordered.starts_island) OVER (ORDER BY ordered.started_at, ordered.ended_at) AS island_id
          FROM (
            SELECT s.started_at, pe.paid_end AS ended_at,
                   CASE WHEN s.started_at < max(pe.paid_end) OVER (
                          ORDER BY s.started_at, pe.paid_end
                          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                        THEN 0 ELSE 1 END AS starts_island
            FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
            JOIN public.shift_participants sp ON sp.shift_id = s.id
            CROSS JOIN LATERAL (SELECT private.shift_paid_end(s.id, s.started_at, s.ended_at, s.end_type) AS paid_end) pe
            WHERE sp.operator_id = v_operator_id AND s.ended_at IS NOT NULL
              AND s.started_at >= v_from AND s.started_at < v_to
          ) ordered
        ) marked
        GROUP BY marked.island_id
      ) island
    ),
    'flagged_shifts', (SELECT count(*) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
                       JOIN public.shift_participants sp ON sp.shift_id = s.id
                       WHERE sp.operator_id = v_operator_id AND s.device_time_flag IS TRUE
                         AND s.started_at >= v_from AND s.started_at < v_to),
    'abandoned_shifts', (SELECT count(*) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
                         JOIN public.shift_participants sp ON sp.shift_id = s.id
                         WHERE sp.operator_id = v_operator_id AND s.end_type = 'auto'
                           AND s.started_at >= v_from AND s.started_at < v_to),
    'bars_registered', (SELECT count(*) FROM (SELECT * FROM public.drilling_bars WHERE public.can_read_current_project(project_id)) b
                        WHERE b.operator_id = v_operator_id
                          AND b.created_at >= v_from AND b.created_at < v_to),
    'average_bar_minutes', (SELECT COALESCE(round(avg(b.duration_minutes)::numeric, 1), 0)
                            FROM (SELECT * FROM public.drilling_bars WHERE public.can_read_current_project(project_id)) b
                            WHERE b.operator_id = v_operator_id AND b.duration_minutes IS NOT NULL
                              AND b.created_at >= v_from AND b.created_at < v_to),
    'material_reports_submitted', (SELECT count(*) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
                                   JOIN public.shift_participants sp ON sp.shift_id = s.id
                                   WHERE sp.operator_id = v_operator_id AND s.usage_report_submitted IS TRUE
                                     AND s.started_at >= v_from AND s.started_at < v_to),
    'missing_or_late_reports', (SELECT count(*) FROM (SELECT * FROM public.shifts WHERE public.can_read_current_project(project_id)) s
                                JOIN public.shift_participants sp ON sp.shift_id = s.id
                                WHERE sp.operator_id = v_operator_id
                                  AND s.started_at >= v_from AND s.started_at < v_to
                                  AND (s.status = 'report_pending' OR s.end_type IN ('auto', 'admin')
                                       OR (s.status = 'open' AND s.started_at <= now() - interval '12 hours'))),
    'active_pedidos', (SELECT count(*) FROM (SELECT * FROM public.pedidos WHERE public.can_read_current_project(project_id)) p
                       WHERE p.operator_id = v_operator_id AND p.status NOT IN ('Cerrado', 'Rechazado')),
    'last_activity', v_last_activity,
    'account_active', (SELECT is_active FROM public.profiles WHERE id = v_operator_id)
  );
END;
$function$

;

CREATE OR REPLACE FUNCTION private.begin_acting(p_project_id bigint, p_entered_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claims jsonb;
BEGIN
  IF NOT public.can_read_current_project(p_project_id) THEN
    RAISE EXCEPTION 'No tenés acceso a este pozo. Avisale al administrador para recuperar el trabajo pendiente.' USING ERRCODE='42501';
  END IF;
  IF p_entered_by IS NULL OR p_entered_by = auth.uid() THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'active authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR NOT public.is_project_crew(p_project_id) THEN
    RAISE EXCEPTION 'No sos del equipo de este pozo' USING ERRCODE = '42501';
  END IF;
  IF NOT private.is_project_team_member_for(p_entered_by, p_project_id) THEN
    RAISE EXCEPTION 'Ese operador no es del equipo de este pozo' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('phc.caller', auth.uid()::text, true);
  PERFORM set_config('phc.saved_claims', COALESCE(current_setting('request.jwt.claims', true), ''), true);
  PERFORM set_config('phc.saved_claim_sub', COALESCE(current_setting('request.jwt.claim.sub', true), ''), true);
  v_claims := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  PERFORM set_config('request.jwt.claims',
    jsonb_set(v_claims, '{sub}', to_jsonb(p_entered_by::text))::text, true);
  IF COALESCE(current_setting('request.jwt.claim.sub', true), '') <> '' THEN
    PERFORM set_config('request.jwt.claim.sub', p_entered_by::text, true);
  END IF;
END;
$function$

;
