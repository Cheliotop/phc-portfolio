-- Rollback-only local regression. Real authenticated roles; no service bypass
-- is used to assert RPC access. Existing local QA identities are test fixtures.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE username='qa_admin') THEN RAISE EXCEPTION 'Local QA fixtures required'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',(SELECT id::text FROM public.profiles WHERE username='qa_admin'),true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE v uuid; BEGIN
 SELECT id INTO v FROM public.profiles WHERE username LIKE 'orphan_%' LIMIT 1;
 IF v IS NULL THEN RAISE EXCEPTION 'Run local browser orphan fixture first'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.operator_auth_status(ARRAY[v]) WHERE id=v AND NOT auth_available) THEN RAISE EXCEPTION 'Deleted identity advertised available'; END IF;
 RAISE NOTICE 'PASS admin sees deleted Auth status';
 BEGIN
  UPDATE public.profiles SET is_active=true WHERE id=v;
  RAISE EXCEPTION 'Deleted profile reactivation accepted';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS deleted profile cannot reactivate'; END;
 IF NOT EXISTS(SELECT 1 FROM public.operator_auth_status(ARRAY[auth.uid()]) WHERE auth_available) THEN RAISE EXCEPTION 'Admin identity unavailable'; END IF;
 RAISE NOTICE 'PASS current account remains available';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',(SELECT id::text FROM public.profiles WHERE username='qa_operator_01'),true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN PERFORM * FROM public.operator_auth_status(ARRAY[auth.uid()]); RAISE EXCEPTION 'Operator obtained Auth statuses';
 EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS operator denied Auth status lookup'; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF has_function_privilege('anon','public.operator_auth_status(uuid[])','execute') THEN RAISE EXCEPTION 'Anonymous has helper execute'; END IF;
 RAISE NOTICE 'PASS anonymous helper execute revoked';
END $$;
ROLLBACK;
