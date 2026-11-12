const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import { insertSupplyRequest } from '../src/db/repositories/supplyRequests';

/**
 * Guards the dual-identity boundary on `supply_requests`. Local creations must
 * receive SQLite's autoincrement `id`, retain their `client_entry_id`, and leave
 * `server_id` empty until upload. Writing either server identity into local
 * `id`, or replacing this row with a partial server copy, could destroy the
 * idempotency key and orphan its pedido items and queued sync intent.
 */
describe('supply_requests local repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ lastInsertRowId: 18, changes: 1 });
  });

  const localRow = {
    client_entry_id: 'pedido-client-1',
    project_id: 21,
    operator_id: 'operator-1',
    material: '2 ítems',
    quantity: 7.5,
    priority: 'Alta',
    reason: 'Hace falta en obra',
    needed_by: '2026-07-30',
    job_site: 'Pozo San Isidro',
    pedido_type: 'empresa',
    notes: 'Entregar por la mañana',
    kind: 'empresa',
    justification: 'Material no asignado',
    created_at: '2026-07-26T12:00:00.000Z',
    updated_at: '2026-07-26T12:00:00.000Z',
  };

  it('emits the existing local insert and full parameter array verbatim', async () => {
    const result = await insertSupplyRequest(localRow);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO supply_requests (
             client_entry_id, project_id, operator_id, material, quantity, priority,
             reason, needed_by, job_site, pedido_type, notes, status, kind,
             justification, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?, 'pending', ?, ?)`,
      [
        'pedido-client-1',
        21,
        'operator-1',
        '2 ítems',
        7.5,
        'Alta',
        'Hace falta en obra',
        '2026-07-30',
        'Pozo San Isidro',
        'empresa',
        'Entregar por la mañana',
        'empresa',
        'Material no asignado',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );
    expect(result).toEqual({ lastInsertRowId: 18, changes: 1 });
  });

  it('lets SQLite generate local id and never writes server_id', async () => {
    await insertSupplyRequest(localRow);

    const sql = String(mockExecute.mock.calls[0][0]);
    const insertColumns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(') VALUES'));
    expect(insertColumns).toContain('client_entry_id');
    expect(insertColumns).not.toMatch(/(^|,)\s*id\s*(,|$)/m);
    expect(insertColumns).not.toContain('server_id');
    expect(sql).toContain('INSERT INTO supply_requests');
    expect(sql).not.toContain('INSERT OR REPLACE');
  });

  it('uses a caller-supplied executor so the insert stays in its transaction', async () => {
    const transactionExecute = jest.fn().mockResolvedValue({
      lastInsertRowId: 42,
      changes: 1,
    });

    const result = await insertSupplyRequest(localRow, transactionExecute);

    expect(transactionExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.lastInsertRowId).toBe(42);
  });
});
