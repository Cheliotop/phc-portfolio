const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import {
  applySyncedWaterSample,
  createLocalWaterSample,
  recordWaterSampleSyncError,
} from '../src/db/repositories/waterSamples';

describe('water_samples repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  it('creates a local sample without putting its local photo URI in the server path column', async () => {
    await createLocalWaterSample({
      id: 'water_sample_local_1',
      clientEntryId: 'water_sample_1',
      projectId: 21,
      sampleNumber: 4,
      depthM: 125.5,
      stage: 'Perforación',
      operatorId: 'operator-1',
      notes: 'Agua clara',
      takenAt: '2026-07-26T12:00:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO water_samples (
             id, client_entry_id, project_id, sample_number, depth_m, stage,
             operator_id, notes, bottle_photo_path, taken_at, timestamp_local,
             device_time_flag, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 'pending', ?, ?)`,
      [
        'water_sample_local_1',
        'water_sample_1',
        21,
        4,
        125.5,
        'Perforación',
        'operator-1',
        'Agua clara',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );
  });

  it('applies the server identity and canonical sample fields without replacing the local row', async () => {
    await applySyncedWaterSample({
      id: 'water_sample_local_1',
      serverId: 74,
      sampleNumber: 5,
      bottlePhotoPath: 'water-samples/21/bottle.jpg',
      deviceTimeFlag: 1,
      updatedAt: '2026-07-26T12:01:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE water_samples SET server_id = ?, sample_number = ?, bottle_photo_path = ?,
           device_time_flag = ?, sync_status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?`,
      [
        74,
        5,
        'water-samples/21/bottle.jpg',
        1,
        '2026-07-26T12:01:00.000Z',
        'water_sample_local_1',
      ],
    );
  });

  it('records a synchronization failure without touching sample or photo data', async () => {
    await recordWaterSampleSyncError(
      'water_sample_local_1',
      'Storage unavailable',
      '2026-07-26T12:02:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE water_samples SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      [
        'Storage unavailable',
        '2026-07-26T12:02:00.000Z',
        'water_sample_local_1',
      ],
    );
  });
});
