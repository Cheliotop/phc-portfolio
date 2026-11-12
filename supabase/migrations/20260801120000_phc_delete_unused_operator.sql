-- Delete an operator who never did anything.
--
-- Operadores had Desactivar and Establecer clave but no way to remove a row.
-- An operator created by mistake, or a duplicate, stayed in the list forever
-- and the list only grows. Desactivar is the right answer for someone who left
-- — their work must stay attributed — but it is the wrong answer for a typo,
-- and it does not free the username so the correct account can be created.
--
-- WHY THIS IS NOT A PLAIN DELETE
-- `audit_log.actor_id` is ON DELETE SET NULL. Deleting a profile therefore does
-- not fail on the audit trail: it silently anonymises every entry that operator
-- ever produced, in an append-only log whose entire value is that it says who
-- did what. Several workflow columns (closed_by, decided_by, resolved_by,
-- returned_by) behave the same way. So the guard cannot be left to foreign
-- keys — the dangerous cases are exactly the ones the keys allow.
--
-- The rule is therefore: an operator with ANY history is never deleted. The
-- checks below are explicit for the tables where losing attribution would be
-- silent, and the remaining RESTRICT constraints act as a backstop for tables
-- nobody thought of, aborting the whole transaction rather than half-deleting.

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

  -- profiles.id REFERENCES auth.users(id) ON DELETE CASCADE, so removing the
  -- auth user removes the profile and frees the username. Any RESTRICT foreign
  -- key left anywhere aborts this whole statement, which is the desired
  -- outcome: nothing is deleted at all rather than partially.
  BEGIN
    DELETE FROM auth.users WHERE id = p_operator_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'Ese operador tiene registros asociados y no puede eliminarse. Usá Desactivar.'
      USING ERRCODE = '23503';
  END;

  RETURN jsonb_build_object('deleted', true, 'username', v_username);
END;
$function$;

COMMENT ON FUNCTION public.delete_unused_operator(uuid) IS
  'Removes an operator that has no history whatsoever, freeing the username. '
  'Refuses for anyone who has worked — their attribution is evidence. '
  'Deactivation, not deletion, is the answer for an operator who left.';

REVOKE ALL ON FUNCTION public.delete_unused_operator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_unused_operator(uuid) TO authenticated;
