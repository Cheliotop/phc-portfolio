-- Code read S8: refused work that reaches the server later.
--
-- A phone reports refused work to the admin review list straight away. If the
-- operator then taps "Reintentar" and the same work gets through, the review
-- entry stayed pending, and for every kind except bars and water samples the
-- admin enters it by hand, so it could be entered twice.
--
-- The phone now says so. This only records that the reporting phone saw the
-- work reach the server; it never decides the entry. The admin's list shows a
-- note and the admin still accepts or rejects it, so a wrong claim cannot hide
-- refused work or change any record.

ALTER TABLE public.rejected_work_reports
  ADD COLUMN sent_later_at timestamptz;

CREATE FUNCTION public.mark_rejected_work_sent(p_client_entry_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.rejected_work_reports
  SET sent_later_at = COALESCE(sent_later_at, now())
  WHERE client_entry_id = p_client_entry_id
    AND reported_by = v_uid
    AND status = 'pending';

  -- True when the entry is known, whatever its state, so the phone stops
  -- retrying; an entry the admin already decided needs nothing more.
  RETURN EXISTS (
    SELECT 1 FROM public.rejected_work_reports
    WHERE client_entry_id = p_client_entry_id AND reported_by = v_uid
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_rejected_work_sent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_rejected_work_sent(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_rejected_work_sent(text) TO authenticated, service_role;
