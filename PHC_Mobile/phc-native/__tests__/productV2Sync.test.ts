const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockQueryFirst = jest.fn();
const mockDeleteOutbox = jest.fn();
const mockMarkOutboxFailed = jest.fn();
const mockQuarantineOutbox = jest.fn();
const mockShiftStart = jest.fn();
const mockShiftEnd = jest.fn();
const mockConfirmHandover = jest.fn();
const mockShiftGetById = jest.fn();
const mockCompletionResubmit = jest.fn();
const mockCompletionSubmit = jest.fn();
const mockPedidoConfirmReceipt = jest.fn();
const mockPedidoCreateV2 = jest.fn();

jest.mock('../src/db/db', () => ({
  execute: (...args: any[]) => mockExecute(...args),
  query: (...args: any[]) => mockQuery(...args),
  queryFirst: (...args: any[]) => mockQueryFirst(...args),
}));

jest.mock('../src/db/operations', () => ({
  selectDrainableOutboxRows: jest.requireActual('../src/db/operations').selectDrainableOutboxRows,
  deleteOutbox: (...args: any[]) => mockDeleteOutbox(...args),
  markOutboxFailed: (...args: any[]) => mockMarkOutboxFailed(...args),
  quarantineOutbox: (...args: any[]) => mockQuarantineOutbox(...args),
}));

jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: {
    start: (...args: any[]) => mockShiftStart(...args),
    confirmHandover: (...args: any[]) => mockConfirmHandover(...args),
    end: (...args: any[]) => mockShiftEnd(...args),
    getById: (...args: any[]) => mockShiftGetById(...args),
  },
}));

jest.mock('../src/api/supabase-pedidos', () => ({
  pedidosApi: {
    confirmReceipt: (...args: any[]) => mockPedidoConfirmReceipt(...args),
    createV2: (...args: any[]) => mockPedidoCreateV2(...args),
  },
}));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: {} }));
jest.mock('../src/api/supabase-photos', () => ({ photosApi: {} }));
jest.mock('../src/api/supabase-completion', () => ({
  completionApi: {
    submitV2: (...args: any[]) => mockCompletionSubmit(...args),
    resubmitV2: (...args: any[]) => mockCompletionResubmit(...args),
  },
}));

import {
  getShiftSyncState,
  syncPendingShiftAutoCloses,
  syncPendingShiftEnds,
  syncPendingShiftHandovers,
  syncPendingShiftStarts,
  syncPendingCompletionResubmissions,
  syncPendingCompletionsV2,
  syncPendingPedidoReceipts,
  syncPendingPedidosV2,
} from '../src/sync/productV2Sync';

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({ changes: 1 });
  mockDeleteOutbox.mockResolvedValue(undefined);
  mockMarkOutboxFailed.mockResolvedValue(undefined);
  mockQuarantineOutbox.mockResolvedValue(undefined);
});

it('never maps an offline shift onto an unresolved server shift, and keeps the queued start for retry', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-1',
    entity: 'shift_start',
    entity_id: 'local-shift',
    payload_json: JSON.stringify({
      projectId: 3,
      shiftId: 'local-shift',
      clientEntryId: 'client-shift',
    }),
    retries: 0,
  }]);
  mockShiftStart.mockResolvedValue({
    id: 'other-unresolved-shift',
    project_id: 3,
    status: 'open',
    started_at: new Date().toISOString(),
  });

  const result = await syncPendingShiftStarts();

  expect(result).toEqual({ synced: 0, failed: 1 });
  expect(mockExecute).toHaveBeenCalledTimes(1);
  const [sql, params] = mockExecute.mock.calls[0];
  expect(sql).toContain('last_error = ?');
  expect(sql).not.toContain('sync_status');
  expect(sql).not.toContain('server_id =');
  expect(params).toEqual(expect.arrayContaining(['local-shift']));
  // The unresolved server shift is often this device's own previous queued
  // shift whose end drains in a later phase. Deleting the outbox row here
  // would strand the new shift forever, so it must survive for the next pass.
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

