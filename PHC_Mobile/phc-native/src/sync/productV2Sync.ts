import { execute, query, queryFirst } from '../db/db';
import {
  applySyncedPedidoItem,
  applySyncedPedidoReceipt,
  applySyncedReceiptToPedidoItem,
} from '../db/repositories/pedidos';
import { deleteOutbox, selectDrainableOutboxRows, type DrainableOutboxRow } from '../db/operations';
import { recordSyncFailure } from './rejection';
import { releaseWorkBehindRejectedStarts } from './rejectedStart';
import { reconcileServerClosedShifts } from './serverClosedShifts';
import { handoverStillQueued } from './shiftDependencies';
import { shiftsApi } from '../api/supabase-shifts';
import { pedidosApi } from '../api/supabase-pedidos';
import { waterSamplesApi } from '../api/supabase-water-samples';
import { photosApi } from '../api/supabase-photos';
import { completionApi } from '../api/supabase-completion';
import { errorMessage } from '../utils/errorMessage';
import { formatDisplayDateTime } from '../utils/dateFormat';
import {
  applySyncedShiftEnd,
  applySyncedShiftStart,
  confirmShiftHandoverLocally,
  markShiftHandoversFailed,
  markShiftHandoversSynced,
  markShiftHandoverUnconfirmed,
  recordShiftSyncError,
} from '../db/repositories/shifts';
import {
  applySyncedWaterSample,
  recordWaterSampleSyncError,
} from '../db/repositories/waterSamples';

const rowsFor = (entity: string) => selectDrainableOutboxRows(entity);

const waterSampleProjectOf = (payloadJson: string): string | null => {
  try {
    const projectId = JSON.parse(payloadJson)?.projectId;
    return projectId === undefined || projectId === null ? null : String(projectId);
  } catch {
    return null;
  }
};

const loadWaterSampleUploadOrder = async (): Promise<Map<string, string[]>> => {
  const queued = await query<{ id: string; payload_json: string }>(
    `SELECT id, payload_json FROM sync_outbox
     WHERE entity = 'water_sample' AND COALESCE(state, 'pending') <> 'quarantined'
     ORDER BY created_at ASC, rowid ASC`,
  );
  const order = new Map<string, string[]>();
  for (const row of queued) {
    const projectId = waterSampleProjectOf(row.payload_json);
    if (projectId === null) continue;
    order.set(projectId, [...(order.get(projectId) ?? []), row.id]);
  }
  return order;
};

const payloadOf = (row: DrainableOutboxRow): any => {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    throw new Error(`Invalid queued ${row.entity} payload`);
  }
};

// Supabase errors are plain objects; delegate to the shared helper so the
// operator never sees "[object Object]" in the sync queue.
const messageOf = (error: unknown) => errorMessage(error);

export type ShiftSyncState = 'pending' | 'synced';

/**
 * Refused rows (quarantined) are not waiting to be sent, so they do not keep the
 * shift on "pending". readShiftCloseState reports the refusal itself.
 */
