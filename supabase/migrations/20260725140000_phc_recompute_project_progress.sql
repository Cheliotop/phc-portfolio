-- =====================================================================
-- Migration: phc_recompute_project_progress  (version 20260725140000)
--
-- Fixes W-6 from the 2026-07-25 audit: projects.progress_percentage was
-- written once and never recomputed. Verified before this migration:
--
--   SELECT proname FROM pg_proc
--   WHERE pg_get_functiondef(oid) LIKE '%progress_percentage%';
--   -> no rows. Nothing anywhere maintained the column.
--
-- create_drilling_bar never referenced it and no trigger on drilling_bars
-- touched projects, so drilling 100 metres did not move the number. The
-- admin's headline progress figure was not derived from drilling data.
--
-- This adds the missing maintenance path: recompute from the deepest
-- recorded bar whenever drilling_bars changes for a project.
--
-- Deliberately skips projects whose status resolves to 'completed'.
-- protect_completed_project raises 55000 on any change to a completed
-- project other than updated_at, and a finished well's progress is final
-- anyway -- so touching it would both fail and be wrong.
-- =====================================================================

CREATE OR REPLACE FUNCTION private.recompute_project_progress(p_project_id bigint)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
DECLARE
  v_target   real;
  v_depth    real;
  v_pct      integer;
  v_status   text;
BEGIN
  SELECT p.target_depth, public.project_status_key(p.status)
    INTO v_target, v_status
    FROM public.projects p
   WHERE p.id = p_project_id;

  IF NOT FOUND OR v_status = 'completed' THEN
    RETURN;
  END IF;

  SELECT COALESCE(max(db.depth_end), 0) INTO v_depth
    FROM public.drilling_bars db
   WHERE db.project_id = p_project_id;

  -- No target depth means no meaningful percentage; leave the column alone
  -- rather than writing a misleading 0 or dividing by zero.
  IF v_target IS NULL OR v_target <= 0 THEN
    RETURN;
  END IF;

  v_pct := LEAST(100, GREATEST(0, round((v_depth / v_target) * 100)::integer));

  -- Only write on an actual change, so we do not churn updated_at (and the
  -- audit trail) on every bar insert that leaves the rounded value the same.
  UPDATE public.projects
     SET progress_percentage = v_pct
   WHERE id = p_project_id
     AND progress_percentage IS DISTINCT FROM v_pct;
END;
$function$;

CREATE OR REPLACE FUNCTION private.drilling_bars_refresh_progress()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM private.recompute_project_progress(OLD.project_id);
    RETURN OLD;
  END IF;

  PERFORM private.recompute_project_progress(NEW.project_id);
  -- A bar moved between projects: refresh the one it left as well.
  IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    PERFORM private.recompute_project_progress(OLD.project_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS refresh_project_progress_on_drilling_bars ON public.drilling_bars;
CREATE TRIGGER refresh_project_progress_on_drilling_bars
  AFTER INSERT OR UPDATE OR DELETE ON public.drilling_bars
  FOR EACH ROW EXECUTE FUNCTION private.drilling_bars_refresh_progress();

-- Backfill everything the column had drifted on, completed projects excluded
-- for the immutability reason above.
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.projects
     WHERE public.project_status_key(status) <> 'completed'
  LOOP
    PERFORM private.recompute_project_progress(r.id);
  END LOOP;
END;
$backfill$;
