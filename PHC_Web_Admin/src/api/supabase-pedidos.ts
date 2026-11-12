import { supabase } from '../lib/supabase';
import type { MaterialLayer, PedidoV2 } from '../types/productV2';
import type {
  ConfirmPedidoReceiptInput,
  ConfirmPedidoReceiptResult,
  CreatePedidoV2Input,
  CreatePedidoV2Result,
} from '../types/operatorConsole';
import { friendlyApiError } from './supabase-api-errors';
import { requireAuthenticatedUserId } from './supabase-operator-session';
import { fetchAllPages } from '../domain/paging.ts';

export const pedidosApi = {
  async getMine(): Promise<{ data: PedidoV2[] }> {
    // Crew handoff: visibility is scoped by RLS (own pedidos or the project's
    // current assigned operator), not by a client-side operator_id filter --
    // an incoming operator must see pedidos the outgoing operator requested.
    await requireAuthenticatedUserId();
    const { data, error } = await supabase
      .from('pedidos')
      .select(`
        *,
        projects(name, location),
        pedido_items(*, pedido_receipts(*))
      `)
      .order('created_at', { ascending: false });
    if (error) throw friendlyApiError(error, 'No se pudieron cargar tus pedidos.');
    return { data: (data || []) as PedidoV2[] };
  },

  async createV2(input: CreatePedidoV2Input): Promise<CreatePedidoV2Result> {
    const items = input.items.map((item) => ({
      client_entry_id: item.client_entry_id ?? null,
      catalog_variant_id: item.catalog_variant_id ?? null,
      material_name: item.material_name?.trim() || null,
      requested_quantity: item.requested_quantity,
      unit: item.unit?.trim() || null,
      layer: item.layer ?? 'extras',
    }));
    const { data, error } = await supabase.rpc('create_pedido_v2', {
      p_project_id: input.projectId,
      p_kind: input.kind,
      p_items: items,
      p_client_entry_id: input.clientEntryId,
      p_justification: input.justification?.trim() || null,
      p_priority: input.priority?.trim() || 'Normal',
      p_needed_by: input.neededBy ?? null,
      p_notes: input.notes?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo crear el pedido.');
    const result = data as CreatePedidoV2Result;

    // Notifications are best-effort and the Edge Function derives all
    // recipients/content server-side. An idempotent replay must not send a
    // second email.
    // Invoke on exact replays too: a lost mutation response must not suppress
    // the only notification attempt. Server/provider idempotency deduplicates.
    void supabase.functions
      .invoke('notify-email', {
        body: { type: 'pedido_created', entity_id: result.pedido.id },
      })
      .then(({ error: notifyError }) => {
        if (notifyError) console.warn('[notify-email] pedido_created failed:', notifyError);
      })
      .catch((notifyError) => console.warn('[notify-email] pedido_created failed:', notifyError));
    return result;
  },

  async confirmReceipt(input: ConfirmPedidoReceiptInput): Promise<ConfirmPedidoReceiptResult> {
    const { data, error } = await supabase.rpc('confirm_pedido_item_receipt', {
      p_item_id: input.itemId,
      p_client_entry_id: input.clientEntryId,
      p_outcome: input.outcome,
      p_quantity_received: input.quantityReceived ?? 0,
      p_incident_note: input.incidentNote?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo confirmar la recepción del ítem.');
    return data as ConfirmPedidoReceiptResult;
  },

  /** Every pedido, read page by page: PostgREST caps one request at 1000 rows (audit WEB-7). */
  async getAll(): Promise<{ data: PedidoV2[] }> {
    const rows = await fetchAllPages<PedidoV2>(async (from, to) => {
      const { data, error } = await supabase
        .from('pedidos')
        .select(`
          *,
          projects(name, location),
          profiles!pedidos_operator_id_fkey(username, full_name),
          pedido_items(*, pedido_receipts(*))
        `)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      if (error) throw friendlyApiError(error, 'No se pudieron cargar los pedidos.');
      return (data || []) as PedidoV2[];
    });
    return { data: rows };
  },

  async decideItem(input: {
    itemId: number;
    decision: 'aprobado' | 'rechazado';
    approvedQuantity?: number;
    reason?: string;
    layer?: MaterialLayer;
  }) {
    const { data, error } = await supabase.rpc('decide_pedido_item', {
      p_item_id: input.itemId,
      p_decision: input.decision,
      p_approved_quantity: input.approvedQuantity ?? null,
      p_reason: input.reason?.trim() || null,
      p_layer: input.layer ?? 'extras',
    });
    if (error) throw friendlyApiError(error, 'No se pudo guardar la decisión del ítem.');
    return data;
  },

  async closeManually(id: number, reason: string) {
    const { data, error } = await supabase.rpc('close_pedido_manually', {
      p_pedido_id: id,
      p_reason: reason.trim(),
    });
    if (error) throw friendlyApiError(error, 'No se pudo cerrar el pedido.');
    return data;
  },

};
