import assert from 'node:assert/strict';
import test from 'node:test';
import { unitChangeWarning } from '../src/domain/unitChange.ts';

test('changing the unit warns that assigned quantities are not converted', () => {
  const message = unitChangeWarning('bolsa', 'kg');
  assert.match(message || '', /no convierte las cantidades ya asignadas/);
});

test('no warning when the unit is unchanged or only changes case', () => {
  assert.equal(unitChangeWarning('kg', 'kg'), null);
  assert.equal(unitChangeWarning('Kg', 'kg '), null);
});
