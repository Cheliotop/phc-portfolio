import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedPedidoItemNotice, pedidoApprovalExplanation } from '../src/domain/pedidoDecisionNotice.ts';

test('Personal approval says inventory never changes', () => {
  assert.equal(
    approvedPedidoItemNotice('personal'),
    'Ítem Personal aprobado. El inventario del pozo no cambia ni con la aprobación ni con la recepción.',
  );
});

test('Empresa approval says inventory changes only after receipt', () => {
  assert.equal(
    approvedPedidoItemNotice('empresa'),
    'Ítem aprobado. El inventario todavía no cambió; cambiará solo cuando el operador confirme la recepción.',
  );
});

test('Personal approval dialog says approval and receipt are inventory-neutral', () => {
  assert.equal(
    pedidoApprovalExplanation('personal'),
    'Este pedido Personal no modifica el inventario del pozo, ni al aprobarlo ni al confirmar su recepción.',
  );
});

test('Empresa approval dialog explains the receipt-time inventory change', () => {
  assert.equal(
    pedidoApprovalExplanation('empresa'),
    'Esta aprobación autoriza la entrega, pero no modifica inventario. El saldo cambia únicamente cuando el operador confirma la recepción.',
  );
});
