import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCsv } from '../src/utils/exportCsv.ts';

const cols = [
  { key: 'name', label: 'Nombre' },
  { key: 'reason', label: 'Motivo' },
];

test('formula-like cells are neutralized with a leading quote', () => {
  const csv = buildCsv([{ name: '=SUM(A1:A2)', reason: '@cmd' }], cols);
  assert.ok(csv.includes("'=SUM(A1:A2)"));
  assert.ok(csv.includes("'@cmd"));
});

test('plus and minus prefixes are neutralized', () => {
  const csv = buildCsv([{ name: '+123', reason: '-5' }], cols);
  assert.ok(csv.includes("'+123"));
  assert.ok(csv.includes("'-5"));
});

test('normal text is untouched, quotes still escaped', () => {
  const csv = buildCsv([{ name: 'Pozo Norte', reason: 'dice "hola", listo' }], cols);
  assert.ok(csv.includes('Pozo Norte'));
  assert.ok(csv.includes('"dice ""hola"", listo"'));
});

test('empty dataset throws instead of exporting a header-only file', () => {
  assert.throws(() => buildCsv([], cols), /No hay datos/);
});

// Code read W4: one row per pedido item, not a sum across units.
test('pedido exports one row per item, with its own unit', async () => {
  const { pedidoItemRows } = await import('../src/utils/exportCsv.ts');
  const rows = pedidoItemRows([{
    pedido_number: 'P-1', projects: { name: 'Pozo 7' }, profiles: { full_name: 'Ana' }, kind: 'empresa',
    pedido_items: [
      { material_name_snapshot: 'Caño', requested_quantity: 100, unit_snapshot: 'm', state: 'aprobado' },
      { material_name_snapshot: 'Bentonita', requested_quantity: 20, unit_snapshot: 'bolsa', state: 'solicitado' },
    ],
  }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => `${row.requested} ${row.unit}`), ['100 m', '20 bolsa']);
  assert.equal(rows[0].operator_name, 'Ana');
});