it('W-17: a synced handover does not report the shift synced while its auto-close is pending', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-w17',
    entity: 'shift_handover',
    entity_id: 'shift-w17',
    payload_json: JSON.stringify({ shiftId: 'shift-w17', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*) AS count')) return { count: 1 };
    return { server_id: 'server-shift-w17' };
  });
  mockConfirmHandover.mockResolvedValue({ handover_confirmed: true });

  const handoverResult = await syncPendingShiftHandovers();
  const state = await getShiftSyncState('shift-w17');

  expect(handoverResult).toEqual({ synced: 1, failed: 0, lastError: null });
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-handover-w17');
  expect(state).toBe('pending');

  const shiftUpdate = mockExecute.mock.calls.find(
    ([sql]) => String(sql).includes('UPDATE shifts SET handover_confirmed = 1'),
  );
  expect(shiftUpdate?.[0]).not.toContain('sync_status');

  const stateQuery = mockQueryFirst.mock.calls.find(
    ([sql]) => String(sql).includes('COUNT(*) AS count'),
  );
  expect(stateQuery?.[0]).toContain("'shift_auto_close'");
  expect(stateQuery?.[1]).toEqual(['shift-w17']);
});

it('keeps an auto-close queued while the server still reports the shift open', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-auto-close',
    entity: 'shift_auto_close',
    entity_id: 'shift-auto',
    payload_json: JSON.stringify({
      shiftId: 'shift-auto',
      endedAt: '2026-07-21T20:00:00.000Z',
    }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-auto' });
  mockShiftGetById.mockResolvedValue({
    id: 'server-shift-auto',
    status: 'open',
    ended_at: null,
    end_type: null,
  });

  const result = await syncPendingShiftAutoCloses();

  expect(result).toEqual({ synced: 0, failed: 0 });
  expect(mockShiftGetById).toHaveBeenCalledWith('server-shift-auto');
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

it('clears a backfilled auto-close only after the matching server transition exists', async () => {
  mockQuery.mockResolvedValue([{
    id: 'shift-auto-close-v7-shift-auto',
    entity: 'shift_auto_close',
    entity_id: 'shift-auto',
    payload_json: JSON.stringify({ backfilled: true }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-auto' });
  mockShiftGetById.mockResolvedValue({
    id: 'server-shift-auto',
    status: 'report_pending',
    ended_at: '2026-07-21T20:00:00.000Z',
    end_type: 'auto',
  });

  const result = await syncPendingShiftAutoCloses();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockDeleteOutbox).toHaveBeenCalledWith('shift-auto-close-v7-shift-auto');
});

it('waits to close a shift whose start has not synced without burning a retry', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-end',
    entity: 'shift_end',
    entity_id: 'local-shift',
    payload_json: JSON.stringify({ shiftId: 'local-shift', usage: [] }),
    retries: 0,
  }]);
  // server_id is only set once the shift's start has actually synced. Later
  // operations already have their own outbox rows and must not affect this
  // dependency guard.
  mockQueryFirst.mockResolvedValue({ server_id: null, sync_status: 'conflict' });

  const result = await syncPendingShiftEnds();

  // A dependency wait is not a failure: it must not burn a retry NOR inflate
  // the "fallidos" count (LOW-8).
  expect(result).toEqual({ synced: 0, failed: 0 });
  expect(mockShiftEnd).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
});

it('waits to confirm a handover whose shift start has not synced without burning a retry', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover',
    entity: 'shift_handover',
    entity_id: 'handover-1',
    payload_json: JSON.stringify({ shiftId: 'local-shift', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: null, sync_status: 'pending' });

  const result = await syncPendingShiftHandovers();

  // Dependency wait, not a failure (LOW-8): no burned retry, no failed count.
  // lastError stays null — a wait is not a rejection, so the caller must keep
  // showing the offline message rather than an error.
  expect(result).toEqual({ synced: 0, failed: 0, lastError: null });
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
});

it('reports the server rejection reason so the caller does not claim it is merely offline', async () => {
  // Regression for the 2026-07-25 audit finding: a server rejection was shown to
  // the operator as "Traspaso guardado. Se sincronizará cuando haya conexión."
  // while the device was online. The outbox stops retrying after 3 attempts, so
  // that promise could never be kept and the operator stayed blocked from
  // registering progress with no way to learn why.
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-rejected',
    entity: 'shift_handover',
    entity_id: 'handover-rejected',
    payload_json: JSON.stringify({ shiftId: 'shift-1', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-1', sync_status: 'synced' });
  mockConfirmHandover.mockRejectedValue(
    new Error('A handover item is not an active material in this project (22023)'),
  );

  const result = await syncPendingShiftHandovers();

  expect(result.synced).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.lastError).toBe(
    'A handover item is not an active material in this project (22023)',
  );
  expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
    'outbox-handover-rejected',
    'A handover item is not an active material in this project (22023)',
  );
});

