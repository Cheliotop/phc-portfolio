import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDossierMismatch,
  isDossierReplyCurrent,
  shouldReloadAfterAction,
} from '../src/domain/cierresGuards.ts';

// WEB-5: a late dossier reply or an action's reload must not replace the Ficha on screen.
test('a dossier reply is shown only while its project is still the selected one', () => {
  assert.equal(isDossierReplyCurrent(21, 21), true);
  assert.equal(isDossierReplyCurrent(21, 22), false, 'Ficha A reply while B is selected');
  assert.equal(isDossierReplyCurrent(21, null), false, 'nothing selected');
});

test('an action reloads the dossier only while its Ficha is still selected', () => {
  assert.equal(shouldReloadAfterAction(9, 9), true);
  assert.equal(shouldReloadAfterAction(10, 9), false, 'admin moved to Ficha B during the RPC');
  assert.equal(shouldReloadAfterAction(null, 9), false);
});

test('a dossier compiled for another Ficha is a mismatch', () => {
  assert.equal(isDossierMismatch(9, 9), false);
  assert.equal(isDossierMismatch(8, 9), true, 'older Ficha compiled');
  assert.equal(isDossierMismatch(null, 9), false, 'no completion yet is not a mismatch');
  assert.equal(isDossierMismatch(undefined, 9), false);
});
