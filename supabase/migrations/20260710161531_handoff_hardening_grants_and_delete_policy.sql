-- Recovered from remote supabase_migrations.schema_migrations on 2026-07-11:
-- applied directly to the live project on 2026-07-10, never committed as a
-- file. Recorded verbatim so local history matches the remote. Do NOT edit or
-- re-apply.

-- 1) The 2026-07-10 material-redesign migration recreated these two functions,
-- which reset their grants to Postgres defaults (EXECUTE for PUBLIC/anon).
-- Both check is_admin() internally so this was not exploitable, but every
-- other RPC in this project has anon revoked — restore that convention.
REVOKE EXECUTE ON FUNCTION public.approve_pedido(bigint, real, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assign_material_to_project(bigint, text, real, text, text) FROM PUBLIC, anon;

-- 2) project_materials had admin policies for INSERT/SELECT/UPDATE but none
-- for DELETE, so a client-side delete silently affected zero rows. The web
-- admin now offers "remove wrongly-assigned material", which needs this.
CREATE POLICY "Only admins can delete project materials"
  ON public.project_materials
  FOR DELETE
  USING (is_admin());
