import assert from 'node:assert/strict';
import test from 'node:test';
import { failedSourcesMessage, recordFailure } from '../src/domain/dashboardLoad.ts';

// WEB-9: a failed source is recorded and reported, never shown as an empty list.
test('a failed source is recorded and replaced by its fallback', () => {
  const failures: string[] = [];
  const fallback = recordFailure(failures, 'pedidos', () => ({ data: [] as string[] }));
  assert.deepEqual(fallback(), { data: [] });
  assert.deepEqual(failures, ['pedidos']);
});

test('the same failed source is recorded once', () => {
  const failures: string[] = [];
  recordFailure(failures, 'turnos', () => [])();
  recordFailure(failures, 'turnos', () => [])();
  assert.deepEqual(failures, ['turnos']);
});

test('no message when every source loaded', () => {
  assert.equal(failedSourcesMessage([]), null);
});

test('the message names every failed source and does not read as all clear', () => {
  const message = failedSourcesMessage(['pedidos', 'turnos']);
  assert.ok(message);
  assert.ok(message.startsWith('No se pudieron cargar: pedidos, turnos'));
  assert.ok(message.includes('no es que no haya pendientes') || message.includes('no significa que no haya pendientes'));
});
