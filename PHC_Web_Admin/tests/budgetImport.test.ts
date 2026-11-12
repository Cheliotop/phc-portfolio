import assert from 'node:assert/strict';
import test from 'node:test';
import { detectDelimiter, parseBudgetText, splitDelimited, type BudgetVariant } from '../src/domain/budgetImport.ts';

const variants: BudgetVariant[] = [
  { id: 1, label: 'Cemento', code: 'MAT-02', unit: 'bolsa' },
  { id: 2, label: 'Tubo PVC 6"', code: null, unit: 'm' },
];

test('a quoted field keeps the delimiter and escaped quotes', () => {
  assert.deepEqual(splitDelimited('"Tubo 6"", 4 m";100;m', ';'), ['Tubo 6", 4 m', '100', 'm']);
  assert.deepEqual(splitDelimited('a,"b,c",d', ','), ['a', 'b,c', 'd']);
});

test('the delimiter comes from the first non-empty line', () => {
  assert.equal(detectDelimiter('\n\nMAT;Cemento;2;bolsa'), ';');
  assert.equal(detectDelimiter('MAT\tCemento\t2\tbolsa'), '\t');
  assert.equal(detectDelimiter('Cemento,2,bolsa'), ',');
});

test('Paraguayan quantities parse: "1.234,56" is 1234.56', () => {
  const result = parseBudgetText('MAT-02;Cemento;1.234,56;bolsa', variants);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 1234.56);
  assert.equal(result.lines[0].catalogVariantId, 1);
  assert.equal(result.lines[0].createNew, false);
  assert.deepEqual(result.rejected, []);
});

test('"1.200" is listed with both readings for the admin to confirm', () => {
  const result = parseBudgetText('Tubo PVC 6";1.200;m', variants);
  assert.equal(result.lines[0].quantity, null);
  assert.deepEqual(result.lines[0].quantityChoices, [1200, 1.2]);
});

test('every rejected line is reported with its line number', () => {
  const text = [
    'Código;Descripción;Cantidad;Unidad',
    'MAT-02;Cemento;abc;bolsa',
    '',
    'Solo una columna',
    'X;Cemento;0;bolsa',
    'MAT-02;Cemento;20;bolsa',
  ].join('\n');
  const result = parseBudgetText(text, variants);
  assert.deepEqual(result.rejected.map((line) => line.lineNumber), [1, 2, 4, 5]);
  assert.match(result.rejected[1].reason, /Cantidad inválida/);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].lineNumber, 6);
});

test('quoted descriptions survive intact', () => {
  const result = parseBudgetText('"Tubo PVC 6"", 4 m";3;m', variants);
  assert.equal(result.lines[0].description, 'Tubo PVC 6", 4 m');
  assert.equal(result.lines[0].unit, 'm');
  assert.equal(result.lines[0].createNew, true);
});

test('a blank unit falls back to the matched catalog unit', () => {
  const result = parseBudgetText('Cemento;3;', variants);
  assert.equal(result.lines[0].unit, 'bolsa');
  assert.equal(result.lines[0].catalogVariantId, 1);
  assert.equal(result.lines[0].createNew, false);
});
