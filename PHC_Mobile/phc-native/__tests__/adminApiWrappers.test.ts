/**
 * Unit tests for the Pass 4 admin RPC wrappers. We mock the Supabase client so
 * these assert the wrapper contract (correct RPC name + param mapping + error
 * propagation) without any network or DB.
 */
// `mock`-prefixed names are the only outer vars jest.mock factories may
// reference (hoisting guard).
const mockRpc = jest.fn();
const mockInvoke = jest.fn().mockResolvedValue({});

// supabase-completion transitively imports these ESM/native modules; stub them
// so the wrapper module loads under jest (expo-file-system is mocked globally
// in jest.setup.js).
jest.mock('base64-arraybuffer', () => ({ decode: jest.fn(), encode: jest.fn() }));

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    rpc: (...args: any[]) => mockRpc(...args),
    functions: { invoke: (...args: any[]) => mockInvoke(...args) },
  },
}));

import { pedidosApi } from '../src/api/supabase-pedidos';
import { completionApi } from '../src/api/supabase-completion';

const rpc = mockRpc;
const invoke = mockInvoke;

beforeEach(() => {
  rpc.mockReset();
  invoke.mockClear();
});

describe('pedidosApi v2 decisions', () => {
  it('retires whole-pedido approval without calling the server', async () => {
    await expect(pedidosApi.approve(1)).rejects.toThrow('aprueba o rechaza cada ítem');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('approves one item without invoking any inventory assignment RPC', async () => {
    rpc.mockResolvedValue({ data: { id: 8, state: 'aprobado' }, error: null });
    const result = await pedidosApi.decideItem({
      itemId: 8,
      decision: 'aprobado',
      approvedQuantity: 30,
      reason: 'autorizado',
      layer: 'presupuesto',
    });
    expect(rpc).toHaveBeenCalledWith('decide_pedido_item', {
      p_item_id: 8,
      p_decision: 'aprobado',
      p_approved_quantity: 30,
      p_reason: 'autorizado',
      p_layer: 'presupuesto',
    });
    expect(result).toEqual({ id: 8, state: 'aprobado' });
    expect(rpc).not.toHaveBeenCalledWith('assign_material_to_project', expect.anything());
  });

  it('maps receipt confirmation to the only inventory-changing workflow', async () => {
    rpc.mockResolvedValue({ data: { item: { id: 8, state: 'recibido' } }, error: null });
    await pedidosApi.confirmReceipt({
      itemId: 8,
      clientEntryId: 'receipt_1',
      outcome: 'recibido',
      quantityReceived: 30,
    });
    expect(rpc).toHaveBeenCalledWith('confirm_pedido_item_receipt', {
      p_item_id: 8,
      p_client_entry_id: 'receipt_1',
      p_outcome: 'recibido',
      p_quantity_received: 30,
      p_incident_note: null,
    });
  });
});

describe('pedidosApi.reject', () => {
  it('calls reject_pedido with reason', async () => {
    rpc.mockResolvedValue({ data: { id: 4, status: 'Rechazado' }, error: null });
    await pedidosApi.reject(4, 'sin presupuesto');
    expect(rpc).toHaveBeenCalledWith('reject_pedido', { p_pedido_id: 4, p_reason: 'sin presupuesto' });
  });
});

describe('completionApi.signAndComplete', () => {
  it('calls sign_completion_report and completes the project by default', async () => {
    rpc.mockResolvedValue({ data: { id: 7, project_id: 10, status: 'approved' }, error: null });
    const res = await completionApi.signAndComplete(7, 'Ing. QA');
    expect(rpc).toHaveBeenCalledWith('sign_completion_report', {
      p_report_id: 7,
      p_admin_signature: 'Ing. QA',
      p_complete_project: true,
      p_acknowledge_open_pedidos: false,
    });
    expect(res.data.status).toBe('approved');
    expect(invoke).toHaveBeenCalledWith('notify-email', {
      body: { type: 'completion_signed', entity_id: 7 },
    });
  });

  it('passes open-pedido acknowledgement only when explicitly requested', async () => {
    rpc.mockResolvedValue({ data: { id: 7, status: 'approved' }, error: null });
    await completionApi.signAndComplete(7, 'Ing. QA', true, true);
    expect(rpc).toHaveBeenCalledWith('sign_completion_report', {
      p_report_id: 7,
      p_admin_signature: 'Ing. QA',
      p_complete_project: true,
      p_acknowledge_open_pedidos: true,
    });
  });

  it('throws (does not swallow) on RPC error', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('El informe ya fue firmado') });
    await expect(completionApi.signAndComplete(7, 'X')).rejects.toThrow('ya fue firmado');
  });
});

describe('completionApi.resubmitV2', () => {
  it('maps the returned-Ficha idempotency contract exactly', async () => {
    rpc.mockResolvedValue({ data: { id: 22, status: 'submitted' }, error: null });
    const finalFields = {
      static_level: 4,
      dynamic_level: 9,
      flow_rate: 1200,
      maximum_flow_rate: 1400,
      pump_depth_m: 20,
      exploration_depth_m: 40,
      widening_depth_m: 35,
      casing_layout: [{ order: 1, type: 'ciego' as const, meters: 35 }],
    };

    const result = await completionApi.resubmitV2({
      reportId: 22,
      clientEntryId: 'resubmit-stable-key',
      finalFields,
      operatorSignature: 'Operador QA',
      completionNotes: 'corregida',
    });

    expect(rpc).toHaveBeenCalledWith('resubmit_completion_v2', {
      p_report_id: 22,
      p_client_entry_id: 'resubmit-stable-key',
      p_final_fields: finalFields,
      p_operator_signature: 'Operador QA',
      p_completion_notes: 'corregida',
      p_pdf_url: null,
    });
    expect(result.data.status).toBe('submitted');
  });
});
