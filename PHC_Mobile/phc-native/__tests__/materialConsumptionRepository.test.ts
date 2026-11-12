const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import { mirrorMaterialConsumption } from '../src/db/repositories/materialConsumption';

/**
 * Guards the material-consumption identity inversion found during Task 3.
 * Server ids belong in `server_id`; using one as the local autoincrement `id`
 * let an admin refresh replace an unrelated offline row and destroy its local
 * idempotency, shift, reconciliation and audit state.
 */
describe('material_consumption local mirror', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  const serverRow = {
    id: 73,
    project_id: 21,
    operator_id: 'operator-1',
    material_name: 'Bentonita',
    quantity_used: 2.5,
    unit: 'kg',
    date: '2026-07-25',
    notes: 'Consumo del turno',
    created_at: '2026-07-25T18:30:00.000Z',
  };

  it('writes the server identity into server_id and never writes local id', async () => {
    await mirrorMaterialConsumption(serverRow, '2026-07-26T12:00:00.000Z');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO material_consumption (
       server_id, project_id, operator_id, material_name, quantity_used,
       unit, date, notes, created_at, updated_at, sync_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(server_id) WHERE server_id IS NOT NULL DO UPDATE SET
       project_id = excluded.project_id,
       operator_id = excluded.operator_id,
       material_name = excluded.material_name,
       quantity_used = excluded.quantity_used,
       unit = excluded.unit,
       date = excluded.date,
       notes = excluded.notes,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
      [
        73,
        21,
        'operator-1',
        'Bentonita',
        2.5,
        'kg',
        '2026-07-25',
        'Consumo del turno',
        '2026-07-25T18:30:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );

    const sql = String(mockExecute.mock.calls[0][0]);
    const insertColumns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(') VALUES'));
    expect(insertColumns).toContain('server_id');
    expect(insertColumns).not.toMatch(/(^|,)\s*id\s*(,|$)/m);
  });

  it('updates the existing row when the partial server_id key conflicts', async () => {
    await mirrorMaterialConsumption(serverRow);

    const sql = String(mockExecute.mock.calls[0][0]);
    expect(sql).toContain(
      'ON CONFLICT(server_id) WHERE server_id IS NOT NULL DO UPDATE SET',
    );
  });

  it('preserves every locally-owned field in the conflict update', async () => {
    await mirrorMaterialConsumption(serverRow);

    const sql = String(mockExecute.mock.calls[0][0]);
    const conflictUpdate = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(conflictUpdate).not.toMatch(
      /\b(client_entry_id|shift_id|project_material_id|approximate|anomaly_flag|sync_status|last_error)\b/,
    );
  });

  it('binds non-null fallbacks when the server returns null unit and date', async () => {
    await mirrorMaterialConsumption(
      {
        ...serverRow,
        unit: null,
        date: null,
        notes: null,
        created_at: null,
      },
      '2026-07-26T12:00:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      expect.any(String),
      [
        73,
        21,
        'operator-1',
        'Bentonita',
        2.5,
        '',
        '2026-07-26',
        null,
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );
  });
});