it('W-11(b): rolls back the optimistic handover_confirmed when the server rejects it for good', async () => {
  // The other half of the same audit finding. TurnosTab writes
  // handover_confirmed = 1 inside the local transaction that queues the outbox
  // row, before the server has seen anything. On a permanent rejection nothing
  // used to undo it: local said confirmed, server said false, forever, with the
  // outbox row abandoned at retries = 3.
  //
  // The real error is a PostgrestError object carrying the SQLSTATE in `code` —
  // `throw error` in supabase-shifts.ts passes it through untouched.
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-perm',
    entity: 'shift_handover',
    entity_id: 'local-shift-7',
    payload_json: JSON.stringify({ shiftId: 'local-shift-7', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-7', sync_status: 'synced' });
  mockConfirmHandover.mockRejectedValue({
    code: '22023',
    message: 'A handover item is not an active material in this project',
  });

  const result = await syncPendingShiftHandovers();

  expect(result.failed).toBe(1);
  expect(result.lastError).toContain('not an active material');

  // Quarantined, not retried three times and abandoned.
  expect(mockQuarantineOutbox).toHaveBeenCalledWith('outbox-handover-perm', expect.stringContaining('22023'));
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();

  const statements = mockExecute.mock.calls.map(([sql]) => String(sql));
  expect(statements.some((sql) => sql.includes('handover_confirmed = 0'))).toBe(true);
  expect(statements.some((sql) => sql.includes('handover_confirmed = 1'))).toBe(false);

  // Quarantine, not revert: the operator's observed quantities and notes are
  // flagged, never deleted.
  expect(statements.some((sql) => /DELETE\s+FROM\s+shift_handovers/i.test(sql))).toBe(false);
  expect(statements.some((sql) => sql.includes('UPDATE shift_handovers'))).toBe(true);

  // The rejection reason has to land on the row the operator can actually see.
  const shiftUpdate = mockExecute.mock.calls.find(([sql]) => String(sql).includes('handover_confirmed = 0'));
  expect(shiftUpdate?.[1]).toEqual([
    expect.stringContaining('22023'),
    expect.any(String),
    'local-shift-7',
  ]);
});

it('W-11(b): leaves handover_confirmed alone when the failure is merely a lost signal', async () => {
  // The inverse guard. Reverting on a transient failure would drag the operator
  // back through a handover they already completed correctly, every time the
  // signal drops mid-drain.
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-transient',
    entity: 'shift_handover',
    entity_id: 'local-shift-8',
    payload_json: JSON.stringify({ shiftId: 'local-shift-8', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-8', sync_status: 'synced' });
  mockConfirmHandover.mockRejectedValue(new Error('Network request failed'));

  const result = await syncPendingShiftHandovers();

  expect(result.failed).toBe(1);
  expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-handover-transient', 'Network request failed');
  expect(mockQuarantineOutbox).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
});

it('W-11(b): never drains a quarantined row again', async () => {
  mockQuery.mockResolvedValue([]);

  await syncPendingShiftHandovers();

  const [sql] = mockQuery.mock.calls[0];
  expect(String(sql)).toMatch(/COALESCE\(state, 'pending'\) <> 'quarantined'/);
});

it('closes a shift through its server id while other shift changes remain queued', async () => {
  // The guard must key off server_id (only set by successful start sync), not
  // any row-level summary of later queued shift changes.
  mockQuery.mockResolvedValue([{
    id: 'outbox-end-pending',
    entity: 'shift_end',
    entity_id: 'local-shift',
    payload_json: JSON.stringify({ shiftId: 'local-shift', usage: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift', sync_status: 'pending' });
  mockShiftEnd.mockResolvedValue({
    id: 'server-shift',
    status: 'closed',
    ended_at: new Date().toISOString(),
    end_type: 'manual',
    device_time_flag: false,
  });

  const result = await syncPendingShiftEnds();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockShiftEnd).toHaveBeenCalledWith(
    expect.objectContaining({ shiftId: 'server-shift' }),
  );
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-end-pending');
});

it('closes a synced shift through its server id', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-end-2',
    entity: 'shift_end',
    entity_id: 'local-shift',
    payload_json: JSON.stringify({ shiftId: 'local-shift', usage: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift', sync_status: 'synced' });
  mockShiftEnd.mockResolvedValue({
    id: 'server-shift',
    status: 'closed',
    ended_at: new Date().toISOString(),
    end_type: 'manual',
    device_time_flag: false,
  });

  const result = await syncPendingShiftEnds();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockShiftEnd).toHaveBeenCalledWith(
    expect.objectContaining({ shiftId: 'server-shift' }),
  );
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-end-2');
});

it('resubmits a returned Ficha with the queued idempotency key and clears the outbox', async () => {
  const payload = {
    reportId: 81,
    projectId: 7,
    clientEntryId: 'completion-resubmit-stable',
    finalFields: { static_level: 4 },
    operatorSignature: 'Operador QA',
  };
  mockQuery.mockResolvedValue([{
    id: 'outbox-resubmit',
    entity: 'completion_v2_resubmit',
    entity_id: '81',
    payload_json: JSON.stringify(payload),
    retries: 0,
  }]);
  mockCompletionResubmit.mockResolvedValue({
    data: { id: 81, status: 'submitted', submitted_at: '2026-07-12T12:00:00.000Z' },
  });

  const result = await syncPendingCompletionResubmissions();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockCompletionResubmit).toHaveBeenCalledWith(payload);
  // LOW-7: the update must target the specific report (server_id = reportId),
  // never the whole project — a project can have more than one report row.
  const resubmitUpdate = mockExecute.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes("sync_status = 'synced'"),
  );
  expect(resubmitUpdate).toBeDefined();
  expect(resubmitUpdate?.[0]).toContain('WHERE server_id = ?');
  expect(resubmitUpdate?.[0]).not.toContain('WHERE project_id = ?');
  // params end with the report's server id (81) as the WHERE key.
  expect(resubmitUpdate?.[1][resubmitUpdate?.[1].length - 1]).toBe(81);
  expect(resubmitUpdate?.[1]).toEqual(expect.arrayContaining([81, 'submitted']));
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-resubmit');
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

it('keeps a failed Ficha resubmission queued with the same payload for retry', async () => {
  const payload = {
    reportId: 82,
    projectId: 8,
    clientEntryId: 'completion-resubmit-retry',
    finalFields: { static_level: 5 },
    operatorSignature: 'Operador QA',
  };
  mockQuery.mockResolvedValue([{
    id: 'outbox-resubmit-failed',
    entity: 'completion_v2_resubmit',
    entity_id: '82',
    payload_json: JSON.stringify(payload),
    retries: 0,
  }]);
  mockCompletionResubmit.mockRejectedValue(new Error('sin red'));

  const result = await syncPendingCompletionResubmissions();

  expect(result).toEqual({ synced: 0, failed: 1 });
  expect(mockCompletionResubmit).toHaveBeenCalledWith(payload);
  expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-resubmit-failed', 'sin red');
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
});

const completionRow = {
  id: 'outbox-completion',
  entity: 'completion_v2',
  entity_id: 'completion-local',
  payload_json: JSON.stringify({ projectId: 7, clientEntryId: 'completion-stable' }),
  retries: 0,
};

const configureCompletionDrain = (workRows: any[]) => {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('SELECT entity, entity_id, payload_json FROM sync_outbox')) return workRows;
    if (params[0] === 'completion_v2') return [completionRow];
    return [];
  });
  mockCompletionSubmit.mockResolvedValue({ data: { id: 17, status: 'submitted' } });
};

it('holds a Ficha while a water sample for the same well is queued', async () => {
  configureCompletionDrain([{
    entity: 'water_sample', entity_id: 'sample-local',
    payload_json: JSON.stringify({ projectId: 7 }),
  }]);

  const result = await syncPendingCompletionsV2();

  expect(result).toEqual({ synced: 0, failed: 0 });
  expect(mockCompletionSubmit).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
});

it('does not hold a Ficha for queued work belonging to another well', async () => {
  configureCompletionDrain([{
    entity: 'water_sample', entity_id: 'sample-other',
    payload_json: JSON.stringify({ projectId: 8 }),
  }]);

  const result = await syncPendingCompletionsV2();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockCompletionSubmit).toHaveBeenCalledWith(JSON.parse(completionRow.payload_json));
});

it('does not hold a Ficha for quarantined work', async () => {
  configureCompletionDrain([]);

  const result = await syncPendingCompletionsV2();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT entity, entity_id, payload_json FROM sync_outbox'))?.[0])
    .toContain("COALESCE(state, 'pending') <> 'quarantined'");
  expect(mockCompletionSubmit).toHaveBeenCalledTimes(1);
});

it('sends a Ficha on a later drain after the same-well work has synced', async () => {
  // Once the sample's outbox row is deleted by its successful sync, no queued
  // dependency remains to hold the completion.
  configureCompletionDrain([]);

  const result = await syncPendingCompletionsV2();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockCompletionSubmit).toHaveBeenCalledTimes(1);
});

it('recovers a queued receipt whose synthetic item id conflicts with the original synced local item', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-receipt',
    entity: 'pedido_receipt',
    entity_id: 'receipt-local',
    payload_json: JSON.stringify({
      localItemId: 'server_item_46',
      clientEntryId: 'receipt-stable',
      outcome: 'recibido',
      quantityReceived: 1,
    }),
    retries: 2,
  }]);
  mockQueryFirst.mockResolvedValue({ id: 'pedido-item-original-local-id', server_id: 46 });
  mockPedidoConfirmReceipt.mockResolvedValue({
    receipt: { id: 91 },
    item: { state: 'recibido', received_quantity: 1 },
  });

  const result = await syncPendingPedidoReceipts();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockPedidoConfirmReceipt).toHaveBeenCalledWith(expect.objectContaining({ itemId: 46 }));
  expect(mockExecute).toHaveBeenCalledWith(
    expect.stringContaining('pedido_item_id = ?'),
    expect.arrayContaining([91, 'pedido-item-original-local-id', 'receipt-local']),
  );
  expect(mockExecute).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE pedido_items SET state = ?'),
    expect.arrayContaining(['recibido', 1, 'pedido-item-original-local-id']),
  );
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-receipt');
});

