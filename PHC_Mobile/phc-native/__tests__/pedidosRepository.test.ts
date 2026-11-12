const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import {
  applyProvisionalPedidoReceipt,
  applySyncedPedidoItem,
  applySyncedPedidoReceipt,
  applySyncedReceiptToPedidoItem,
  createLocalPedidoItem,
  createLocalPedidoReceipt,
  ensureServerPedidoItem,
} from '../src/db/repositories/pedidos';

/**
 * Guards pedido item identity across the offline boundary. A positional match
 * once cross-assigned server ids in a multi-item pedido, so confirming receipt
 * moved inventory for a different material. These tests pin every local write,
 * including the separate local/server ids, quantities, unit, and conflict mode.
 */
describe('pedido_items and pedido_receipts repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  it('creates an offline pedido item with stable local identity and unit', async () => {
    await createLocalPedidoItem({
      id: 'pedido-item-1',
      clientEntryId: 'pedido-item-1',
      pedidoId: 55,
      catalogVariantId: 46,
      materialName: 'Bentonita',
      requestedQuantity: 3,
      unit: 'bolsa',
      layer: 'extras',
      now: '2026-07-26T12:00:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO pedido_items (
               id, client_entry_id, pedido_id, catalog_variant_id,
               material_name_snapshot, requested_quantity, unit_snapshot,
               state, received_quantity, layer, sync_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'solicitado', 0, ?, 'pending', ?, ?)`,
      [
        'pedido-item-1', 'pedido-item-1', 55, 46,
        'Bentonita', 3, 'bolsa',
        'extras', '2026-07-26T12:00:00.000Z', '2026-07-26T12:00:00.000Z',
      ],
    );
  });

  it('inserts a remote-only item stub without replacing an existing local row', async () => {
    await ensureServerPedidoItem({
      id: 'server_item_101',
      serverId: 101,
      materialName: 'Cemento',
      requestedQuantity: 4,
      unit: 'bolsa',
      state: 'aprobado',
      approvedQuantity: 3,
      receivedQuantity: 1,
      layer: 'extras',
      now: '2026-07-26T12:01:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT OR IGNORE INTO pedido_items (
             id, server_id, material_name_snapshot, requested_quantity,
             unit_snapshot, state, approved_quantity, received_quantity,
             layer, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
      [
        'server_item_101', 101, 'Cemento', 4,
        'bolsa', 'aprobado', 3, 1,
        'extras', '2026-07-26T12:01:00.000Z', '2026-07-26T12:01:00.000Z',
      ],
    );
  });

  it('applies pedido sync identity to the matching local item only', async () => {
    await applySyncedPedidoItem({
      id: 'pedido-item-1',
      serverId: 101,
      pedidoServerId: 88,
      state: 'solicitado',
      updatedAt: '2026-07-26T12:02:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE pedido_items SET server_id = ?, pedido_server_id = ?, state = ?,
               sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
      [101, 88, 'solicitado', '2026-07-26T12:02:00.000Z', 'pedido-item-1'],
    );
  });

  it('creates a pending item-level receipt with both item identities', async () => {
    await createLocalPedidoReceipt({
      id: 'receipt-1',
      clientEntryId: 'receipt-1',
      pedidoItemId: 'pedido-item-1',
      pedidoItemServerId: 101,
      outcome: 'parcial',
      quantityReceived: 2,
      incidentNote: 'Entrega parcial',
      confirmedBy: 'operator-1',
      confirmedAt: '2026-07-26T12:03:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO pedido_receipts (
             id, client_entry_id, pedido_item_id, pedido_item_server_id,
             outcome, quantity_received, incident_note, confirmed_by,
             confirmed_at, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        'receipt-1', 'receipt-1', 'pedido-item-1', 101,
        'parcial', 2, 'Entrega parcial', 'operator-1',
        '2026-07-26T12:03:00.000Z', '2026-07-26T12:03:00.000Z',
        '2026-07-26T12:03:00.000Z',
      ],
    );
  });

  it('applies the optimistic received quantity to one local item', async () => {
    await applyProvisionalPedidoReceipt({
      id: 'pedido-item-1',
      state: 'parcial',
      receivedQuantity: 2,
      updatedAt: '2026-07-26T12:03:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE pedido_items SET state = ?, received_quantity = ?, updated_at = ? WHERE id = ?`,
      ['parcial', 2, '2026-07-26T12:03:00.000Z', 'pedido-item-1'],
    );
  });

  it('applies the server receipt identity without replacing receipt evidence', async () => {
    await applySyncedPedidoReceipt({
      id: 'receipt-1',
      serverId: 91,
      pedidoItemId: 'pedido-item-1',
      updatedAt: '2026-07-26T12:04:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE pedido_receipts SET server_id = ?, pedido_item_id = ?, sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
      [91, 'pedido-item-1', '2026-07-26T12:04:00.000Z', 'receipt-1'],
    );
  });

  it('applies the server-authoritative received quantity to one item', async () => {
    await applySyncedReceiptToPedidoItem({
      id: 'pedido-item-1',
      state: 'recibido',
      receivedQuantity: 3,
      updatedAt: '2026-07-26T12:04:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE pedido_items SET state = ?, received_quantity = ?, sync_status = 'synced', updated_at = ? WHERE id = ?`,
      ['recibido', 3, '2026-07-26T12:04:00.000Z', 'pedido-item-1'],
    );
  });
});
