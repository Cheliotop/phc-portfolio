const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import { insertCompletionReport } from '../src/db/repositories/completionReports';

/**
 * Guards the dual-identity and closure-state boundary on
 * `completion_reports_local`. Local creation must retain its client-generated
 * idempotency identity and pending submission state until the server
 * acknowledges it; replacement by a partial mirror could corrupt a billing
 * and legal artifact.
 */
describe('completion_reports_local repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  const localRow = {
    id: 'completion-v2-1',
    client_entry_id: 'completion-v2-1',
    project_id: 21,
    operator_id: 'operator-1',
    static_level: 18.5,
    dynamic_level: 24,
    flow_rate: 2400,
    specific_flow_rate: 436.36,
    maximum_flow_rate: 3000,
    pump_depth_m: 42,
    specific_flow_overridden: 0,
    hydraulic_mismatch: 0,
    exploration_depth_m: 120,
    widening_depth_m: 95,
    casing_total_m: 96,
    casing_above_ground_m: 1,
    blind_casing_m: 50,
    filter_casing_m: 40,
    sediment_trap_m: 5,
    centralizer_count: 8,
    bottom_plug_details: 'Tapón instalado',
    bentonite_quantity: 12,
    gravel_quantity: 30,
    casing_layout: '[{"order":1,"type":"ciego","meters":50}]',
    compressor_hours: 4,
    pump_hours: 8,
    water_quality: 'Clara',
    installed_meters: 95,
    perforated_meters: 95,
    completion_notes: 'Ficha lista para revisión',
    operator_signature: 'Operador Uno',
    submitted_at: '2026-07-26T12:00:00.000Z',
    created_at: '2026-07-26T12:00:00.000Z',
    updated_at: '2026-07-26T12:00:00.000Z',
  };

  it('emits the existing local insert and full parameter array verbatim', async () => {
    await insertCompletionReport(localRow);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO completion_reports_local (
             id, client_entry_id, project_id, operator_id, format_version,
             static_level, dynamic_level, flow_rate, specific_flow_rate,
             maximum_flow_rate, pump_depth_m, specific_flow_overridden,
             hydraulic_mismatch, exploration_depth_m, widening_depth_m,
             casing_total_m, casing_above_ground_m, blind_casing_m,
             filter_casing_m, sediment_trap_m, centralizer_count,
             bottom_plug_details, bentonite_quantity, gravel_quantity,
             casing_layout, compressor_hours, pump_hours, water_quality,
             installed_meters, perforated_meters, completion_notes,
             operator_signature, status, sync_status, submitted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'pending', ?, ?, ?)`,
      [
        'completion-v2-1', 'completion-v2-1', 21, 'operator-1',
        18.5, 24, 2400, 436.36,
        3000, 42,
        0, 0,
        120, 95,
        96, 1,
        50, 40,
        5, 8,
        'Tapón instalado', 12,
        30, '[{"order":1,"type":"ciego","meters":50}]',
        4, 8,
        'Clara', 95,
        95, 'Ficha lista para revisión',
        'Operador Uno', '2026-07-26T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z', '2026-07-26T12:00:00.000Z',
      ],
    );
  });

  it('keeps local and server identity namespaces separate', async () => {
    await insertCompletionReport(localRow);

    const sql = String(mockExecute.mock.calls[0][0]);
    const insertColumns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(') VALUES'));
    expect(insertColumns).toContain('id');
    expect(insertColumns).toContain('client_entry_id');
    expect(insertColumns).not.toContain('server_id');
    expect(sql).toContain('INSERT INTO completion_reports_local');
    expect(sql).not.toContain('INSERT OR REPLACE');
  });

  it('uses a caller-supplied executor so creation stays in its transaction', async () => {
    const transactionExecute = jest.fn().mockResolvedValue(undefined);

    await insertCompletionReport(localRow, transactionExecute);

    expect(transactionExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
