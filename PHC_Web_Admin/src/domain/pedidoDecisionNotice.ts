import type { PedidoKind } from '../types/productV2';

export const approvedPedidoItemNotice = (kind: PedidoKind) =>
  kind === 'personal'
    ? 'Ítem Personal aprobado. El inventario del pozo no cambia ni con la aprobación ni con la recepción.'
    : 'Ítem aprobado. El inventario todavía no cambió; cambiará solo cuando el operador confirme la recepción.';

export const pedidoApprovalExplanation = (kind: PedidoKind) =>
  kind === 'personal'
    ? 'Este pedido Personal no modifica el inventario del pozo, ni al aprobarlo ni al confirmar su recepción.'
    : 'Esta aprobación autoriza la entrega, pero no modifica inventario. El saldo cambia únicamente cuando el operador confirma la recepción.';
