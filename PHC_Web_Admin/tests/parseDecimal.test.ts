import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDecimal, parsePositiveDecimal } from '../src/utils/parseDecimal.ts';

test('blank input means no value', () => {
  assert.equal(parseDecimal(''), undefined);
  assert.equal(parseDecimal('   '), undefined);
});

test('dot and comma separators both parse', () => {
  assert.equal(parseDecimal('12.5'), 12.5);
  assert.equal(parseDecimal('12,5'), 12.5);
  assert.equal(parseDecimal('  7,25  '), 7.25);
});

test('garbage is undefined, never NaN', () => {
  assert.equal(parseDecimal('abc'), undefined);
  assert.equal(parseDecimal('1,2,3'), undefined);
  assert.equal(parseDecimal('NaN'), undefined);
  assert.equal(parseDecimal('Infinity'), undefined);
});

test('positive variant rejects zero and negatives', () => {
  assert.equal(parsePositiveDecimal('3,5'), 3.5);
  assert.equal(parsePositiveDecimal('0'), undefined);
  assert.equal(parsePositiveDecimal('-2'), undefined);
  assert.equal(parsePositiveDecimal(''), undefined);
});
