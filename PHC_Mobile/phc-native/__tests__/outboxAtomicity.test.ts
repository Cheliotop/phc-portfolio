/**
 * Inventory of hand-written sync_outbox inserts on 2026-07-26.
 *
 * Each domain line below and its outbox line use the transaction opened at the
 * listed runInTransaction line, so every current pair is atomic despite
 * bypassing writeDomainRowWithOutbox. The discrepancy entry has no local
 * domain row; its outbox payload is the record to be created on the server.
 * The inventory command returned no hits under src/sync.
 *
 * - src/components/operator/WaterSamplesTab.tsx: water_samples:379 and conditional
 *   project_attachments:407 + outbox:429; runInTransaction:368; atomic: yes.
 * - src/components/operator/FichaTecnicaTab.tsx: completion_reports_local:445 + outbox:477;
 *   runInTransaction:434; atomic: yes.
 * - src/components/operator/FichaTecnicaTab.tsx: completion_reports_local:525 and projects:562 +
 *   outbox:556; runInTransaction:518; atomic: yes.
 * - src/components/operator/FichaTecnicaTab.tsx: no local domain table + outbox:599;
 *   runInTransaction:597; atomic: not applicable (outbox-only operation).
 * - src/components/operator/PedidosV2Tab.tsx: supply_requests:277 and pedido_items:295 + outbox:308;
 *   runInTransaction:274; atomic: yes.
 * - src/components/operator/PedidosV2Tab.tsx: pedido_items:383/406 and pedido_receipts:395 +
 *   outbox:410; runInTransaction:381; atomic: yes.
 * - src/components/operator/ProgresoTab.tsx: drilling_bar_entries:285 and progress_logs_dashboard:300
 *   + outbox:313; runInTransaction:283; atomic: yes.
 * - src/components/operator/TurnosTab.tsx: shifts:130 + outbox:137;
 *   runInTransaction:128; atomic: yes.
 * - src/components/operator/TurnosTab.tsx: shifts:331 + outbox:338;
 *   runInTransaction:329; atomic: yes.
 * - src/components/operator/TurnosTab.tsx: shift_handovers:391 and shifts:404 + outbox:423;
 *   runInTransaction:388; atomic: yes.
 * - src/components/operator/TurnosTab.tsx: material_consumption:508,
 *   project_materials:520, and shifts:535 + outbox:542;
 *   runInTransaction:501; atomic: yes.
 */

type MockQueryResult = { changes: number };
type MockExecute = (sql: string, params?: unknown[]) => Promise<MockQueryResult>;
type MockTransaction = { execute: MockExecute };
type MockTransactionTask = (transaction: MockTransaction) => Promise<unknown>;

const mockExecute = jest.fn<ReturnType<MockExecute>, Parameters<MockExecute>>();
const mockRunInTransaction = jest.fn<Promise<unknown>, [MockTransactionTask]>();

jest.mock('../src/db/db', () => ({
  execute: (...args: Parameters<MockExecute>) => mockExecute(...args),
  runInTransaction: (task: MockTransactionTask) => mockRunInTransaction(task),
  query: jest.fn(),
}));

import { writeDomainRowWithOutbox } from '../src/db/operations';

describe('domain write + outbox are atomic', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockRunInTransaction.mockReset();
    mockExecute.mockResolvedValue({ changes: 1 });
    mockRunInTransaction.mockImplementation(async (task) => task({ execute: mockExecute }));
  });

  it('queues the outbox row inside the same transaction as the domain row', async () => {
    await writeDomainRowWithOutbox(
      { sql: 'INSERT INTO drilling_bars (id) VALUES (?)', params: ['bar-1'] },
      {
        entity: 'drilling_bar',
        entity_id: 'bar-1',
        op: 'create',
        payload_json: { id: 'bar-1' },
      },
    );

    expect(mockRunInTransaction).toHaveBeenCalledTimes(1);
    const sqls = mockExecute.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('INSERT INTO drilling_bars'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('INSERT INTO sync_outbox'))).toBe(true);
  });
});
