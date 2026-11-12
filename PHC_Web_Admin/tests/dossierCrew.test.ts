import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arrivedLateLabel,
  buildDossierCrew,
  enteredByLabel,
  shiftCrewLabel,
} from '../src/domain/dossierCrew.ts';

// WEB-12 / equipo: who typed each row and who was on each shift.
const operators = [
  { id: 'a', full_name: 'Ana Benítez', username: 'ana' },
  { id: 'b', full_name: null, username: 'beto' },
  { id: 'c', full_name: 'Carla', username: 'carla' },
];
const crew = buildDossierCrew(operators, [
  { shift_id: 's1', operator_id: 'a' },
  { shift_id: 's1', operator_id: 'b' },
  { shift_id: 's1', operator_id: 'b' },
]);

test('"Ingresado por" names the operator who typed the row', () => {
  assert.equal(enteredByLabel('b', crew), 'beto', 'falls back to username');
  assert.equal(enteredByLabel('a', crew), 'Ana Benítez');
  assert.equal(enteredByLabel(null, crew), '—');
  assert.equal(enteredByLabel(undefined, crew), '—');
});

test('an operator missing from the directory is named generically, never by UUID', () => {
  const label = enteredByLabel('7c9e6679-7425-40de-944b-e07fc1f90ae7', crew);
  assert.equal(label, 'Operador desconocido');
  assert.ok(!label.includes('7c9e'));
});

test('a shift lists every participant once, in row order', () => {
  assert.equal(shiftCrewLabel({ id: 's1', operator_id: 'a' }, crew), 'Ana Benítez · beto');
});

test('a shift without participant rows falls back to the operator who started it', () => {
  assert.equal(shiftCrewLabel({ id: 's2', operator_id: 'c' }, crew), 'Carla');
  assert.equal(shiftCrewLabel({ id: 's3' }, crew), '—');
});

test('"llegó tarde" shows only for bars flagged arrived_late; older rows count as on time', () => {
  assert.equal(arrivedLateLabel({ arrived_late: true }), 'Llegó tarde');
  assert.equal(arrivedLateLabel({ arrived_late: false }), '—');
  assert.equal(arrivedLateLabel({}), '—');
});