it('HIGH-1: assigns each pedido item its OWN server id, matching by client_entry_id not array index', async () => {
  // Two-item pedido. The server returns items ordered by its own bigint id
  // (draft insertion order: A then B), but the local rows come back in the
  // reverse (created_at, id) order (B then A). A positional match would give
  // local B the server id of A and vice versa — cross-assigning materials so a
  // later receipt decrements the WRONG one. The fix joins on client_entry_id.
  mockQuery
    // rowsFor('pedido_v2')
    .mockResolvedValueOnce([{
      id: 'outbox-pedido',
      entity: 'pedido_v2',
      entity_id: '55',
      payload_json: JSON.stringify({ clientEntryId: 'pedido-cei', projectId: 3, kind: 'empresa', items: [] }),
      retries: 0,
    }])
    // SELECT id, client_entry_id FROM pedido_items ... (local order: B then A)
    .mockResolvedValueOnce([
      { id: 'cei-B', client_entry_id: 'cei-B' },
      { id: 'cei-A', client_entry_id: 'cei-A' },
    ]);
  mockPedidoCreateV2.mockResolvedValue({
    pedido: { id: 55, pedido_number: 'P-1', status: 'pendiente' },
    // server order: A (id 101) then B (id 102)
    items: [
      { id: 101, client_entry_id: 'cei-A', state: 'solicitado' },
      { id: 102, client_entry_id: 'cei-B', state: 'solicitado' },
    ],
  });

  const result = await syncPendingPedidosV2();

  expect(result).toEqual({ synced: 1, failed: 0 });

  const itemUpdate = (localId: string) => mockExecute.mock.calls.find(
    ([sql, params]) => typeof sql === 'string'
      && sql.includes('UPDATE pedido_items SET server_id = ?')
      && Array.isArray(params) && params[params.length - 1] === localId,
  );
  // Local B must receive B's OWN server id (102), local A must receive 101.
  expect(itemUpdate('cei-B')?.[1][0]).toBe(102);
  expect(itemUpdate('cei-A')?.[1][0]).toBe(101);
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-pedido');
});

