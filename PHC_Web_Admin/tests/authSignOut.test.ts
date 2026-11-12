import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// WEB-4: "Salir" must sign out this browser only, not every session of the account.
test('logout signs out the local session only', () => {
  const source = readFileSync(new URL('../src/auth/AuthProvider.tsx', import.meta.url), 'utf8');
  assert.match(source, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/);
});
