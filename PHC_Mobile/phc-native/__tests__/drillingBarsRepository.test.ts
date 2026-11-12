const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import {
  applySyncedDrillingBar,
  createLocalDrillingBar,
  mirrorServerDrillingBar,
  recordDrillingBarSyncError,
  updateDrillingBarPhotoPaths,
} from '../src/db/repositories/drillingBars';

describe('drilling_bar_entries repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  it('creates one locally-owned bar with its exact number and depth chain', async () => {
    await createLocalDrillingBar({
      id: 'bar-local-1',
      projectId: '21',
      operatorId: 'operator-1',
      shiftId: 'shift-local-1',
      barNumber: 8,
      depthStart: 21,
      depthEnd: 24,
      length: 3,
      diameter: '3 pulgadas',
      soilType: 'Arcilla',
      startTime: '08:15',
      endTime: '08:45',
      durationMinutes: 30,
      waterLevel: 12.5,
      notes: 'Sin incidentes',
      photoPaths: '["file://bar.jpg"]',
      timestampLocal: '2026-07-26T12:00:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO drilling_bar_entries (
            id, project_id, operator_id, shift_id, bar_number, depth_start, depth_end,
            length, diameter, soil_type, start_time, end_time, duration_minutes,
            water_level, notes, photo_paths, timestamp_local, sync_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        'bar-local-1', '21', 'operator-1', 'shift-local-1', 8,
        21, 24, 3, '3 pulgadas', 'Arcilla', '08:15', '08:45', 30, 12.5,
        'Sin incidentes', '["file://bar.jpg"]', '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z', '2026-07-26T12:00:00.000Z',
      ],
    );
  });

  it('mirrors one server bar without replacing a conflicting local row', async () => {
    await mirrorServerDrillingBar({
      id: 487,
      client_entry_id: 'bar-local-1',
      project_id: 21,
      operator_id: 'operator-1',
      shift_id: 'shift-server-1',
      bar_number: 8,
      depth_start: 21,
      depth_end: 24,
      length: 3,
      diameter: '3 pulgadas',
      soil_type: 'Arcilla',
      start_time: '08:15',
      end_time: '08:45',
      duration_minutes: 30,
      water_level: 12.5,
      notes: 'Sin incidentes',
      photo_paths: '["phc-photos/bar.jpg"]',
      timestamp_local: '2026-07-26T12:00:00.000Z',
      created_at: '2026-07-26T12:01:00.000Z',
      updated_at: '2026-07-26T12:02:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT OR IGNORE INTO drilling_bar_entries (
          id, server_id, project_id, operator_id, shift_id, bar_number, depth_start,
          depth_end, length, diameter, soil_type, start_time, end_time,
          duration_minutes, water_level, notes, photo_paths, timestamp_local,
          sync_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
      [
        'bar-local-1',
        487,
        21,
        'operator-1',
        'shift-server-1',
        8,
        21,
        24,
        3,
        '3 pulgadas',
        'Arcilla',
        '08:15',
        '08:45',
        30,
        12.5,
        'Sin incidentes',
        '["phc-photos/bar.jpg"]',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:01:00.000Z',
        '2026-07-26T12:02:00.000Z',
      ],
    );
  });

  it('stores uploaded photo paths without changing bar measurements', async () => {
    await updateDrillingBarPhotoPaths(
      'bar-local-1',
      '["phc-photos/bar.jpg"]',
      '2026-07-26T12:03:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE drilling_bar_entries
         SET photo_paths = ?, updated_at = ?
         WHERE id = ?`,
      [
        '["phc-photos/bar.jpg"]',
        '2026-07-26T12:03:00.000Z',
        'bar-local-1',
      ],
    );
  });

  it('applies the canonical server number and depth without replacing the row', async () => {
    await applySyncedDrillingBar({
      id: 'bar-local-1',
      serverId: 487,
      barNumber: 9,
      depthStart: 24,
      depthEnd: 27,
      length: 3,
      updatedAt: '2026-07-26T12:04:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE drilling_bar_entries
         SET sync_status = 'synced',
             server_id = ?,
             bar_number = COALESCE(?, bar_number),
             depth_start = COALESCE(?, depth_start),
             depth_end = COALESCE(?, depth_end),
             length = COALESCE(?, length),
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      [
        487,
        9,
        24,
        27,
        3,
        '2026-07-26T12:04:00.000Z',
        'bar-local-1',
      ],
    );
  });

  it('records a synchronization failure without touching bar number or depth', async () => {
    await recordDrillingBarSyncError(
      'bar-local-1',
      'Sin conexión',
      '2026-07-26T12:05:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE drilling_bar_entries
         SET sync_status = 'failed', last_error = ?, updated_at = ?
         WHERE id = ?`,
      ['Sin conexión', '2026-07-26T12:05:00.000Z', 'bar-local-1'],
    );
  });
});
