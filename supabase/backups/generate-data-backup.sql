-- ===========================================================================
-- Generate a data-only backup of public + private as a runnable SQL script.
--
-- Paste this into the Supabase SQL editor (or any psql session) and copy the
-- single `dump` value out. It needs nothing but SQL access, so it works when
-- the CLI cannot authenticate — which is currently the case for this project
-- (401, no SUPABASE_DB_PASSWORD) and is why this file exists.
--
-- The free plan has no automated backups and no PITR, so until that changes
-- this is the backup. Run it before any migration push, and on a schedule once
-- an operator is entering real field data.
--
-- Schema is NOT included on purpose: it is versioned in this repo and
-- production's supabase_migrations.schema_migrations matches the repo
-- version-for-version. Restore path is: apply migrations, recreate auth.users,
-- then run the generated file.
--
-- Two things this deliberately does NOT capture:
--   * auth.users — carries password hashes. Handle separately, and think before
--     writing it to disk. profiles.id references auth.users(id), so a restore
--     needs those rows to exist first.
--   * anything outside public/private, including Storage OBJECTS. The
--     phc-photos bucket's files are not in Postgres and are not covered here.
-- ===========================================================================

DROP TABLE IF EXISTS _dump;
CREATE TEMP TABLE _dump(ord int, line text);

DO $$
DECLARE
  r    record;
  j    text;
  cols text;
  i    int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname IN ('public', 'private')
     ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT coalesce(json_agg(x)::text, ''[]'') FROM %I.%I x', r.s, r.t) INTO j;
    CONTINUE WHEN j = '[]';

    -- Explicit column list, EXCLUDING generated columns. Postgres rejects any
    -- non-DEFAULT value for a generated column, so `INSERT ... SELECT *` fails
    -- outright with:
    --   ERROR: cannot insert a non-DEFAULT value into column "normalized_name"
    -- On this schema that is catalog_materials.normalized_name,
    -- catalog_variants.normalized_name, material_reconciliations.missing_quantity
    -- and .overconsumed_quantity. Found by restoring the backup, not by reading
    -- it — which is the whole argument for restore-testing every dump.
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
      FROM pg_attribute
     WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

    i := i + 1;
    INSERT INTO _dump VALUES (i, format(
      '-- %s.%s' || chr(10) ||
      'INSERT INTO %I.%I (%s) SELECT %s FROM json_populate_recordset(NULL::%I.%I, %L);',
      r.s, r.t, r.s, r.t, cols, cols, r.s, r.t, j));
  END LOOP;
END $$;

-- Wrap in session_replication_role = replica so FK order does not matter on load.
SELECT 'SET session_replication_role = replica;' || E'\n\n'
       || string_agg(line, E'\n\n' ORDER BY ord)
       || E'\n\nSET session_replication_role = DEFAULT;' AS dump,
       count(*) AS tables_dumped
  FROM _dump;

-- ---------------------------------------------------------------------------
-- To restore: apply migrations, recreate auth.users, TRUNCATE the target
-- tables, then run the generated script.
--
-- To VERIFY a backup before trusting it, load it into a scratch database with
-- the same schema inside BEGIN ... ROLLBACK and compare row counts against
-- source. An untested dump is not a backup.
-- ---------------------------------------------------------------------------
