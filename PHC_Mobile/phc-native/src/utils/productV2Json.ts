import type { Json } from '../types/supabase.generated';
import type {
  CompletionFinalFields,
  JsonObject,
  PedidoKind,
  PedidoV2,
  ProjectDossier,
} from '../types/productV2';

export interface CreatePedidoV2Result {
  pedido: PedidoV2;
  items: JsonObject[];
  idempotent_replay: boolean;
}

const isJsonObject = (value: Json | undefined): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const requireObject = (value: Json | undefined, field: string): JsonObject => {
  if (!isJsonObject(value)) {
    throw new Error(`Respuesta inválida del servidor: ${field} debe ser un objeto`);
  }
  return value;
};

const requireObjectArray = (value: Json | undefined, field: string): JsonObject[] => {
  if (!Array.isArray(value) || !value.every(isJsonObject)) {
    throw new Error(`Respuesta inválida del servidor: ${field} debe ser una lista de objetos`);
  }
  return value;
};

const optionalObjectArray = (value: Json | undefined, field: string): JsonObject[] | undefined => {
  if (value === undefined) return undefined;
  return requireObjectArray(value, field);
};

const requireString = (value: Json | undefined, field: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`Respuesta inválida del servidor: ${field} debe ser texto`);
  }
  return value;
};

const optionalString = (value: Json | undefined, field: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error(`Respuesta inválida del servidor: ${field} debe ser texto o null`);
};

const requireNumber = (value: Json | undefined, field: string): number => {
  if (typeof value !== 'number') {
    throw new Error(`Respuesta inválida del servidor: ${field} debe ser numérico`);
  }
  return value;
};

const requireBoolean = (value: Json | undefined, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`Respuesta inválida del servidor: ${field} debe ser booleano`);
  }
  return value;
};

export const projectDossierFromJson = (value: Json): ProjectDossier => {
  const dossier = requireObject(value, 'ficha');
  const project = dossier.project === null ? null : requireObject(dossier.project, 'project');
  const completion = dossier.completion === null ? null : requireObject(dossier.completion, 'completion');
  return {
    project,
    bars: requireObjectArray(dossier.bars, 'bars'),
    shifts: requireObjectArray(dossier.shifts, 'shifts'),
    materials: requireObjectArray(dossier.materials, 'materials'),
    consumption: requireObjectArray(dossier.consumption, 'consumption'),
    samples: requireObjectArray(dossier.samples, 'samples'),
    company_pedidos: requireObjectArray(dossier.company_pedidos, 'company_pedidos'),
    corrections: requireObjectArray(dossier.corrections, 'corrections'),
    discrepancies: requireObjectArray(dossier.discrepancies, 'discrepancies'),
    completion,
    attachments: optionalObjectArray(dossier.attachments, 'attachments'),
    reconciliations: optionalObjectArray(dossier.reconciliations, 'reconciliations'),
    audit: optionalObjectArray(dossier.audit, 'audit'),
  };
};

export const completionFinalFieldsToJson = (fields: CompletionFinalFields): Json => ({
  static_level: fields.static_level,
  dynamic_level: fields.dynamic_level,
  flow_rate: fields.flow_rate,
  specific_flow_rate: fields.specific_flow_rate,
  maximum_flow_rate: fields.maximum_flow_rate,
  pump_depth_m: fields.pump_depth_m,
  exploration_depth_m: fields.exploration_depth_m,
  widening_depth_m: fields.widening_depth_m,
  casing_total_m: fields.casing_total_m,
  casing_above_ground_m: fields.casing_above_ground_m,
  blind_casing_m: fields.blind_casing_m,
  filter_casing_m: fields.filter_casing_m,
  sediment_trap_m: fields.sediment_trap_m,
  centralizer_count: fields.centralizer_count,
  bottom_plug_details: fields.bottom_plug_details,
  bentonite_quantity: fields.bentonite_quantity,
  gravel_quantity: fields.gravel_quantity,
  casing_layout: fields.casing_layout.map((row) => ({
    order: row.order,
    type: row.type,
    meters: row.meters,
    diameter: row.diameter,
    notes: row.notes,
  })),
  compressor_hours: fields.compressor_hours,
  pump_hours: fields.pump_hours,
  water_quality: fields.water_quality,
  installed_meters: fields.installed_meters,
  perforated_meters: fields.perforated_meters,
});

export const createPedidoV2ResultFromJson = (value: Json): CreatePedidoV2Result => {
  const result = requireObject(value, 'pedido');
  const rawPedido = requireObject(result.pedido, 'pedido.pedido');
  const rawKind = requireString(rawPedido.kind, 'pedido.pedido.kind');
  if (rawKind !== 'empresa' && rawKind !== 'personal') {
    throw new Error('Respuesta inválida del servidor: pedido.pedido.kind no es válido');
  }
  const kind: PedidoKind = rawKind;
  const pedido: PedidoV2 = {
    // Preserve server fields that this client version does not consume while
    // validating and overriding every field used by offline reconciliation.
    ...rawPedido,
    id: requireNumber(rawPedido.id, 'pedido.pedido.id'),
    pedido_number: optionalString(rawPedido.pedido_number, 'pedido.pedido.pedido_number'),
    client_entry_id: optionalString(rawPedido.client_entry_id, 'pedido.pedido.client_entry_id'),
    project_id: requireNumber(rawPedido.project_id, 'pedido.pedido.project_id'),
    operator_id: requireString(rawPedido.operator_id, 'pedido.pedido.operator_id'),
    kind,
    justification: optionalString(rawPedido.justification, 'pedido.pedido.justification'),
    priority: requireString(rawPedido.priority, 'pedido.pedido.priority'),
    status: requireString(rawPedido.status, 'pedido.pedido.status'),
    needed_by: optionalString(rawPedido.needed_by, 'pedido.pedido.needed_by'),
    notes: optionalString(rawPedido.notes, 'pedido.pedido.notes'),
    closed_manually: requireBoolean(rawPedido.closed_manually, 'pedido.pedido.closed_manually'),
    created_at: requireString(rawPedido.created_at, 'pedido.pedido.created_at'),
  };
  return {
    pedido,
    items: requireObjectArray(result.items, 'pedido.items'),
    idempotent_replay: requireBoolean(result.idempotent_replay, 'pedido.idempotent_replay'),
  };
};
