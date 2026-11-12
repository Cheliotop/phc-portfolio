-- =====================================================================
-- Migration: phc_in_database_snapshots  (version 20260726020000)
--
-- Free-tier safety net. This organisation is on the Supabase FREE plan: no
-- automated backups, no PITR. Until that changes, a bad migration or a
-- mistaken UPDATE against production is unrecoverable.
--
-- This is the cheap half of the answer. It catches the LIKELY failure — a bad
-- migration, a wrong UPDATE, an accidental delete — because a snapshot taken
-- before the damage is still sitting in the same database. It does NOT catch
-- the catastrophic one: if the project is deleted or corrupted, these go with
-- it. That is what the off-site GitHub Actions dump is for
-- (.github/workflows/prod-data-backup.yml). The two are complements, not
-- alternatives.
--
-- The project already does this by hand — private.pre_v2_snapshot and
-- private.pre_reset_snapshot_20260712 are exactly this pattern, created
-- manually during earlier migrations. This makes it automatic and prunable.
--
-- DESIGN: one generic jsonb table rather than a shadow copy of every table.
-- A per-table shadow schema has to be migrated in lockstep with the real one
-- forever, and silently loses columns when it is not. jsonb captures whatever
-- the table looks like on the day, and restores through
-- json_populate_recordset — the same mechanism the data dump in
-- supabase/backups/ uses and which has been restore-tested.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS backups;

COMMENT ON SCHEMA backups IS
  'Point-in-time-ish snapshots of public/private table contents. Not exposed '
  'via PostgREST (only public and graphql_public are). See '
  'backups.take_snapshot().';

CREATE TABLE IF NOT EXISTS backups.snapshots (
  id          bigserial   PRIMARY KEY,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  label       text,
  schema_name text        NOT NULL,
  table_name  text        NOT NULL,
  row_count   integer     NOT NULL,
  -- NULL means the table was skipped for exceeding the row cap, NOT that it was
  -- empty. An empty table is captured as '[]' with row_count 0, so a
  -- delete-everything mistake is visible as a real transition in the timeline
  -- rather than looking like the table was never snapshotted.
  data        jsonb
);

CREATE INDEX IF NOT EXISTS snapshots_taken_at_idx
  ON backups.snapshots (taken_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_table_taken_at_idx
  ON backups.snapshots (schema_name, table_name, taken_at DESC);

-- ---------------------------------------------------------------------
-- backups.take_snapshot()
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backups.take_snapshot(
  p_label            text     DEFAULT NULL,
  p_retain_days      integer  DEFAULT 14,
  p_exclude          text[]   DEFAULT '{}',      -- 'schema.table' entries
  p_max_rows_per_tbl integer  DEFAULT 50000
)
RETURNS TABLE (schema_name text, table_name text, row_count integer, skipped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
       AND n.nspname IN ('public', 'private')   -- never 'backups': self-snapshot
       AND (n.nspname || '.' || c.relname) <> ALL (p_exclude)
     ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.s, r.t) INTO v_count;

    IF v_count > p_max_rows_per_tbl THEN
      -- Recorded with NULL data rather than silently ballooning the database.
      -- audit_log is the table to watch: it only grows, and at free-tier's
      -- 500 MB it is what will eventually force a retention or exclusion
      -- decision. Better a visible skip than a full disk.
      INSERT INTO backups.snapshots (taken_at, label, schema_name, table_name, row_count, data)
      VALUES (v_snap, p_label, r.s, r.t, v_count, NULL);
      -- ::text casts are required, not cosmetic: pg_namespace.nspname and
      -- pg_class.relname are type `name`, and RETURN QUERY against a RETURNS
      -- TABLE(text,...) fails outright without them.
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

COMMENT ON FUNCTION backups.take_snapshot(text, integer, text[], integer) IS
  'Snapshots every public/private table into backups.snapshots as jsonb and '
  'prunes anything older than p_retain_days. Free-plan substitute for daily '
  'backups. Restore with backups.restore_table().';

-- ---------------------------------------------------------------------
-- backups.restore_table()
--
-- A snapshot nobody can restore is not a backup, so the restore path ships
-- with it instead of being left as an exercise.
--
-- Generated columns are excluded from the INSERT: Postgres rejects any
-- non-DEFAULT value for them, which is what made the first attempt at the
-- off-site dump unrestorable (catalog_materials.normalized_name and three
-- others). Same trap, same fix, one place.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backups.restore_table(
  p_snapshot_id bigint,
  p_truncate    boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
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
$$;

COMMENT ON FUNCTION backups.restore_table(bigint, boolean) IS
  'Restores one row of backups.snapshots back into its source table. Excludes '
  'generated columns, which Postgres refuses to be given a value. Callers must '
  'SET session_replication_role = replica first — see the note in the migration.';

-- HOW TO ACTUALLY RESTORE, because the obvious way does not work:
--
--   BEGIN;
--   SET session_replication_role = replica;   -- REQUIRED
--   SELECT backups.restore_table(<id>, p_truncate => true);
--   -- verify, then COMMIT (or ROLLBACK to abort)
--   COMMIT;
--
-- Without `session_replication_role = replica` the restore fails on the
-- operational tables:
--
--   ERROR: drilling_bars records are immutable; create an audited correction instead
--   CONTEXT: private.protect_operational_history()
--
-- The immutability triggers that protect field data from being edited also
-- block it from being restored, and they are doing their job — the bypass has
-- to be deliberate. It also defers FK checks, so restore order stops mattering.
--
-- Verified on the local stack against the real schema: deleted all 497
-- drilling_bars rows, restored from the snapshot, got 497 back and confirmed
-- every row byte-identical via to_jsonb() comparison, inside a transaction that
-- was then rolled back.

-- ---------------------------------------------------------------------
-- Lock it down. `backups` is not in PostgREST''s exposed schemas, but say so
-- explicitly rather than depending on that config staying put — and note that
-- REVOKE must hit both PUBLIC and anon: a local stack grants EXECUTE via
-- PUBLIC while a hosted Supabase project grants it to anon directly, so either
-- revoke alone reports success and changes nothing on the other. (Learned the
-- hard way in 20260726010000.)
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA backups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA backups FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION backups.take_snapshot(text, integer, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION backups.restore_table(bigint, boolean)                FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA backups TO postgres, service_role;
GRANT EXECUTE ON FUNCTION backups.take_snapshot(text, integer, text[], integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION backups.restore_table(bigint, boolean)                TO postgres, service_role;

-- ---------------------------------------------------------------------
-- Schedule it daily at 03:00 UTC (around midnight in Paraguay, so it lands
-- between shifts rather than mid-drilling). Guarded the same way the shift
-- reaper is, so an environment without pg_cron still gets the functions and
-- loses only the schedule, loudly.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('phc-daily-snapshot')
     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'phc-daily-snapshot');

    PERFORM cron.schedule(
      'phc-daily-snapshot',
      '0 3 * * *',
      $job$SELECT backups.take_snapshot('daily')$job$
    );
  ELSE
    RAISE WARNING
      'pg_cron not installed: backups.take_snapshot() exists but is NOT scheduled. '
      'Nothing will snapshot automatically until it is.';
  END IF;
END;
$$;
