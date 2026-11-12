import { execute } from '../index';

/**
 * The ONE place that writes local `water_samples` rows.
 *
 * Why this module exists
 * ---------------------
 * W-10 proved that duplicated writes can silently erase omitted columns. Water
 * samples carry both local identity/sync state and photo evidence: the local
 * file URI belongs to `project_attachments`, while `bottle_photo_path` becomes
 * the uploaded server path. Keeping creation and targeted sync updates here
 * prevents a future mirror or retry from replacing either identity or evidence.
 */

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

export interface LocalWaterSample {
  id: string;
  clientEntryId: string;
  projectId: number;
  sampleNumber: number;
  depthM: number | null;
  stage: string | null;
  operatorId: string;
  notes: string | null;
  takenAt: string;
}

export interface SyncedWaterSample {
  id: string;
  serverId: number;
  sampleNumber: number;
  bottlePhotoPath: string | null;
  deviceTimeFlag: number;
  updatedAt: string;
}

/** Create the locally-owned sample before its outbox intent is queued. */
export const createLocalWaterSample = async (
  sample: LocalWaterSample,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO water_samples (
             id, client_entry_id, project_id, sample_number, depth_m, stage,
             operator_id, notes, bottle_photo_path, taken_at, timestamp_local,
             device_time_flag, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 'pending', ?, ?)`,
    [
      sample.id,
      sample.clientEntryId,
      sample.projectId,
      sample.sampleNumber,
      sample.depthM,
      sample.stage,
      sample.operatorId,
      sample.notes,
      sample.takenAt,
      sample.takenAt,
      sample.takenAt,
      sample.takenAt,
    ],
  );
};

/** Apply server identity and canonical fields without replacing local state. */
export const applySyncedWaterSample = async (
  sample: SyncedWaterSample,
  exec: SqlExecutor = execute,
): Promise<void> => {
  if (sample.sampleNumber !== null && sample.sampleNumber !== undefined) {
    // Offline samples have provisional local numbers. The server number wins,
    // even when another queued sample currently holds it locally.
    await exec(
      `UPDATE water_samples
         SET sample_number = (SELECT MAX(w.sample_number) + 1 FROM water_samples w
                              WHERE w.project_id = water_samples.project_id)
       WHERE server_id IS NULL
         AND sample_number = ?
         AND id <> ?
         AND project_id = (SELECT project_id FROM water_samples WHERE id = ?)`,
      [sample.sampleNumber, sample.id, sample.id],
    );
  }
  await exec(
    `UPDATE water_samples SET server_id = ?, sample_number = ?, bottle_photo_path = ?,
           device_time_flag = ?, sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
    [
      sample.serverId,
      sample.sampleNumber,
      sample.bottlePhotoPath,
      sample.deviceTimeFlag,
      sample.updatedAt,
      sample.id,
    ],
  );
};

/** Preserve a rejected sample and its evidence for a later retry. */
export const recordWaterSampleSyncError = async (
  id: string,
  message: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE water_samples SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
    [message, updatedAt, id],
  );
};