it('HIGH-2: a receipt waiting on an unsynced parent item does not burn a retry', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-receipt-wait',
    entity: 'pedido_receipt',
    entity_id: 'receipt-local',
    payload_json: JSON.stringify({
      localItemId: 'pedido-item-local',
      clientEntryId: 'receipt-stable',
      outcome: 'recibido',
      quantityReceived: 1,
    }),
    retries: 0,
  }]);
  // Parent pedido_item exists locally but has not synced yet: no server_id.
  mockQueryFirst.mockResolvedValue({ id: 'pedido-item-local', server_id: null });

  const result = await syncPendingPedidoReceipts();

  // Dependency wait: skip without confirming, without burning a retry, and
  // without counting a failure.
  expect(result).toEqual({ synced: 0, failed: 0 });
  expect(mockPedidoConfirmReceipt).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
});

it('MEDIUM-5: never marks a handover synced when the server does not confirm it', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-unconf',
    entity: 'shift_handover',
    entity_id: 'handover-1',
    payload_json: JSON.stringify({ shiftId: 'local-shift', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift', sync_status: 'synced' });
  mockConfirmHandover.mockResolvedValue({ handover_confirmed: false });

  const result = await syncPendingShiftHandovers();

  // Not confirmed => dependency-wait/continue path: no synced state persisted,
  // no retry burned, no failure counted, and no error to report upward.
  expect(result).toEqual({ synced: 0, failed: 0, lastError: null });
  expect(mockConfirmHandover).toHaveBeenCalled();
  const wroteSynced = mockExecute.mock.calls.some(
    ([sql]) => typeof sql === 'string'
      && (sql.includes('handover_confirmed = 1') || sql.includes("sync_status = 'synced'")),
  );
  expect(wroteSynced).toBe(false);
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

it('OPA-11: a second handover submit the server already confirmed stays confirmed and leaves the queue empty', async () => {
  // The server accepted the first submit. A second submit with the same ids is
  // refused as a replay mismatch, but the shift is confirmed on the server, so
  // the phone must keep it confirmed instead of reverting it.
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-replay',
    entity: 'shift_handover',
    entity_id: 'local-shift-11',
    payload_json: JSON.stringify({ shiftId: 'local-shift-11', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-11', sync_status: 'synced' });
  mockShiftGetById.mockResolvedValue({ id: 'server-shift-11', status: 'open', handover_confirmed: true });
  mockConfirmHandover.mockRejectedValue({
    code: '23505',
    message: 'Idempotency replay does not match the confirmed handover',
  });

  const result = await syncPendingShiftHandovers();

  expect(mockShiftGetById).toHaveBeenCalledWith('server-shift-11');
  expect(result).toEqual({ synced: 1, failed: 0, lastError: null });
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-handover-replay');
  expect(mockQuarantineOutbox).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();

  const statements = mockExecute.mock.calls.map(([sql]) => String(sql));
  expect(statements.some((sql) => sql.includes('handover_confirmed = 0'))).toBe(false);
  expect(statements.some((sql) => sql.includes('UPDATE shifts SET handover_confirmed = 1'))).toBe(true);
});

it('OPA-11: a replay mismatch the server does not confirm still reverts the flag as before', async () => {
  mockQuery.mockResolvedValue([{
    id: 'outbox-handover-replay-unconf',
    entity: 'shift_handover',
    entity_id: 'local-shift-12',
    payload_json: JSON.stringify({ shiftId: 'local-shift-12', items: [] }),
    retries: 0,
  }]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-12', sync_status: 'synced' });
  mockShiftGetById.mockResolvedValue({ id: 'server-shift-12', status: 'open', handover_confirmed: false });
  mockConfirmHandover.mockRejectedValue({
    code: '23505',
    message: 'Idempotency replay does not match the confirmed handover',
  });

  const result = await syncPendingShiftHandovers();

  expect(result.failed).toBe(1);
  expect(mockQuarantineOutbox).toHaveBeenCalledWith('outbox-handover-replay-unconf', expect.any(String));
  const statements = mockExecute.mock.calls.map(([sql]) => String(sql));
  expect(statements.some((sql) => sql.includes('handover_confirmed = 0'))).toBe(true);
});
