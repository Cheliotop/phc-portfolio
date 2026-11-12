import { execute, query, queryFirst } from '../db/db';
import { deleteOutbox, selectDrainableOutboxRows, type DrainableOutboxRow } from '../db/operations';
import { recordSyncFailure } from './rejection';
import { handoverStillQueued } from './shiftDependencies';
import { drillingBarsApi } from '../api/supabase-drilling-bars';
import { photosApi } from '../api/supabase-photos';
import { LocalPhotoMissingError } from '../api/photoErrors';
import { errorMessage } from '../utils/errorMessage';
import {
  applySyncedDrillingBar,
  recordDrillingBarSyncError,
  updateDrillingBarPhotoPaths,
} from '../db/repositories/drillingBars';

const parsePayload = (row: DrainableOutboxRow) => {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    throw new Error('Invalid queued drilling bar payload');
  }
};

const parsePhotoPaths = (value: any): any[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [value];
};

const isLocalPhotoUri = (photo: any): photo is string =>
  typeof photo === 'string' &&
  (photo.startsWith('file://') ||
    photo.startsWith('content://') ||
    photo.startsWith('asset-library://'));

const uploadPendingPhotos = async (payload: any) => {
  const photos = parsePhotoPaths(payload.photo_paths);
  if (!photos.length) return payload;

  const uploadedPhotos = [];
  let missing = 0;
  for (const [index, photo] of photos.entries()) {
    if (!isLocalPhotoUri(photo)) {
      uploadedPhotos.push(photo);
      continue;
    }

    let response;
    try {
      response = await photosApi.uploadProjectPhoto(
        Number(payload.project_id),
        photo,
        `Barra ${payload.bar_number || ''}`.trim(),
        {
          clientEntryId: `${payload.client_entry_id || 'bar'}-photo-${index + 1}`,
          shiftId: payload.shift_id || undefined,
        },
      );
    } catch (error) {
      // Android can clear the camera's cache folder while a bar waits offline. The
      // photo is gone for good, and retrying would hold this bar, every later bar on
      // the well and the shift's close forever. The bar itself still happened.
      if (!(error instanceof LocalPhotoMissingError)) throw error;
      missing += 1;
      continue;
    }

    // Only the server's reference is kept. Signed URLs expire after an hour and
    // the device path means nothing to the server.
    uploadedPhotos.push({
      id: response.photo?.id,
      filename: response.photo?.filename,
    });
  }

  if (missing === 0) {
    return { ...payload, photo_paths: uploadedPhotos };
  }
  const notice = missing === 1
    ? '[1 foto se perdió en este dispositivo antes de subir]'
    : `[${missing} fotos se perdieron en este dispositivo antes de subir]`;
  return {
    ...payload,
    photo_paths: uploadedPhotos,
    notes: [payload.notes, notice].filter((part) => typeof part === 'string' && part.trim()).join(' '),
  };
};

/**
 * Queued bars per well, in the order they were recorded.
 *
 * The server numbers a bar and works out its depth when it arrives, so an earlier
 * bar that uploads after a later one ends up deeper, and its soil type and water
 * level land at the wrong depth. Total depth stays right, which hides the error.
 * A bar may go only when no earlier bar of its well is still waiting, including one
 * cooling down after a failure that this drain did not select. Bars the server
 * refused for good are left out: they go to the admin review list instead.
 */
const loadUploadOrder = async (): Promise<Map<string, string[]>> => {
  const queued = await query<{ id: string; payload_json: string }>(
    `SELECT id, payload_json FROM sync_outbox
     WHERE entity = 'drilling_bar' AND COALESCE(state, 'pending') <> 'quarantined'
     ORDER BY created_at ASC, rowid ASC`,
  );
  const order = new Map<string, string[]>();
  for (const row of queued) {
    const well = wellOf(row);
    // A payload that can't be read can't hold anything back. It fails on its own.
    if (well === null) continue;
    order.set(well, [...(order.get(well) ?? []), row.id]);
  }
  return order;
};

const wellOf = (row: { payload_json: string }): string | null => {
  try {
    const projectId = JSON.parse(row.payload_json)?.project_id;
    return projectId === undefined || projectId === null ? null : String(projectId);
  } catch {
    return null;
  }
};

export const syncPendingDrillingBars = async (): Promise<{ synced: number; failed: number }> => {
  const rows = await selectDrainableOutboxRows('drilling_bar');
  const order = await loadUploadOrder();
  // Wells whose next bar can't go in this drain. Their later bars wait too.
  const held = new Set<string>();

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    const well = wellOf(row);
    if (well !== null) {
      if (held.has(well) || order.get(well)?.[0] !== row.id) {
        // An earlier bar of this well is still waiting. Not a failure, so no retry
        // is used and nothing counts as failed.
        held.add(well);
        continue;
      }
      // Until this bar has uploaded, the ones after it wait. A success below
      // releases the next one.
      held.add(well);
    }
    try {
      let queued = parsePayload(row);
      if (queued.shift_id) {
        const localShiftId = String(queued.shift_id);
        const shift = await queryFirst<{ server_id?: string | null }>(
          'SELECT server_id FROM shifts WHERE id = ?',
          [localShiftId],
        );
        if (shift?.server_id) {
          // Everything from here talks to the server, so it must use the
          // server's id for the shift. The local one is meaningless remotely,
          // and the photos INSERT policy proves it the hard way: it requires
          // EXISTS (SELECT 1 FROM shifts WHERE id = photos.shift_id ...), so a
          // local id makes the row unmatchable and the write comes back as
          // "new row violates row-level security policy" — a permanent
          // rejection, which quarantines a bar the operator recorded correctly.
          //
          // The wait below already established that the parent exists remotely.
          // It just never carried the id it had gone to the trouble of proving.
          queued = { ...queued, shift_id: shift.server_id };
        }
        if (shift?.server_id && await handoverStillQueued(localShiftId)) {
          // Same kind of wait: the server takes a shift's bars only after its
          // handover. The well's later bars wait behind this one.
          continue;
        }
        if (shift && !shift.server_id) {
          // The bar's shift has not landed on the server yet (its start syncs
          // in an earlier phase). server_id is the durable evidence that the
          // parent exists remotely. Skip without
          // burning a retry until that is true. This is a dependency wait, not
          // a failure, so it is not counted as failed either (that would
          // inflate the "fallidos" badge for a bar that is merely waiting).
          continue;
        }
      }
      const payload = await uploadPendingPhotos(queued);

      await updateDrillingBarPhotoPaths(
        row.entity_id,
        JSON.stringify(payload.photo_paths || []),
        new Date().toISOString(),
      );

      await execute(
        `UPDATE sync_outbox
         SET payload_json = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(payload), new Date().toISOString(), row.id]
      );

      const response = await drillingBarsApi.create(payload, row.author_id ?? null);
      const serverId = response.data?.id || null;

      await applySyncedDrillingBar({
        id: row.entity_id,
        serverId,
        barNumber: response.data?.bar_number ?? null,
        depthStart: response.data?.depth_start ?? null,
        depthEnd: response.data?.depth_end ?? null,
        length: response.data?.length ?? null,
        updatedAt: new Date().toISOString(),
      });

      await deleteOutbox(row.id);
      if (well !== null) {
        order.get(well)?.shift();
        held.delete(well);
      }
      synced += 1;
    } catch (error: any) {
      const message = errorMessage(error);
      await recordDrillingBarSyncError(
        row.entity_id,
        message,
        new Date().toISOString(),
      );
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }

  return { synced, failed };
};
