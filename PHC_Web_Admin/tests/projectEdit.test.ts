import assert from 'node:assert/strict';
import test from 'node:test';
import { materialTotalFromInput, projectEditTextFields, reactivationWarning } from '../src/domain/projectEdit.ts';

test('a cleared field is sent as null, so the old value does not survive the save', () => {
  assert.deepEqual(projectEditTextFields({
    location: '  ', wellName: 'Pozo B', client: '', coordinates: '', barDiameter: '',
  }), {
    location: null, well_name: 'Pozo B', client: null, coordinates: null, default_bar_diameter: null,
  });
});

test('an emptied total is refused instead of becoming 0', () => {
  assert.equal(materialTotalFromInput(''), null);
  assert.equal(materialTotalFromInput('   '), null);
  assert.equal(materialTotalFromInput('-2'), null);
  assert.equal(materialTotalFromInput('12,5'), 12.5);
  assert.equal(materialTotalFromInput('0'), 0);
});

test('reactivating a well with a sent Ficha says it stays signable', () => {
  assert.match(reactivationWarning(true), /Ficha enviada sin firmar/);
  assert.equal(reactivationWarning(false), '');
});
