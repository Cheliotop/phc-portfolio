-- Client crash reporting.
--
-- The app had no error reporting of any kind. On 2026-07-31 a String.replaceAll
-- call took the entire Operación tab down to the error boundary on every real
-- device; it passed TypeScript, passed 272 tests, produced a correctly signed
-- release, and was found only because a person happened to open that tab. After
-- handoff there is no such person.
--
-- Deliberately a table here rather than Sentry or similar. It needs no
-- third-party account and no bill for the client, adds no native module days
-- before delivery, and inherits the offline queueing this app already proves for
-- field data. Administration reads it in the Supabase dashboard or through the
-- panel; nothing else has to exist for it to be useful.
--
-- Append-only, like the rest of the evidence in this system: no UPDATE or DELETE
-- policy is granted, so a report cannot be quietly rewritten or removed.

CREATE TABLE IF NOT EXISTS public.client_errors (
  id bigserial PRIMARY KEY,

  -- Generated on the device before the report is queued, so a retry after a
  -- failed send cannot create a second row for the same crash.
  client_entry_id text NOT NULL UNIQUE,

  occurred_at timestamptz NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),

  -- Nullable: a crash on the login screen has no session to attribute.
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role text,

  app_version text NOT NULL,
  build_number text,
  platform text,
  os_version text,

  -- Where it happened, as far as the client can tell: the first named component
  -- in the React stack.
  screen text,

  message text NOT NULL,
  stack text,
  component_stack text,

  -- False for a handled error that the app recovered from; true when the error
  -- boundary replaced the screen.
  is_fatal boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE public.client_errors IS
  'Crash and error reports from the mobile client. Append-only. Never place '
  'credentials, tokens or field evidence in here — it is diagnostic only.';

-- Administration reads these newest-first, and usually filtered to one release.
CREATE INDEX IF NOT EXISTS client_errors_occurred_at_idx
  ON public.client_errors (occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_app_version_idx
  ON public.client_errors (app_version, occurred_at DESC);

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Any signed-in user may report a crash, including an operator, because the
-- whole point is that a failure in the field reaches administration without a
-- telephone call. Insert only.
--
-- Not granted to `anon`: the publishable key ships inside the APK, so an
-- anonymous insert policy would let anyone holding it write unbounded rows.
-- Crashes that happen before sign-in stay in the device log.
DROP POLICY IF EXISTS "Signed-in users can report their own errors" ON public.client_errors;
CREATE POLICY "Signed-in users can report their own errors"
  ON public.client_errors
  FOR INSERT
  TO authenticated
  WITH CHECK (profile_id IS NULL OR profile_id = auth.uid());

DROP POLICY IF EXISTS "Admins can read error reports" ON public.client_errors;
CREATE POLICY "Admins can read error reports"
  ON public.client_errors
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- No UPDATE and no DELETE policy on purpose. Reports are evidence of what the
-- software did, and the value of that evidence depends on nobody being able to
-- tidy it up.
