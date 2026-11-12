import assert from 'node:assert/strict';
import test from 'node:test';
import { sentByLabel } from '../src/domain/revisionAuthorship.ts';

const ANA = 'ana-id';
const BRUNO = 'bruno-id';
const ana = { full_name: 'Ana Benítez', username: 'ana' };
const bruno = { full_name: null, username: 'bruno' };

test('work sent from another login on the shared tablet names both operators (WEB-22)', () => {
  assert.equal(sentByLabel({ operator_id: ANA, reported_by: BRUNO, operator: ana, reporter: bruno }),
    'Creado por Ana Benítez · enviado por bruno desde la tablet del equipo');
});

test('the same user creating and sending shows no line', () => {
  assert.equal(sentByLabel({ operator_id: ANA, reported_by: ANA, operator: ana, reporter: ana }), null);
});

test('a missing name falls back instead of printing "undefined"', () => {
  assert.equal(sentByLabel({ operator_id: ANA, reported_by: BRUNO, operator: null, reporter: null }),
    'Creado por Operador desconocido · enviado por otro operador desde la tablet del equipo');
});

test('the label never says teléfono', () => {
  const text = sentByLabel({ operator_id: ANA, reported_by: BRUNO, operator: ana, reporter: bruno }) || '';
  assert.equal(/tel[eé]fono/i.test(text), false);
});
