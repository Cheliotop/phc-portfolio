-- ============================================================================
-- Restore the auth.users -> handle_new_user trigger.
--
-- Production has `on_auth_user_created` on auth.users, but NO migration and
-- no 01_schema.sql statement ever created it — only the handle_new_user()
-- function itself is defined (20260708225908, later hardened by
-- 20260709050323). The trigger was created out-of-band and therefore never
-- existed on a rebuilt database.
--
-- Impact of the gap: on a from-scratch rebuild, inserting into auth.users
-- created NO public.profiles row. Every newly created operator would exist
-- as an auth identity with no profile, hence no role, no username, and no
-- RLS-visible presence anywhere in the app. This was caught when seeding a
-- fresh local stack produced 11 auth users and 0 profiles.
--
-- This migration runs last so handle_new_user() is guaranteed to exist.
-- Idempotent: safe to re-run, and a no-op against production where the
-- trigger already exists.
-- ============================================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
