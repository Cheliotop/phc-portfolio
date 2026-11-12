import { execute } from '../index';

/**
 * The ONE place that writes local `pedido_items` and `pedido_receipts` rows.
 *
 * Why this module exists
 * ---------------------
 * W-10 proved that duplicated SQLite statements can silently discard omitted
 * columns. Pedido rows add a more dangerous identity split: local ids keep the
 * offline graph intact, while server ids identify the exact material whose
 * receipt mutates inventory. A positional multi-item match once cross-assigned
 * those server ids and moved stock for a different material. Centralizing each
 * insert and targeted update keeps identity, quantities, and units from drifting.
 */

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

export interface LocalPedidoItem {
  id: string;
  clientEntryId: string;
  pedidoId: number;
  catalogVariantId?: number | null;
  materialName: string;
  requestedQuantity: number;
  unit: string;
  layer: string;
  now: string;
}

export interface ServerPedidoItemStub {
  id: string;
  serverId: number;
  materialName: string;
  requestedQuantity: number;
  unit: string;
  state: string;
  approvedQuantity: number | null;
  receivedQuantity: number;
  layer: string;
  now: string;
}

export interface SyncedPedidoItem {
  id: string;
  serverId: number;
  pedidoServerId: number;
  state: string;
  updatedAt: string;
}

export interface LocalPedidoReceipt {
  id: string;
  clientEntryId: string;
  pedidoItemId: string;
  pedidoItemServerId: number;
  outcome: string;
  quantityReceived: number;
  incidentNote: string | null;
  confirmedBy: string;
  confirmedAt: string;
}

export interface PedidoItemReceiptState {
  id: string;
  state: string;
  receivedQuantity: number;
  updatedAt: string;
}

export interface SyncedPedidoReceipt {
  id: string;
  serverId: number | null;
  pedidoItemId: string;
  updatedAt: string;
}

/** Create one locally-owned pedido item before the pedido outbox is queued. */
export const createLocalPedidoItem = async (
  item: LocalPedidoItem,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO pedido_items (
               id, client_entry_id, pedido_id, catalog_variant_id,
               material_name_snapshot, requested_quantity, unit_snapshot,
               state, received_quantity, layer, sync_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'solicitado', 0, ?, 'pending', ?, ?)`,
    [
      item.id, item.clientEntryId, item.pedidoId, item.catalogVariantId ?? null,
      item.materialName, item.requestedQuantity, item.unit || 'unidad',
      item.layer || 'extras', item.now, item.now,
    ],
  );
};

/** Ensure a server-only item has a local identity without replacing local data. */
export const ensureServerPedidoItem = async (
  item: ServerPedidoItemStub,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT OR IGNORE INTO pedido_items (
             id, server_id, material_name_snapshot, requested_quantity,
             unit_snapshot, state, approved_quantity, received_quantity,
             layer, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
    [
      item.id, item.serverId, item.materialName, item.requestedQuantity,
      item.unit, item.state, item.approvedQuantity ?? null,
      item.receivedQuantity, item.layer, item.now, item.now,
    ],
  );
};

/** Apply the stable server identity returned for one locally-owned item. */
export const applySyncedPedidoItem = async (
  item: SyncedPedidoItem,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE pedido_items SET server_id = ?, pedido_server_id = ?, state = ?,
               sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
    [item.serverId, item.pedidoServerId, item.state, item.updatedAt, item.id],
  );
};

/** Persist an item-level receipt before its outbox intent is queued. */
export const createLocalPedidoReceipt = async (
  receipt: LocalPedidoReceipt,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO pedido_receipts (
             id, client_entry_id, pedido_item_id, pedido_item_server_id,
             outcome, quantity_received, incident_note, confirmed_by,
             confirmed_at, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      receipt.id, receipt.clientEntryId, receipt.pedidoItemId, receipt.pedidoItemServerId,
      receipt.outcome, receipt.quantityReceived, receipt.incidentNote, receipt.confirmedBy,
      receipt.confirmedAt, receipt.confirmedAt, receipt.confirmedAt,
    ],
  );
};

/** Apply the optimistic receipt total while the receipt remains queued. */
export const applyProvisionalPedidoReceipt = async (
  item: PedidoItemReceiptState,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE pedido_items SET state = ?, received_quantity = ?, updated_at = ? WHERE id = ?`,
    [item.state, item.receivedQuantity, item.updatedAt, item.id],
  );
};

/** Apply server identity to a receipt without replacing its local evidence. */
export const applySyncedPedidoReceipt = async (
  receipt: SyncedPedidoReceipt,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE pedido_receipts SET server_id = ?, pedido_item_id = ?, sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
    [receipt.serverId, receipt.pedidoItemId, receipt.updatedAt, receipt.id],
  );
};

/** Apply the server-authoritative state and received total to one item. */
export const applySyncedReceiptToPedidoItem = async (
  item: PedidoItemReceiptState,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE pedido_items SET state = ?, received_quantity = ?, sync_status = 'synced', updated_at = ? WHERE id = ?`,
    [item.state, item.receivedQuantity, item.updatedAt, item.id],
  );
};
