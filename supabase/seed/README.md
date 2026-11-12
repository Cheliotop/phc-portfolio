# Local production-volume QA seed

This seed is intentionally destructive-by-reset and LOCAL-only. It creates deterministic data after a clean migration replay, then refuses to run again until the next reset. The refusal matters because completed projects and operational history are intentionally immutable.

Run from the repository root:

```bash
supabase db reset

TOKEN=$(node supabase/seed/mint-local-jwt.js | grep -o 'TOKEN=.*' | cut -d= -f2-)
PHC_LOCAL_SUPABASE_PUBLISHABLE_KEY="$TOKEN" \
PHC_LOCAL_SUPABASE_SECRET_KEY="$TOKEN" \
node supabase/seed/seed-local.js
```

### Why the seeder needs a minted JWT

`supabase status` prints `sb_publishable_` / `sb_secret_` keys. The publishable
key is the correct least-privileged key for the local mobile app and was verified
with a real seeded password login on 2026-07-29. In this CLI/GoTrue combination,
however, passing the printed `sb_` keys to `/auth/v1/admin/*` fails with
`bad_jwt` ("signing method HS256 is invalid"). The deterministic seeder creates
real Auth users, so it separately needs an ES256 `service_role` token signed with
the local EC key from `GOTRUE_JWT_KEYS`.

`mint-local-jwt.js` produces that local-only service token. It is for seed/audit
processes, never for an APK or web client. The key helper reads the current EC signing key from the local Docker Auth
container at runtime. No private JWK is included in this repository. Set
`PHC_LOCAL_AUTH_CONTAINER` if the local container name differs from
`supabase_auth_PHC`. Do not print or commit the key.

`PHC_LOCAL_SUPABASE_URL` defaults to `http://127.0.0.1:54321`. The script rejects HTTPS, non-loopback hosts, and any port other than `54321`; it cannot target the production project. Keys are supplied at runtime and must not be committed.

## RLS audit

`rls-audit.js` logs in as real seeded users and tries to break tenant
isolation — cross-operator reads, personal-pedido privacy, self-escalation to
admin, writing into another operator's project, reading `audit_log`, anonymous
access, and calling admin-only RPCs. Run it after seeding:

```bash
node supabase/seed/rls-audit.js
```

It prints one PASS/FAIL line per check. All 10 passed as of 2026-07-20. Any FAIL
is a security regression and must block release.

## Integrity audit

`integrity-audit.js` attempts to violate the guarantees the client's field
records depend on: NaN/Infinity into finite-checked columns, duplicate
`client_entry_id` (the offline-sync idempotency key), updating or deleting
`audit_log`, mutating a completed project, editing drilling bars frozen by
project finalization, altering water samples, and editing a closed shift.

```bash
node supabase/seed/integrity-audit.js
```

The current seed includes water samples, and every check must pass. Both RLS and
integrity scripts exit nonzero on any failed assertion so they can be trusted in
CI or chained release commands.

All users are created through the Auth Admin API, so GoTrue password hashing and `handle_new_user` run normally.

## Closure and Edge Function audits

After a fresh seed, `closure-audit.js` executes the complete return, correction,
resubmission, reconciliation, signature, private-PDF, and immutability chain.
`edge-functions-audit.js` verifies operator creation/password reset boundaries,
the inert notification path, and two-phase attachment deletion. Both scripts
are hard-locked to `127.0.0.1:54321` and deliberately mutate seeded data.

```bash
node supabase/seed/closure-audit.js
node supabase/seed/edge-functions-audit.js
```

## Test credentials

- Admin: `qa_admin@phc.local` / `PHC-Local-Admin-v2!`
- Operators: `qa_operator_01@phc.local` through `qa_operator_10@phc.local` / `PHC-Local-Operator-v2!`
- Mobile operator usernames: `qa_operator_01` through `qa_operator_10` (the app adds `@phc.local`)

The deterministic dataset contains 30 projects (planning, active, closure submitted, and completed), ten operators, open and closed shifts, continuous drilling histories, both project-material layers, both pedido kinds with pending/approved/rejected/partial/received states, receipts, Fichas v2, and photo metadata.

## Account lifecycle regression

After the initial seed, run `node supabase/seed/prepare-auth-lifecycle.js` from the
repository root. It creates and soft-deletes a synthetic local identity through
Auth Admin APIs so `operator-auth-lifecycle.sql` is reproducible without a browser.
The SQL suite is rollback-only and fails immediately on any assertion error.
