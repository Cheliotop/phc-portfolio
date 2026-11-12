const mockRpc = jest.fn(async () => ({ data: {}, error: null }));
jest.mock('../src/lib/supabase', () => ({ __esModule: true, default: { rpc: (...args: any[]) => mockRpc(...args) } }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('base64-arraybuffer', () => ({ decode: jest.fn() }));

import { shiftsApi } from '../src/api/supabase-shifts';
import { drillingBarsApi } from '../src/api/supabase-drilling-bars';
import { waterSamplesApi } from '../src/api/supabase-water-samples';
import { materialsApi } from '../src/api/supabase-materials';
import { pedidosApi } from '../src/api/supabase-pedidos';
import { completionApi } from '../src/api/supabase-completion';

beforeEach(() => mockRpc.mockClear());

it('sends the outbox author as p_entered_by for every contract RPC used by sync', async () => {
  const author = 'operator-a';
  await shiftsApi.start({ projectId: 7, shiftId: 's', clientEntryId: 'e', enteredBy: author });
  await shiftsApi.confirmHandover('s', [], author);
  await shiftsApi.end({ shiftId: 's', usage: [], enteredBy: author });
  await shiftsApi.join('s', author);
  await drillingBarsApi.create({ project_id: 7, soil_type: 'Arcilla' }, author);
  await waterSamplesApi.register({ clientEntryId: 'e', projectId: 7, takenAt: 'now', enteredBy: author });
  await materialsApi.recordConsumption(7, { quantity_used: 1, enteredBy: author });
  await pedidosApi.confirmReceipt({ itemId: 1, clientEntryId: 'e', outcome: 'recibido', enteredBy: author });
  await completionApi.submitV2({
    projectId: 7,
    clientEntryId: 'e',
    finalFields: { casing_layout: [] } as any,
    operatorSignature: 'Ana',
    enteredBy: author,
  });
  await completionApi.resubmitV2({
    reportId: 1,
    clientEntryId: 'e',
    finalFields: { casing_layout: [] } as any,
    operatorSignature: 'Ana',
    enteredBy: author,
  });

  const names = new Set(mockRpc.mock.calls.map(([name]) => name));
  expect(names).toEqual(new Set([
    'start_shift', 'confirm_shift_handover', 'end_shift', 'join_shift',
    'create_drilling_bar', 'register_water_sample', 'record_material_consumption',
    'confirm_pedido_item_receipt', 'submit_completion_v2', 'resubmit_completion_v2',
  ]));
  for (const [, params] of mockRpc.mock.calls) expect(params.p_entered_by).toBe(author);
});

it('omits p_entered_by when the queued author is unknown', async () => {
  await waterSamplesApi.register({ clientEntryId: 'e', projectId: 7, takenAt: 'now' });
  expect(mockRpc.mock.calls[0][1]).not.toHaveProperty('p_entered_by');
});
