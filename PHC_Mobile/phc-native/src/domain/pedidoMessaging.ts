import type { PedidoKind } from '../types/productV2';

export const syncedPedidoCreatedMessage = (kind: PedidoKind) => kind === 'personal'
  ? 'El pedido Personal fue enviado. Su aprobación y recepción no modifican el inventario del pozo.'
  : 'El pedido de Empresa fue enviado. La aprobación no cambia inventario; se actualiza únicamente cuando confirmes la recepción.';

export const pedidoReceiptSavedMessage = (kind: PedidoKind, synced: boolean) => {
  if (kind === 'personal') {
    return synced
      ? 'Recepción Personal confirmada. El inventario del pozo no cambió.'
      : 'La recepción Personal quedó guardada y se sincronizará sin cambiar el inventario del pozo.';
  }
  return synced
    ? 'Recepción confirmada. Solo ahora se actualizó el inventario de empresa.'
    : 'Quedó guardada y actualizará inventario al sincronizar.';
};