export const getShiftSyncState = async (shiftId: string): Promise<ShiftSyncState> => {
  const row = await queryFirst<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM sync_outbox
     WHERE entity_id = ?
       AND entity IN ('shift_start', 'shift_handover', 'shift_auto_close', 'shift_end')
       AND COALESCE(state, 'pending') <> 'quarantined'`,
    [shiftId],
  );
  return Number(row?.count || 0) > 0 ? 'pending' : 'synced';
};

export const syncPendingShiftStarts = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('shift_start')) {
    try {
      const payload = payloadOf(row);
      const result = await shiftsApi.start({ ...payload, enteredBy: row.author_id });
      if (result.id !== payload.shiftId) {
        // The server has an unresolved shift for this operator. That is often
        // OUR OWN previous queued shift whose end has not drained yet (starts
        // sync before ends), so the outbox row must survive: once the earlier
        // shift closes, the next pass creates this one. Never silently attach
        // new work to the returned shift, and never delete the queued start.
        await recordShiftSyncError(
          row.entity_id,
          `Hay otro turno sin resolver en el servidor (${result.id}). Este turno local se conserva y se reintentará cuando aquel turno cierre.`,
          new Date().toISOString(),
        );
        failed += 1;
        continue;
      }
      await applySyncedShiftStart({
        shiftId: row.entity_id,
        serverId: result.id,
        status: result.status,
        startedAt: result.started_at,
        endedAt: result.ended_at ?? null,
        endType: result.end_type ?? null,
        deviceTimeFlag: result.device_time_flag ? 1 : 0,
        updatedAt: new Date().toISOString(),
      });
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      // Only a refusal belongs on the shift card. A lost signal retries by itself,
      // and the queue screen already says so.
      if (await recordSyncFailure(row.id, error, message) === 'quarantined') {
        await recordShiftSyncError(row.entity_id, message, new Date().toISOString());
      }
      failed += 1;
    }
  }
  return { synced, failed };
};

export const syncPendingShiftJoins = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('shift_join')) {
    try {
      const payload = payloadOf(row);
      const shift = await queryFirst<{ server_id?: string | null; status?: string }>(
        'SELECT server_id, status FROM shifts WHERE id = ?', [payload.shiftId],
      );
      // A refused start never gets a server id: there is nothing to join, so the
      // join goes away instead of counting as unsent work forever.
      if (shift?.status === 'rejected') {
        await deleteOutbox(row.id, { sent: false });
        continue;
      }
      if (!shift?.server_id) continue;
      await shiftsApi.join(shift.server_id, row.author_id);
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

const HANDOVER_REPLAY_MISMATCH = 'Idempotency replay does not match the confirmed handover';

/**
 * True when the server already holds this shift's handover as confirmed. Any
 * failure to read it counts as "not confirmed", so the caller keeps the normal
 * retry path instead of trusting a guess.
 */
const handoverConfirmedOnServer = async (localShiftId: string): Promise<boolean> => {
  try {
    const local = await queryFirst<{ server_id?: string | null }>(
      'SELECT server_id FROM shifts WHERE id = ?', [localShiftId],
    );
    if (!local?.server_id) return false;
    const serverShift = await shiftsApi.getById(local.server_id);
    return serverShift?.handover_confirmed === true;
  } catch {
    return false;
  }
};

export const syncPendingShiftHandovers = async () => {
  let synced = 0;
  let failed = 0;
  // Callers need to distinguish "still queued, we are offline" from "the server
  // actively rejected this". Reporting both as "se sincronizará cuando haya
  // conexión" is a lie for the second case and leaves the operator waiting on a
  // retry that will never succeed.
  let lastError: string | null = null;
  for (const row of await rowsFor('shift_handover')) {
    try {
      const payload = payloadOf(row);
      const shift = await queryFirst<{ server_id?: string }>('SELECT server_id FROM shifts WHERE id = ?', [payload.shiftId]);
      if (shift && !shift.server_id) {
        // The shift's start has not landed on the server yet (queued, failed,
        // or blocked behind an unresolved shift). server_id is set only once
        // syncPendingShiftStarts succeeds, so this check is independent of
        // whatever later steps (e.g. finalize) do locally. This is a dependency
        // wait, not a failed operation, so keep
        // the row eligible without burning one of its three retries — and do
        // NOT count it as failed, which would inflate the "fallidos" badge for
        // work that is merely waiting on its parent.
        continue;
      }
      const serverShiftId = shift?.server_id || payload.shiftId;
      const result = await shiftsApi.confirmHandover(serverShiftId, payload.items || [], row.author_id);
      if (!result.handover_confirmed) {
        // The server did NOT confirm the handover. Never persist a
        // confirmed/synced state before verification: the old code UPDATEd
        // handover_confirmed = 1 and sync_status = 'synced' first and only then
        // threw, stranding an unconfirmed handover as if it had succeeded.
        // Treat this as a dependency wait — leave the local state untouched and
        // let the next drain retry without burning a retry or counting a
        // failure.
        continue;
      }
      await confirmShiftHandoverLocally(payload.shiftId, new Date().toISOString());
      await markShiftHandoversSynced(payload.shiftId, new Date().toISOString());
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      // OPA-11: a second submit for a shift the server already confirmed is refused
      // as a replay mismatch. The server holds the handover, so keep it confirmed
      // here instead of reverting it.
      if (message.includes(HANDOVER_REPLAY_MISMATCH) && await handoverConfirmedOnServer(row.entity_id)) {
        const now = new Date().toISOString();
        await confirmShiftHandoverLocally(row.entity_id, now);
        await markShiftHandoversSynced(row.entity_id, now);
        await deleteOutbox(row.id);
        synced += 1;
        continue;
      }
      const outcome = await recordSyncFailure(row.id, error, message);
      if (outcome === 'quarantined') {
        // W-11(b). TurnosTab wrote handover_confirmed = 1 optimistically before
        // this call. The server has now refused it for good, so that 1 is a
        // claim the app can never make true and nothing else would ever undo —
        // local said confirmed, server said false, forever.
        //
        // Quarantine, not revert: the shift_handovers rows stay. Observed
        // quantities, flagged differences and notes are real field observations
        // the operator took the trouble to record; they are re-sent verbatim on
        // the next attempt (UNIQUE (shift_id, project_material_id) makes the
        // INSERT OR REPLACE idempotent). Only the unearned confirmation goes.
        //
        // row.entity_id is the local shift id — the same value payload.shiftId
        // carries — and stays in scope even when payloadOf itself threw.
        await markShiftHandoverUnconfirmed(
          row.entity_id,
          message,
          new Date().toISOString(),
        );
        await markShiftHandoversFailed(
          row.entity_id,
          message,
          new Date().toISOString(),
        );
      }
      lastError = message;
      failed += 1;
    }
  }
  return { synced, failed, lastError };
};

export const syncPendingShiftAutoCloses = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('shift_auto_close')) {
    try {
      const payload = payloadOf(row);
      const shift = await queryFirst<{ server_id?: string }>(
        'SELECT server_id FROM shifts WHERE id = ?',
        [row.entity_id],
      );
      if (!shift?.server_id) {
        // The start is still queued. Once it lands, start_shift applies the
        // same 12-hour rule from started_at and this verification can continue.
        continue;
      }

      const serverShift = await shiftsApi.getById(shift.server_id);
      if (serverShift?.status === 'closed') {
        // Closed for good by another route, such as an admin's force-close (code read
        // S4). There is nothing left to verify, and waiting would keep the queue from
        // ever emptying, which keeps every other operator off this phone.
        await deleteOutbox(row.id, { sent: false });
        synced += 1;
        continue;
      }
      const expectedEndedAt = payload.endedAt ? new Date(payload.endedAt).getTime() : null;
      const serverEndedAt = serverShift?.ended_at ? new Date(serverShift.ended_at).getTime() : null;
      const sameEnd = expectedEndedAt === null
        || (serverEndedAt !== null && expectedEndedAt === serverEndedAt);
      if (!serverShift
          || serverShift.status === 'open'
          || serverShift.end_type !== 'auto'
          || !sameEnd) {
        // The local transition is still unknown to the server. Keep the row
        // eligible without burning a retry; a server-side reaper applies the
        // transition independently and a later drain verifies it.
        continue;
      }

      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

/**
 * Shifts that still have a bar waiting to upload, by local and server id.
 *
 * A bar's queued payload names the shift by its local id until an upload attempt
 * swaps in the server's, so both count. A bar the server refused for good goes to
 * the admin review list and holds nothing.
 */
const shiftsWithQueuedBars = async (): Promise<Set<string>> => {
  const bars = await query<{ payload_json: string }>(
    `SELECT payload_json FROM sync_outbox
     WHERE entity = 'drilling_bar' AND COALESCE(state, 'pending') <> 'quarantined'`,
  );
  const shifts = new Set<string>();
  for (const bar of bars) {
    try {
      const shiftId = JSON.parse(bar.payload_json)?.shift_id;
      if (shiftId) shifts.add(String(shiftId));
    } catch {
      // Unreadable, so it can't name a shift. It fails on its own.
    }
  }
  return shifts;
};

export const syncPendingShiftEnds = async () => {
  let synced = 0;
  let failed = 0;
  const rows = await rowsFor('shift_end');
  const withQueuedBars = rows.length > 0 ? await shiftsWithQueuedBars() : new Set<string>();
  for (const row of rows) {
    try {
      const payload = payloadOf(row);
      const shift = await queryFirst<{ server_id?: string }>('SELECT server_id FROM shifts WHERE id = ?', [payload.shiftId]);
      if (shift && !shift.server_id) {
        // Same sequencing guard as handovers: never close a shift whose start
        // has not synced yet. Checking server_id (set only once
        // syncPendingShiftStarts succeeds) instead of sync_status matters here:
        // the outbox can contain later changes while the start is still queued.
        // This branch intentionally does not increment retries:
        // it is waiting on its queued parent, not failing to close the shift.
        // It is a dependency wait, not a failure, so it is not counted as
        // failed either (that would inflate the "fallidos" badge).
        continue;
      }
      if (await handoverStillQueued(row.entity_id)) {
        // The server closes a shift only after its handover; see shiftDependencies.
        continue;
      }
      if ([row.entity_id, payload.shiftId, shift?.server_id].some((id) => id && withQueuedBars.has(id))) {
        // The next operator can start only once this close reaches the server.
        // Holding it until the shift's bars have arrived keeps the well's bars in
        // shift order, because the server numbers them as they arrive. Another
        // dependency wait: no retry is used and nothing counts as failed.
        continue;
      }
      const result = await shiftsApi.end({ ...payload, shiftId: shift?.server_id || payload.shiftId, enteredBy: row.author_id });
      await applySyncedShiftEnd({
        shiftId: row.entity_id,
        serverId: result.id,
        endedAt: result.ended_at ?? payload.deviceEndedAt,
        endType: result.end_type ?? payload.endType ?? 'manual',
        deviceTimeFlag: result.device_time_flag ? 1 : 0,
        updatedAt: new Date().toISOString(),
      });
      await execute(
        `UPDATE material_consumption SET sync_status = 'synced', last_error = NULL, updated_at = ?
         WHERE shift_id = ? AND sync_status <> 'synced'`,
        [new Date().toISOString(), row.entity_id],
      );
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      // See syncPendingShiftStarts: only a refusal belongs on the shift card.
      if (await recordSyncFailure(row.id, error, message) === 'quarantined') {
        await recordShiftSyncError(row.entity_id, message, new Date().toISOString());
      }
      failed += 1;
    }
  }
  return { synced, failed };
};

export const syncPendingPedidosV2 = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('pedido_v2')) {
    try {
      const payload = payloadOf(row);
      const result = await pedidosApi.createV2({ ...payload, enteredBy: row.author_id });
      await execute(
        `UPDATE supply_requests SET server_id = ?, pedido_number = ?, status = ?,
           sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
        [
          result.pedido.id,
          result.pedido.pedido_number ?? null,
          result.pedido.status,
          new Date().toISOString(),
          row.entity_id,
        ],
      );
      const localItems = await query<{ id: string; client_entry_id: string | null }>(
        'SELECT id, client_entry_id FROM pedido_items WHERE pedido_id = ? ORDER BY created_at, id',
        [row.entity_id],
      );
      const remoteItems = (result.items as any[]) || [];
      for (const local of localItems) {
        // Match each local item to its server row by client_entry_id, NEVER by
        // array index. The server returns items ordered by its own bigint id
        // (draft insertion order), which does not line up with the local rows'
        // (created_at, id) ordering — id is a random client_entry_id. A
        // positional match cross-assigns server_ids across items, so a later
        // receipt confirmation would decrement the WRONG material. create_pedido_v2
        // echoes client_entry_id on every returned item, so the join is stable.
        const remote = remoteItems.find(
          (candidate) => candidate?.client_entry_id != null
            && candidate.client_entry_id === local.client_entry_id,
        );
        if (remote?.id) {
          await applySyncedPedidoItem({
            id: local.id,
            serverId: remote.id,
            pedidoServerId: result.pedido.id,
            state: remote.state,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      await execute(
        `UPDATE supply_requests SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
        [message, new Date().toISOString(), row.entity_id],
      );
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

export const syncPendingPedidoReceipts = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('pedido_receipt')) {
    try {
      const payload = payloadOf(row);
      const parsedServerId = Number(payload.itemServerId)
        || Number(String(payload.localItemId || '').match(/^server_item_(\d+)$/)?.[1]);
      const item = await queryFirst<{ id: string; server_id?: number }>(
        `SELECT id, server_id FROM pedido_items
         WHERE id = ? OR server_id = ?
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        [payload.localItemId, parsedServerId || -1, payload.localItemId],
      );
      if (!item?.server_id) {
        // Dependency wait, not a failure: the parent pedido_item's own INSERT
        // has not synced yet (server_id is set only by syncPendingPedidosV2).
        // Throwing here would call markOutboxFailed and burn one of the three
        // retries while merely waiting on a parent — mirroring the shift
        // handover/end guards. Skip WITHOUT incrementing retries or the failed
        // count; the next drain retries once the item has a server_id.
        continue;
      }
      const result: any = await pedidosApi.confirmReceipt({
        itemId: item.server_id,
        clientEntryId: payload.clientEntryId,
        outcome: payload.outcome,
        quantityReceived: payload.quantityReceived,
        incidentNote: payload.incidentNote,
        enteredBy: row.author_id,
      });
      await applySyncedPedidoReceipt({
        id: row.entity_id,
        serverId: result?.receipt?.id ?? null,
        pedidoItemId: item.id,
        updatedAt: new Date().toISOString(),
      });
      await applySyncedReceiptToPedidoItem({
        id: item.id,
        state: result?.item?.state,
        receivedQuantity: result?.item?.received_quantity,
        updatedAt: new Date().toISOString(),
      });
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

/**
 * The bottle photo uploads before the sample is registered, and the server assigns
 * the sample's number only then, so the caption can't carry the final number. It
 * said just "Muestra"; the depth and the time identify the sample instead (code
 * read O10).
 */
export const waterSamplePhotoCaption = (payload: { sampleNumber?: number; depthM?: number | null; takenAt?: string }) => {
  const parts = [payload.sampleNumber ? `Muestra de agua #${payload.sampleNumber}` : 'Muestra de agua'];
  if (payload.depthM != null && Number.isFinite(Number(payload.depthM))) parts.push(`${payload.depthM} m`);
  if (payload.takenAt) parts.push(formatDisplayDateTime(payload.takenAt));
  return parts.join(' · ');
};

export const syncPendingWaterSamples = async () => {
  const rows = await rowsFor('water_sample');
  const order = await loadWaterSampleUploadOrder();
  const held = new Set<string>();
  let synced = 0;
  let failed = 0;
  // See syncPendingShiftHandovers: a server rejection must not be reported to
  // the operator as an offline condition.
  let lastError: string | null = null;
  for (const row of rows) {
    const projectId = waterSampleProjectOf(row.payload_json);
    if (projectId !== null) {
      if (held.has(projectId) || order.get(projectId)?.[0] !== row.id) {
        // An earlier sample for this well is still waiting, including one
        // cooling down after a failure that this drain did not select.
        held.add(projectId);
        continue;
      }
      held.add(projectId);
    }
    try {
      const payload = payloadOf(row);
      let photoPath = payload.bottlePhotoPath;
      if (payload.bottlePhotoLocalUri && !photoPath) {
        const uploaded = await photosApi.uploadProjectPhoto(
          payload.projectId,
          payload.bottlePhotoLocalUri,
          waterSamplePhotoCaption(payload),
          {
            clientEntryId: `${payload.clientEntryId}-bottle`,
            evidenceKind: 'water_sample',
          },
        );
        photoPath = uploaded.photo.filename;
        payload.bottlePhotoPath = photoPath;
        await execute(
          'UPDATE sync_outbox SET payload_json = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(payload), new Date().toISOString(), row.id],
        );
      }
      const result = await waterSamplesApi.register({ ...payload, bottlePhotoPath: photoPath, enteredBy: row.author_id });
      await applySyncedWaterSample({
        id: row.entity_id,
        serverId: result.id,
        sampleNumber: result.sample_number,
        bottlePhotoPath: result.bottle_photo_path ?? photoPath ?? null,
        deviceTimeFlag: result.device_time_flag ? 1 : 0,
        updatedAt: new Date().toISOString(),
      });
      await deleteOutbox(row.id);
      if (projectId !== null) {
        order.get(projectId)?.shift();
        held.delete(projectId);
      }
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      console.warn('[PHC] Water sample sync failed:', message);
      await recordWaterSampleSyncError(
        row.entity_id,
        message,
        new Date().toISOString(),
      );
      await recordSyncFailure(row.id, error, message);
      lastError = message;
      failed += 1;
    }
  }
  return { synced, failed, lastError };
};

const hasQueuedProjectWork = async (projectId: number): Promise<boolean> => {
  const rows = await query<{ entity: string; entity_id: string; payload_json: string }>(
    `SELECT entity, entity_id, payload_json FROM sync_outbox
     WHERE entity IN (
       'drilling_bar', 'shift_start', 'shift_handover', 'shift_auto_close', 'shift_end',
       'water_sample', 'material_consumption', 'pedido_receipt'
     )
       AND COALESCE(state, 'pending') <> 'quarantined'`,
  );

  for (const row of rows) {
    let payload: any;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }

    const directProjectId = Number(payload?.projectId ?? payload?.project_id);
    if (Number.isFinite(directProjectId) && directProjectId === projectId) return true;

    if (row.entity.startsWith('shift_')) {
      const shiftId = payload?.shiftId || row.entity_id;
      const shift = await queryFirst<{ project_id: number }>(
        'SELECT project_id FROM shifts WHERE id = ?',
        [shiftId],
      );
      if (Number(shift?.project_id) === projectId) return true;
    }

    if (row.entity === 'pedido_receipt') {
      const receipt = await queryFirst<{ project_id: number }>(
        `SELECT sr.project_id
         FROM pedido_receipts pr
         JOIN pedido_items pi ON pi.id = pr.pedido_item_id
         JOIN supply_requests sr ON sr.id = pi.pedido_id OR sr.server_id = pi.pedido_server_id
         WHERE pr.id = ?
         LIMIT 1`,
        [row.entity_id],
      );
      if (Number(receipt?.project_id) === projectId) return true;
    }
  }
  return false;
};

export const syncPendingCompletionsV2 = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('completion_v2')) {
    try {
      const payload = payloadOf(row);
      if (await hasQueuedProjectWork(Number(payload.projectId))) {
        // Keep the Ficha queued until all of this well's field work has landed.
        // This includes rows in cooldown, but excludes work already in admin review.
        continue;
      }
      const result: any = await completionApi.submitV2({ ...payload, enteredBy: row.author_id });
      const acceptedAt = new Date().toISOString();
      await execute(
        `UPDATE completion_reports_local
         SET server_id = ?, status = ?, submitted_at = ?, sync_status = 'synced',
             last_error = NULL, updated_at = ? WHERE id = ?`,
        [
          result?.data?.id ?? null,
          result?.data?.status ?? 'submitted',
          result?.data?.submitted_at ?? acceptedAt,
          acceptedAt,
          row.entity_id,
        ],
      );
      // The well leaves the field pickers only once the server has the Ficha. Set
      // on the phone before that, a refused Ficha left the well hidden until the
      // next server refresh.
      await execute(
        `UPDATE projects SET status = 'closure_submitted', updated_at = ? WHERE id = ?`,
        [acceptedAt, payload.projectId],
      );
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      await execute(
        `UPDATE completion_reports_local
         SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
        [message, new Date().toISOString(), row.entity_id],
      );
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

export const syncPendingCompletionResubmissions = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('completion_v2_resubmit')) {
    let reportId: number | undefined;
    try {
      const payload = payloadOf(row);
      reportId = Number(payload.reportId);
      const result: any = await completionApi.resubmitV2({ ...payload, enteredBy: row.author_id });
      await execute(
        `UPDATE completion_reports_local
         SET server_id = ?, status = ?, submitted_at = ?, sync_status = 'synced',
             last_error = NULL, updated_at = ? WHERE server_id = ?`,
        [
          result?.data?.id ?? payload.reportId,
          result?.data?.status ?? 'submitted',
          result?.data?.submitted_at ?? new Date().toISOString(),
          new Date().toISOString(),
          reportId,
        ],
      );
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      // Key on the specific report (server_id) rather than project_id: a
      // project can have more than one completion report row, and marking them
      // all synced/failed on a single resubmission would corrupt the others.
      if (Number.isFinite(reportId)) {
        await execute(
          `UPDATE completion_reports_local
           SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE server_id = ?`,
          [message, new Date().toISOString(), reportId],
        );
      }
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

export const syncPendingCompletionDiscrepancies = async () => {
  let synced = 0;
  let failed = 0;
  for (const row of await rowsFor('completion_discrepancy')) {
    try {
      await completionApi.reportDiscrepancy(payloadOf(row));
      await deleteOutbox(row.id);
      synced += 1;
    } catch (error) {
      const message = messageOf(error);
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }
  return { synced, failed };
};

export const syncProductV2PreWork = async () => {
  const starts = await syncPendingShiftStarts();
  const joins = await syncPendingShiftJoins();
  await releaseWorkBehindRejectedStarts();
  await reconcileServerClosedShifts().catch(() => 0);
  const handovers = await syncPendingShiftHandovers();
  const autoCloses = await syncPendingShiftAutoCloses();
  return {
    synced: starts.synced + joins.synced + handovers.synced + autoCloses.synced,
    failed: starts.failed + joins.failed + handovers.failed + autoCloses.failed,
  };
};

export const syncProductV2PostWork = async () => {
  const results = [];
  results.push(await syncPendingShiftEnds());
  results.push(await syncPendingPedidosV2());
  results.push(await syncPendingPedidoReceipts());
  results.push(await syncPendingWaterSamples());
  results.push(await syncPendingCompletionDiscrepancies());
  results.push(await syncPendingCompletionsV2());
  results.push(await syncPendingCompletionResubmissions());
  return results.reduce(
    (total, result) => ({ synced: total.synced + result.synced, failed: total.failed + result.failed }),
    { synced: 0, failed: 0 },
  );
};
