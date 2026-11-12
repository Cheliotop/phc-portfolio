-- =====================================================================
-- Migration: phc_revoke_anon_on_membership_helpers  (version 20260726010000)
--
-- Closes a gap introduced by 20260725160000_phc_secondary_operators.
--
-- 20260708225948_phc_rpc_revoke_anon_execute revoked EXECUTE from `anon` on
-- every function that existed at the time. The two membership helpers added by
-- the subcontractor migration were created afterwards and so never received
-- that treatment, leaving them inconsistent with every sibling:
--
--   is_active_user                 anon=false
--   is_closing_operator            anon=false
--   is_project_operator            anon=false
--   is_project_secondary_operator  anon=TRUE   <- added 20260725160000
--   is_project_team_member         anon=TRUE   <- added 20260725160000
--
-- Found by Supabase's security advisor immediately after the production push
-- (lint anon_security_definer_function_executable), which flagged exactly
-- these two and nothing else new.
--
-- The practical exposure was low: both are SECURITY DEFINER but resolve
-- through is_active_user()/auth.uid(), which is NULL for anon, so an anonymous
-- caller could only ever get false back. This is about not leaving a
-- SECURITY DEFINER function reachable by an unauthenticated role when every
-- comparable function in the schema is not — the posture, not a live hole.
-- =====================================================================

-- BOTH revokes are required, because anon reaches EXECUTE by a DIFFERENT route
-- on a local stack than on a hosted project. Verified on each, the hard way:
--
--   local  {=X,postgres=X,authenticated=X,service_role=X}
--          the leading `=X` is PUBLIC — Postgres' default grant on any new
--          function. REVOKE ... FROM anon does nothing here.
--
--   hosted {postgres=X,anon=X,authenticated=X,service_role=X}
--          Supabase configures ALTER DEFAULT PRIVILEGES for the public schema,
--          so new functions get an EXPLICIT anon grant and there is no PUBLIC
--          entry to revoke. REVOKE ... FROM PUBLIC does nothing here.
--
-- Revoking only one of them looks like it succeeded — the statement reports
-- REVOKE either way — while anon keeps the privilege. Hence both, plus the
-- explicit re-grants so the end state is identical to is_project_operator's:
--   {postgres=X,service_role=X,authenticated=X}
REVOKE EXECUTE ON FUNCTION public.is_project_team_member(bigint)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_project_secondary_operator(bigint) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.is_project_team_member(bigint)        FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_project_secondary_operator(bigint) FROM anon;

GRANT EXECUTE ON FUNCTION public.is_project_team_member(bigint)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_project_secondary_operator(bigint) TO authenticated, service_role;
