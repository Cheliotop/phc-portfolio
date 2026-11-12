import supabase from '../lib/supabase';
import type { MaterialLayer, PedidoKind, PedidoV2 } from '../types/productV2';
import { createPedidoV2ResultFromJson, type CreatePedidoV2Result } from '../utils/productV2Json';

export interface PedidoDraftItem {
  client_entry_id?: string;
  catalog_variant_id?: number;
  material_name?: string;
  requested_quantity: number;
  unit?: string;
  layer?: MaterialLayer;
}

interface PedidoListOptions {
  page?: number;
  pageSize?: number;
}

export const pedidosApi = {
  async getAll(options?: PedidoListOptions): Promise<{ data: PedidoV2[] }> {
    let query = supabase
      .from('pedidos')
      .select(`
        *,
        projects(name, location),
        profiles!pedidos_operator_id_fkey(username, full_name),
        pedido_items(*, pedido_receipts(*))
      `)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (options?.page && options?.pageSize) {
      const from = (options.page - 1) * options.pageSize;
      query = query.range(from, from + options.pageSize - 1);
    }
    const { data, error } = await query;
    if (error) throw error;
    return { data: (data || []) as PedidoV2[] };
  },

  // The current server state of one pedido, read before a decision or a manual
  // close so the admin never acts on a stale list.
  async getById(id: number): Promise<PedidoV2 | null> {
    const { data, error } = await supabase
      .from('pedidos')
      .select(`
        *,
        projects(name, location),
        profiles!pedidos_operator_id_fkey(username, full_name),
        pedido_items(*, pedido_receipts(*))
      `)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return (data as unknown as PedidoV2) ?? null;
  },

  async getAllPages(pageSize = 50): Promise<{ data: PedidoV2[] }> {
    const rows: PedidoV2[] = [];
    for (let page = 1; ; page += 1) {
      const response = await pedidosApi.getAll({ page, pageSize });
      rows.push(...response.data);
      if (response.data.length < pageSize) return { data: rows };
    }
  },

  async getRecent(limit = 12): Promise<{ data: PedidoV2[] }> {
    const { data, error } = await supabase
      .from('pedidos')
      .select('id, pedido_number, project_id, operator_id, material, quantity, status, kind, created_at, projects(name, location)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { data: (data || []) as unknown as PedidoV2[] };
  },

  async createV2(input: {
    clientEntryId: string;
    projectId: number;
    kind: PedidoKind;
    items: PedidoDraftItem[];
    justification?: string;
    priority?: string;
    neededBy?: string;
    notes?: string;
    enteredBy?: string | null;
  }): Promise<CreatePedidoV2Result> {
    const safeItems = input.items.map((item) => ({
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
      p_items: safeItems,
      p_client_entry_id: input.clientEntryId,
      p_justification: input.justification ?? null,
      p_priority: input.priority ?? 'Normal',
      p_needed_by: input.neededBy ?? null,
      p_notes: input.notes ?? null,
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;

    const result = createPedidoV2ResultFromJson(data);
    // Invoke on exact replays too: if the database commit succeeded but its
    // response was lost, the replay is the first chance to request delivery.
    // The server claim + provider idempotency key suppress duplicates.
    supabase.functions
      .invoke('notify-email', {
        body: { type: 'pedido_created', entity_id: result.pedido.id },
      })
      .catch((e) => console.warn('[notify-email] pedido_created failed:', e));
    return result;
  },

  // Compatibility adapter for already-queued v1 single-item drafts. New UI
  // uses createV2 directly; replaying an old outbox row remains safe.
  async create(data: {
    client_entry_id?: string;
    project_id?: number;
    material: string;
    quantity: number;
    priority?: string;
    reason?: string;
    needed_by?: string;
    pedido_type?: string;
    notes?: string;
  }, enteredBy?: string | null) {
    if (!data.client_entry_id || !data.project_id) {
      throw new Error('El pedido requiere proyecto e identificador de sincronización');
    }
    const kind: PedidoKind = data.pedido_type === 'personal' ? 'personal' : 'empresa';
    const result = await pedidosApi.createV2({
      clientEntryId: data.client_entry_id,
      projectId: data.project_id,
      kind,
      justification: kind === 'empresa' ? (data.reason || data.notes) : undefined,
      priority: data.priority,
      neededBy: data.needed_by,
      notes: data.notes,
      enteredBy,
      items: [{
        material_name: data.material,
        requested_quantity: data.quantity,
        unit: 'unidad',
        layer: 'extras',
      }],
    });
    return { ...result.pedido, pedido_items: result.items };
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
      p_reason: input.reason ?? null,
      p_layer: input.layer ?? 'extras',
    });
    if (error) throw error;
    return data;
  },

  async confirmReceipt(input: {
    itemId: number;
    clientEntryId: string;
    outcome: 'recibido' | 'parcial' | 'no_recibido';
    quantityReceived?: number;
    incidentNote?: string;
    enteredBy?: string | null;
  }) {
    const { data, error } = await supabase.rpc('confirm_pedido_item_receipt', {
      p_item_id: input.itemId,
      p_client_entry_id: input.clientEntryId,
      p_outcome: input.outcome,
      p_quantity_received: input.quantityReceived ?? 0,
      p_incident_note: input.incidentNote ?? null,
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;
    return data;
  },

  async closeManually(id: number, reason: string) {
    const { data, error } = await supabase.rpc('close_pedido_manually', {
      p_pedido_id: id,
      p_reason: reason,
    });
    if (error) throw error;
    return data;
  },

  async updateStatus(_id: number, _status: string, _adminNotes?: string) {
    throw new Error('Los estados de pedidos v2 solo avanzan mediante decisiones y recepciones.');
  },

  async approve(
    _id: number,
    _opts: { quantityOverride?: number; notes?: string } = {},
  ): Promise<never> {
    throw new Error('Pedidos v2: aprueba o rechaza cada ítem. La aprobación no modifica inventario.');
  },

  async reject(id: number, reason?: string) {
    const { data, error } = await supabase.rpc('reject_pedido', {
      p_pedido_id: id,
      p_reason: reason ?? null,
    });
    if (error) throw error;
    return data;
  },
};
