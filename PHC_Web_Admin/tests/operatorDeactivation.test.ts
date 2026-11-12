import assert from 'node:assert/strict';
import test from 'node:test';
import { deactivationConfirmation } from '../src/domain/operatorDeactivation.ts';

test('confirmation names the operator and always warns about unsynced tablet work', () => {
  const text = deactivationConfirmation({ name: 'Ana', openShiftCount: 0, wellNames: [] });
  assert.match(text, /^¿Desactivar a Ana\?/);
  assert.match(text, /puede ir a Revisión/);
  assert.doesNotMatch(text, /turno\(s\)|operador 1 o 2/);
});

test('confirmation lists open shifts and the wells the operator is on', () => {
  const text = deactivationConfirmation({ name: 'Beto', openShiftCount: 2, wellNames: ['Pozo 1', 'Pozo 4'] });
  assert.match(text, /Tiene 2 turno\(s\) sin resolver\./);
  assert.match(text, /Es operador 1 o 2 en: Pozo 1, Pozo 4\./);
});
