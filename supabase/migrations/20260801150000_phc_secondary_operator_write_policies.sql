-- Let a subcontractor's field work actually reach the database.
--
-- Found on a real handset on 2026-08-01. Luis, a subcontractor, registered a
-- drilling bar with no signal. It saved locally and told him so. On reconnect:
--
--     drilling_bar   UPSERT   0 retries
--     new row violates row-level security policy
--
-- Zero retries is correct — an RLS denial is permanent, so the outbox
-- quarantined it immediately and told him to call the office. The queue did
-- exactly its job. The write should never have been refused.
--
-- WHY IT WAS REFUSED
-- 20260725160000 introduced subcontractors and widened six policies. Five of
-- them are reads. Only ONE write was widened — the photos upload. drilling_bars,
-- material_consumption, project_materials and water_samples got their SELECT
-- widened and their write policies left on is_project_operator(), which means
-- the responsible operator alone.
--
-- Online this is invisible. Field writes go through SECURITY DEFINER RPCs, and
-- those WERE widened on 07-25. The offline queue replays through the same RPCs,
-- but the INSERT they perform is still checked against the table's own policy —
-- so the subcontractor could drill all day with signal and lose everything they
-- recorded without it. On a drilling site, without signal is the normal case.
--
-- WHY THIS ONE IS SELF-DISCOVERING
-- The 07-25 migration listed policies by name and missed the writes. Naming
-- them again would risk missing them again, and policy names have already
-- changed twice in this project's history. This finds every policy on the
-- permitted tables that still asks for the primary operator and swaps it,
-- whatever it happens to be called.

DO $widen_writes$
DECLARE
  r        record;
  v_qual   text;
  v_check  text;
  v_sql    text;
  v_count  integer := 0;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, qual, with_check, roles
      FROM pg_policies
     WHERE schemaname = 'public'
       -- Exactly the tables 20260725160000 documents a subcontractor may write:
       -- their own shifts, bars, consumption, samples, photos and handovers.
       -- pedidos, pedido receipts and completion reports are deliberately NOT
       -- here: orders must come from one place, and closing the well stays with
       -- the responsible and closing operators.
       AND tablename IN (
         'drilling_bars',
         'material_consumption',
         'water_samples',
         'shifts',
         'shift_handovers',
         'photos'
       )
       AND cmd IN ('INSERT', 'UPDATE', 'ALL')
       AND (
         COALESCE(qual, '')       LIKE '%is_project_operator(%'
         OR COALESCE(with_check, '') LIKE '%is_project_operator(%'
       )
  LOOP
    v_qual  := replace(COALESCE(r.qual, ''),       'is_project_operator(', 'is_project_team_member(');
    v_check := replace(COALESCE(r.with_check, ''), 'is_project_operator(', 'is_project_team_member(');

    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);

    v_sql := format('CREATE POLICY %I ON public.%I FOR %s TO %s',
                    r.policyname, r.tablename, r.cmd,
                    array_to_string(r.roles, ', '));
    IF v_qual <> '' THEN
      v_sql := v_sql || format(' USING (%s)', v_qual);
    END IF;
    IF v_check <> '' THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', v_check);
    END IF;
    EXECUTE v_sql;

    v_count := v_count + 1;
    RAISE NOTICE 'Widened write policy %.% (%)', r.tablename, r.policyname, r.cmd;
  END LOOP;

  -- Zero is a real answer worth seeing in the push output: it would mean the
  -- refusal came from somewhere other than these tables' policies, and the
  -- investigation should not stop here.
  RAISE NOTICE 'Widened % write polic(ies) for subcontractors', v_count;
END;
$widen_writes$;
