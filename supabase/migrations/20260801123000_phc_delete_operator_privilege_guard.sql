-- Make a privilege failure in delete_unused_operator legible.
--
-- The function removes the auth user so the cascade takes the profile with it
-- and frees the username. Whether a SECURITY DEFINER function may delete from
-- `auth.users` depends on what the owning role has been granted, and that could
-- not be executed from the environment this was written in. Unverified is not
-- the same as broken, but it must not surface to an administrator as a raw
-- Postgres privilege error on a button labelled Eliminar.
--
-- A separate migration rather than an edit to 20260801120000, which is already
-- applied: changing an applied file leaves the repository disagreeing with the
-- database, and `db push` will not re-run it.

CREATE OR REPLACE FUNCTION public.delete_unused_operator(p_operator_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
DECLARE
  v_username text;
  v_role     text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo un administrador puede eliminar operadores'
      USING ERRCODE = '42501';
  END IF;

  IF p_operator_id = (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'No podés eliminar tu propia cuenta'
      USING ERRCODE = '22023';
  END IF;

  SELECT username, role INTO v_username, v_role
    FROM public.profiles WHERE id = p_operator_id;

  IF v_username IS NULL THEN
    RAISE EXCEPTION 'Ese operador ya no existe'
      USING ERRCODE = '22023';
  END IF;

  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'No se puede eliminar una cuenta de administrador desde acá'
      USING ERRCODE = '22023';
  END IF;

  -- The append-only record. Checked first because this is the one the foreign
  -- keys would let through, by quietly nulling the actor.
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE actor_id = p_operator_id) THEN
    RAISE EXCEPTION 'Ese operador ya tiene historial registrado. Usá Desactivar: su trabajo tiene que seguir siendo suyo.'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE operator_id = p_operator_id) THEN
    RAISE EXCEPTION 'Ese operador tiene turnos registrados. Usá Desactivar.'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (SELECT 1 FROM public.projects WHERE assigned_operator_id = p_operator_id) THEN
    RAISE EXCEPTION 'Ese operador es el responsable de un pozo. Asigná otro responsable antes de eliminarlo.'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.project_secondary_operators WHERE operator_id = p_operator_id
  ) THEN
    RAISE EXCEPTION 'Ese operador está asignado como subcontratista en un pozo. Quitalo de ese pozo antes de eliminarlo.'
      USING ERRCODE = '23503';
  END IF;

  BEGIN
    DELETE FROM auth.users WHERE id = p_operator_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'Ese operador tiene registros asociados y no puede eliminarse. Usá Desactivar.'
        USING ERRCODE = '23503';
    WHEN insufficient_privilege THEN
      -- Nothing was deleted; the transaction rolls back to a clean state.
      RAISE EXCEPTION 'El servidor no permite eliminar cuentas desde la app. Usá Desactivar y avisá al administrador del sistema.'
        USING ERRCODE = '42501';
  END;

  RETURN jsonb_build_object('deleted', true, 'username', v_username);
END;
$function$;
