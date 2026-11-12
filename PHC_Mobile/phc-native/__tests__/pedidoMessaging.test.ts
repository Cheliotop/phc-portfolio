import { pedidoReceiptSavedMessage, syncedPedidoCreatedMessage } from '../src/domain/pedidoMessaging';

describe('syncedPedidoCreatedMessage', () => {
  it('states that Personal pedidos never modify project inventory', () => {
    expect(syncedPedidoCreatedMessage('personal')).toBe(
      'El pedido Personal fue enviado. Su aprobación y recepción no modifican el inventario del pozo.',
    );
  });

  it('states that Empresa inventory changes only after receipt confirmation', () => {
    expect(syncedPedidoCreatedMessage('empresa')).toBe(
      'El pedido de Empresa fue enviado. La aprobación no cambia inventario; se actualiza únicamente cuando confirmes la recepción.',
    );
  });
});

describe('pedidoReceiptSavedMessage', () => {
  it('keeps synced Personal receipts inventory-neutral', () => {
    expect(pedidoReceiptSavedMessage('personal', true)).toBe(
      'Recepción Personal confirmada. El inventario del pozo no cambió.',
    );
  });

  it('keeps queued Personal receipts inventory-neutral', () => {
    expect(pedidoReceiptSavedMessage('personal', false)).toBe(
      'La recepción Personal quedó guardada y se sincronizará sin cambiar el inventario del pozo.',
    );
  });

  it('states the Empresa inventory change only after a synced receipt', () => {
    expect(pedidoReceiptSavedMessage('empresa', true)).toBe(
      'Recepción confirmada. Solo ahora se actualizó el inventario de empresa.',
    );
    expect(pedidoReceiptSavedMessage('empresa', false)).toBe(
      'Quedó guardada y actualizará inventario al sincronizar.',
    );
  });
});
