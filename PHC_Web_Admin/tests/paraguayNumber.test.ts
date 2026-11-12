import assert from 'node:assert/strict';
import test from 'node:test';
import { parseParaguayanNumber } from '../src/domain/paraguayNumber.ts';

test('Paraguayan grouping: dot thousands, comma decimals', () => {
  assert.deepEqual(parseParaguayanNumber('1.234,56'), { kind: 'ok', value: 1234.56 });
  assert.deepEqual(parseParaguayanNumber('1.234.567'), { kind: 'ok', value: 1234567 });
});

test('comma and plain dot decimals parse as decimals', () => {
  assert.deepEqual(parseParaguayanNumber('2,5'), { kind: 'ok', value: 2.5 });
  assert.deepEqual(parseParaguayanNumber('12.5'), { kind: 'ok', value: 12.5 });
  assert.deepEqual(parseParaguayanNumber('12'), { kind: 'ok', value: 12 });
});

test('a single dot followed by three digits is ambiguous, never silently decided', () => {
  assert.deepEqual(parseParaguayanNumber('1.200'), { kind: 'ambiguous', asThousands: 1200, asDecimal: 1.2 });
});

test('garbage and US grouping are invalid', () => {
  assert.equal(parseParaguayanNumber('abc').kind, 'invalid');
  assert.equal(parseParaguayanNumber('').kind, 'invalid');
  assert.equal(parseParaguayanNumber('1,2,3').kind, 'invalid');
  assert.equal(parseParaguayanNumber('1,234.56').kind, 'invalid');
});
