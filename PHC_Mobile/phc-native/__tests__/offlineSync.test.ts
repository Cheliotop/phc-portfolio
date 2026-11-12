const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockDeleteOutbox = jest.fn();
const mockMarkOutboxFailed = jest.fn();
const mockRecordConsumption = jest.fn();
const mockCreatePedido = jest.fn();

jest.mock('../src/db/db', () => ({
  execute: (...args: any[]) => mockExecute(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

jest.mock('../src/db/operations', () => ({
  selectDrainableOutboxRows: jest.requireActual('../src/db/operations').selectDrainableOutboxRows,
  deleteOutbox: (...args: any[]) => mockDeleteOutbox(...args),
  markOutboxFailed: (...args: any[]) => mockMarkOutboxFailed(...args),
}));

jest.mock('../src/api/supabase-pedidos', () => ({
  pedidosApi: { create: (...args: any[]) => mockCreatePedido(...args) },
}));
jest.mock('../src/api/supabase-materials', () => ({
  materialsApi: { recordConsumption: (...args: any[]) => mockRecordConsumption(...args) },
}));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: {} }));

import { syncPendingMaterialConsumption, syncPendingPedidos } from '../src/sync/offlineSync';

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({ changes: 1 });
  mockDeleteOutbox.mockResolvedValue(undefined);
  mockMarkOutboxFailed.mockResolvedValue(undefined);
});

// MEDIUM-3: entity_id holds the client_entry_id STRING, but
// material_consumption.id / supply_requests.id are INTEGER AUTOINCREMENT.
// The old UPDATE ... WHERE id = ? compared an integer column to a string and
// matched 0 rows, so the local row stayed 'pending' forever and never
// reconciled. The rows must be keyed on client_entry_id.

it('flips material_consumption from pending to synced by client_entry_id and stores server_id', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-mc',
    entity: 'material_consumption',
    entity_id: 'mc-client-entry-id',
    op: 'INSERT',
    payload_json: JSON.stringify({ project_id: 7, material_name: 'Bentonita', quantity_used: 3 }),
    retries: 0,
  }]);
  mockRecordConsumption.mockResolvedValue({ data: { id: 909 } });

  const result = await syncPendingMaterialConsumption();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockRecordConsumption).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ material_name: 'Bentonita', quantity_used: 3 }),
  );

  const update = mockExecute.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes("sync_status = 'synced'"),
  );
  expect(update).toBeDefined();
  expect(update?.[0]).toContain('WHERE client_entry_id = ?');
  expect(update?.[0]).not.toMatch(/WHERE id = \?/);
  expect(update?.[1]).toEqual([909, expect.any(String), 'mc-client-entry-id']);
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-mc');
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

it('marks material_consumption failed by client_entry_id when the server rejects it', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-mc-fail',
    entity: 'material_consumption',
    entity_id: 'mc-client-entry-id',
    op: 'INSERT',
    payload_json: JSON.stringify({ project_id: 7, material_name: 'Bentonita', quantity_used: 3 }),
    retries: 0,
  }]);
  mockRecordConsumption.mockRejectedValue(new Error('sin red'));

  const result = await syncPendingMaterialConsumption();

  expect(result).toEqual({ synced: 0, failed: 1 });
  const update = mockExecute.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes("sync_status = 'failed'"),
  );
  expect(update?.[0]).toContain('WHERE client_entry_id = ?');
  expect(update?.[1]).toEqual(['sin red', expect.any(String), 'mc-client-entry-id']);
  expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-mc-fail', 'sin red');
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
});

it('flips supply_requests (pedido) from pending to synced by client_entry_id', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-pedido-v1',
    entity: 'pedido',
    entity_id: 'pedido-client-entry-id',
    op: 'INSERT',
    payload_json: JSON.stringify({ client_entry_id: 'pedido-client-entry-id', project_id: 7, material: 'Cemento', quantity: 2 }),
    retries: 0,
  }]);
  mockCreatePedido.mockResolvedValue({ id: 321, pedido_number: 'PN-1' });

  const result = await syncPendingPedidos();

  expect(result).toEqual({ synced: 1, failed: 0 });
  const update = mockExecute.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes("sync_status = 'synced'"),
  );
  expect(update?.[0]).toContain('WHERE client_entry_id = ?');
  expect(update?.[0]).not.toMatch(/WHERE id = \?/);
  expect(update?.[1]).toEqual([321, 'PN-1', expect.any(String), 'pedido-client-entry-id']);
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-pedido-v1');
});
