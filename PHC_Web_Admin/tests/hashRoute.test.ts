import assert from 'node:assert/strict';
import test from 'node:test';
import { hashForTab, parseHashRoute } from '../src/routing/hashRoute.ts';

test('empty hash defaults to resumen', () => {
  assert.deepEqual(parseHashRoute(''), { tab: 'resumen' });
  assert.deepEqual(parseHashRoute('#'), { tab: 'resumen' });
});

test('known tabs parse', () => {
  assert.equal(parseHashRoute('#/pedidos').tab, 'pedidos');
  assert.equal(parseHashRoute('#/cierres').tab, 'cierres');
});

test('unknown paths are null routes, not crashes', () => {
  const route = parseHashRoute('#/inventario');
  assert.equal(route.tab, null);
  assert.equal(route.unknownPath, 'inventario');
});

test('proyectos accepts a numeric id from path or query', () => {
  assert.deepEqual(parseHashRoute('#/proyectos/12'), { tab: 'proyectos', projectId: 12 });
  assert.deepEqual(parseHashRoute('#/proyectos?projectId=7'), { tab: 'proyectos', projectId: 7 });
});

test('proyectos rejects non-numeric ids', () => {
  assert.equal(parseHashRoute('#/proyectos/abc').tab, null);
});

test('hashForTab round-trips proyectos with id', () => {
  assert.equal(hashForTab('proyectos', 5), '#/proyectos/5');
  assert.equal(hashForTab('resumen'), '#/resumen');
});
