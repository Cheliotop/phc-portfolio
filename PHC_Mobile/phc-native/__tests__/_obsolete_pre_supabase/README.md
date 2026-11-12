# Retired legacy test suites (pre-Supabase / pre–Pass 2 UI)

These three suites were retired in Pass 4 because they test an architecture and
UI that no longer exist:

- `LoginScreen.test.tsx.txt` — imports the **deleted** `../src/api/client`
  (the old Express API client removed in the Pass 1.5 Supabase migration), so it
  cannot even resolve its imports.
- `OperatorDashboard.test.tsx.txt` / `AdminDashboard.test.tsx.txt` — transitively
  import `expo-print` (ESM) which the current jest `transformIgnorePatterns`
  doesn't allow-list, and they assert on pre–Pass 2 emoji/brand copy and
  pre–Pass 3/4 workflow structure.

They are kept here (as `.txt`, so jest's `testMatch` ignores them) for reference
only. Rewriting them against the Supabase APIs + current UB is future work
(a Pass 5 candidate): use `jest-expo` (or a scoped `transformIgnorePatterns`),
mock the Supabase client, and assert on the current copy/flows.

The active, passing suites are: `camera`, `database`, `navigation`,
`performance`.
