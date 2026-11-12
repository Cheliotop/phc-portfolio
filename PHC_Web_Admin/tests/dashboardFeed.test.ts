import assert from 'node:assert/strict';
import test from 'node:test';
import { cierreFeedLabel, pedidoStatusLabel, unresolvedLateShifts } from '../src/domain/dashboardFeed.ts';

test('a closed auto-close does not count as a late shift on the well badge (WEB-17)', () => {
  const shifts = [
    { id: 1, status: 'closed', end_type: 'auto' },
    { id: 2, status: 'closed', end_type: 'operator' },
    { id: 3, status: 'report_pending', end_type: 'auto' },
    { id: 4, status: 'open', end_type: 'auto' },
    { id: 5, status: 'closed', end_type: null },
  ];
  assert.deepEqual(unresolvedLateShifts(shifts).map((shift) => shift.id), [3, 4]);
});

test('a report still pending counts as late even without an auto-close', () => {
  assert.deepEqual(unresolvedLateShifts([{ id: 7, status: 'report_pending', end_type: null }]).map((shift) => shift.id), [7]);
});

test('a returned Ficha reads as returned, not as pending signature (WEB-17)', () => {
  assert.equal(cierreFeedLabel({ status: 'returned', admin_signature: null }), 'Devuelta al operador');
  assert.equal(cierreFeedLabel({ status: 'submitted', admin_signature: null }), 'Pendiente de firma');
  assert.equal(cierreFeedLabel({ status: 'returned', admin_signature: 'firma' }), 'Firmado');
});

test('pedido statuses print in Spanish, unknown ones as they are', () => {
  assert.equal(pedidoStatusLabel('submitted'), 'Enviado');
  assert.equal(pedidoStatusLabel('rejected'), 'Rechazado');
  assert.equal(pedidoStatusLabel('algo_nuevo'), 'algo_nuevo');
  assert.equal(pedidoStatusLabel(null), '—');
});
