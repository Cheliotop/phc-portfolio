import assert from 'node:assert/strict';
import test from 'node:test';
import { operatorTeamLabel } from '../src/domain/operatorTeam.ts';

const operators = [
  { id: 'a', full_name: 'Ana', username: 'ana', is_active: true },
  { id: 'b', full_name: 'Beto', username: 'beto', is_active: true },
  { id: 'c', username: 'cami', is_active: true },
];

test('crew label includes the primary and every secondary in order', () => {
  assert.equal(operatorTeamLabel('a', ['b', 'c'], operators), 'Ana · Beto · cami');
});

test('crew label has a fallback when an operator is not in the directory', () => {
  assert.equal(operatorTeamLabel(null, ['missing'], operators), '—');
});
