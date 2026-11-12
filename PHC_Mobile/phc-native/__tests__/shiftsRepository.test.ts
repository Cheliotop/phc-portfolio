const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import {
  applySyncedShiftEnd,
  applySyncedShiftStart,
  confirmShiftHandoverLocally,
  markShiftHandoversFailed,
  markShiftHandoversSynced,
  markShiftHandoverUnconfirmed,
  markShiftPendingReport,
  mirrorUnresolvedShift,
  recordLocalShiftEnd,
  recordShiftSyncError,
  upsertShiftHandover,
} from '../src/db/repositories/shifts';

describe('shifts and shift_handovers repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  it('records the 12-hour auto-close without maintaining legacy shifts.sync_status', async () => {
    await markShiftPendingReport(
      'shift-1',
      '2026-07-26T12:00:00.000Z',
      '2026-07-26T12:00:01.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts
         SET status = 'report_pending', ended_at = ?, end_type = 'auto',
             device_time_flag = 1, updated_at = ?
         WHERE id = ?`,
      ['2026-07-26T12:00:00.000Z', '2026-07-26T12:00:01.000Z', 'shift-1'],
    );
    expect(String(mockExecute.mock.calls[0][0])).not.toContain('sync_status');
  });

  it('mirrors an unresolved server shift with the existing fallbacks', async () => {
    await mirrorUnresolvedShift(
      {
        id: 'server-shift',
        client_entry_id: null,
        project_id: 21,
        operator_id: 'operator-1',
        status: 'open',
        started_at: '2026-07-26T08:00:00.000Z',
        ended_at: null,
        start_device_time: null,
        end_device_time: null,
        end_type: null,
        usage_report_submitted: false,
        handover_confirmed: false,
        device_time_flag: false,
        notes: null,
      },
      '2026-07-26T12:00:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT OR REPLACE INTO shifts (
                   id, server_id, client_entry_id, project_id, operator_id, status,
                   started_at, ended_at, start_device_time, end_device_time, end_type,
                   usage_report_submitted, handover_confirmed, device_time_flag, notes,
                   last_error, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        'server-shift',
        'server-shift',
        null,
        21,
        'operator-1',
        'open',
        '2026-07-26T08:00:00.000Z',
        null,
        null,
        null,
        null,
        0,
        0,
        0,
        null,
        '2026-07-26T08:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );
  });

  it('upserts a handover retry with the existing insert parameters', async () => {
    await upsertShiftHandover({
      id: 'handover-local-1',
      clientEntryId: 'handover-client-1',
      shiftId: 'shift-1',
      projectMaterialId: 73,
      status: 'flagged',
      expectedQuantity: 10,
      observedQuantity: 9,
      note: 'Falta uno',
      confirmedBy: 'operator-1',
      now: '2026-07-26T12:00:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO shift_handovers (
               id, client_entry_id, shift_id, project_material_id, status,
               expected_quantity, observed_quantity, note, confirmed_by,
               sync_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT(shift_id, project_material_id) DO UPDATE SET
               status = excluded.status,
               expected_quantity = excluded.expected_quantity,
               observed_quantity = excluded.observed_quantity,
               note = excluded.note,
               confirmed_by = excluded.confirmed_by,
               sync_status = excluded.sync_status,
               updated_at = excluded.updated_at,
               last_error = NULL`,
      [
        'handover-local-1',
        'handover-client-1',
        'shift-1',
        73,
        'flagged',
        10,
        9,
        'Falta uno',
        'operator-1',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );
  });

  it('preserves photo_path, server_id, and identity fields on handover conflict', async () => {
    await upsertShiftHandover({
      id: 'handover-local-1',
      clientEntryId: 'handover-client-1',
      shiftId: 'shift-1',
      projectMaterialId: 73,
      status: 'confirmed',
      expectedQuantity: 10,
      observedQuantity: null,
      note: null,
      confirmedBy: 'operator-1',
      now: '2026-07-26T12:00:00.000Z',
    });

    const sql = String(mockExecute.mock.calls[0][0]);
    const conflictUpdate = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(conflictUpdate).not.toMatch(
      /\b(id|client_entry_id|server_id|photo_path|created_at)\s*=/,
    );
  });

  it('clears stale last_error explicitly on handover conflict', async () => {
    await upsertShiftHandover({
      id: 'handover-local-1',
      clientEntryId: 'handover-client-1',
      shiftId: 'shift-1',
      projectMaterialId: 73,
      status: 'confirmed',
      expectedQuantity: 10,
      observedQuantity: null,
      note: null,
      confirmedBy: 'operator-1',
      now: '2026-07-26T12:00:00.000Z',
    });

    const sql = String(mockExecute.mock.calls[0][0]);
    const conflictUpdate = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(conflictUpdate).toContain('last_error = NULL');
  });

  it('marks the shift handover confirmed', async () => {
    await confirmShiftHandoverLocally('shift-1', '2026-07-26T12:00:00.000Z');

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts SET handover_confirmed = 1, updated_at = ? WHERE id = ?`,
      ['2026-07-26T12:00:00.000Z', 'shift-1'],
    );
  });

  it('records the local shift end without closing it prematurely', async () => {
    await recordLocalShiftEnd({
      shiftId: 'shift-1',
      endedAt: '2026-07-26T18:00:00.000Z',
      deviceEndedAt: '2026-07-26T18:00:01.000Z',
      endType: 'manual',
      notes: null,
      updatedAt: '2026-07-26T18:00:01.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts
           SET ended_at = ?, end_device_time = ?, end_type = ?,
               usage_report_submitted = 1, notes = ?, updated_at = ?
           WHERE id = ?`,
      [
        '2026-07-26T18:00:00.000Z',
        '2026-07-26T18:00:01.000Z',
        'manual',
        null,
        '2026-07-26T18:00:01.000Z',
        'shift-1',
      ],
    );
  });

  it('records a shift sync error', async () => {
    await recordShiftSyncError('shift-1', 'Sin conexión', '2026-07-26T12:00:00.000Z');

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts SET last_error = ?, updated_at = ? WHERE id = ?`,
      ['Sin conexión', '2026-07-26T12:00:00.000Z', 'shift-1'],
    );
  });

  it('applies a successful shift start response', async () => {
    await applySyncedShiftStart({
      shiftId: 'shift-1',
      serverId: 'shift-1',
      status: 'open',
      startedAt: '2026-07-26T08:00:00.000Z',
      endedAt: null,
      endType: null,
      deviceTimeFlag: 0,
      updatedAt: '2026-07-26T12:00:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts SET server_id = ?, status = ?, started_at = ?, ended_at = ?,
           end_type = ?, device_time_flag = ?,
           last_error = NULL, updated_at = ? WHERE id = ?`,
      [
        'shift-1',
        'open',
        '2026-07-26T08:00:00.000Z',
        null,
        null,
        0,
        '2026-07-26T12:00:00.000Z',
        'shift-1',
      ],
    );
  });

  it('marks handover rows synced', async () => {
    await markShiftHandoversSynced('shift-1', '2026-07-26T12:00:00.000Z');

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shift_handovers SET sync_status = 'synced', last_error = NULL, updated_at = ? WHERE shift_id = ?`,
      ['2026-07-26T12:00:00.000Z', 'shift-1'],
    );
  });

  it('reverts an unearned local handover confirmation', async () => {
    await markShiftHandoverUnconfirmed(
      'shift-1',
      'Rechazado',
      '2026-07-26T12:00:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts SET handover_confirmed = 0, last_error = ?, updated_at = ? WHERE id = ?`,
      ['Rechazado', '2026-07-26T12:00:00.000Z', 'shift-1'],
    );
  });

  it('marks handover rows failed', async () => {
    await markShiftHandoversFailed('shift-1', 'Rechazado', '2026-07-26T12:00:00.000Z');

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shift_handovers SET sync_status = 'failed', last_error = ?, updated_at = ?
           WHERE shift_id = ?`,
      ['Rechazado', '2026-07-26T12:00:00.000Z', 'shift-1'],
    );
  });

  it('applies a successful server-authoritative shift end', async () => {
    await applySyncedShiftEnd({
      shiftId: 'shift-1',
      serverId: 'shift-1',
      endedAt: '2026-07-26T18:00:00.000Z',
      endType: 'manual',
      deviceTimeFlag: 0,
      updatedAt: '2026-07-26T18:00:01.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `UPDATE shifts SET server_id = ?, status = 'closed', ended_at = ?, end_type = ?,
           usage_report_submitted = 1, device_time_flag = ?,
           last_error = NULL, updated_at = ? WHERE id = ?`,
      [
        'shift-1',
        '2026-07-26T18:00:00.000Z',
        'manual',
        0,
        '2026-07-26T18:00:01.000Z',
        'shift-1',
      ],
    );
  });
});
