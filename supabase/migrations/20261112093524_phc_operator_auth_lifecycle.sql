-- Account availability is distinct from profile activation. Historical profiles
-- survive Auth soft deletion and must never be advertised as usable logins.
CREATE OR REPLACE FUNCTION public.operator_auth_status(p_operator_ids uuid[])
RETURNS TABLE(id uuid, auth_available boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo un administrador puede verificar los accesos' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT p.id, (u.id IS NOT NULL AND u.deleted_at IS NULL)
    FROM public.profiles p LEFT JOIN auth.users u ON u.id=p.id
    WHERE p.id=ANY(p_operator_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.operator_auth_status(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operator_auth_status(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_profile_auth_availability()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.is_active AND NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=NEW.id AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'El acceso de esta cuenta fue eliminado. Conservá su historial y creá un operador con un usuario nuevo.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_profile_auth_availability() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER profiles_require_live_auth BEFORE UPDATE OF is_active ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_auth_availability();
-- Retain all historical attribution; only correct false activation state.
UPDATE public.profiles p SET is_active=false
WHERE p.is_active AND NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=p.id AND u.deleted_at IS NULL);
