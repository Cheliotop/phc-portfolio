import type { Json } from './supabase.generated';

export type JsonObject = { [key: string]: Json | undefined };

export type MaterialLayer = 'presupuesto' | 'extras';
export type MaterialType = 'consumable' | 'tool' | 'fuel' | 'food' | 'pipe' | 'cement' | 'cable' | 'other';
export type MeasurementMethod = 'quantity' | 'volume' | 'weight' | 'length' | 'diameter_length';
export type ShiftStatus = 'open' | 'report_pending' | 'closed';

export interface CatalogVariant {
  id: number;
  material_id: number;
  display_name: string;
  external_code?: string | null;
  diameter?: string | null;
  length_m?: number | null;
  dimension_text?: string | null;
  active: boolean;
}

export interface CatalogMaterial {
  id: number;
  name: string;
  external_code?: string | null;
  material_type: MaterialType;
  unit: string;
  measurement_method: MeasurementMethod;
  active: boolean;
  catalog_variants?: CatalogVariant[];
}

export interface Shift {
  id: string;
  client_entry_id?: string | null;
  project_id: number;
  operator_id: string;
  status: ShiftStatus;
  started_at: string;
  ended_at?: string | null;
  start_device_time?: string | null;
  end_device_time?: string | null;
  end_type?: 'manual' | 'auto' | 'admin' | null;
  usage_report_submitted: boolean;
  handover_confirmed: boolean;
  device_time_flag: boolean;
  reassigned_during_shift?: boolean;
  notes?: string | null;
  projects?: { name?: string | null; location?: string | null } | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
  shift_handovers?: ShiftHandover[];
}

export interface ShiftHandover {
  id: number;
  shift_id: string;
  project_material_id: number;
  status: 'confirmed' | 'flagged';
  expected_quantity: number;
  observed_quantity?: number | null;
  note?: string | null;
  photo_path?: string | null;
  confirmed_by: string;
  created_at: string;
  project_materials?: { material_name?: string | null; unit?: string | null } | null;
}

export interface OperatorDirectoryEntry {
  id: string;
  username: string;
  full_name?: string | null;
  is_active: boolean;
}

export interface OperatorAccountabilityMetrics {
  operator_id: string;
  current_project: { id?: number; name?: string; location?: string | null; status?: string } | null;
  current_shift: Shift | null;
  shifts_completed: number;
  hours_worked: number;
  bars_registered: number;
  average_bar_minutes: number;
  material_reports_submitted: number;
  missing_or_late_reports: number;
  /** Shifts whose times disagree with the server clock or overlap another shift. */
  flagged_shifts: number;
  active_pedidos: number;
  last_activity?: string | null;
  account_active: boolean;
  operator?: OperatorDirectoryEntry;
}

export interface AuditEntry {
  id: number;
  project_id?: number | null;
  actor_id?: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data?: Record<string, unknown> | null;
  after_data?: Record<string, unknown> | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  profiles?: { username?: string | null; full_name?: string | null } | null;
}

export interface ShiftUsageInput {
  client_entry_id?: string;
  project_material_id: number;
  quantity_used: number;
  approximate?: boolean;
  notes?: string;
  date?: string;
}

export interface HandoverInput {
  client_entry_id?: string;
  project_material_id: number;
  status: 'confirmed' | 'flagged';
  expected_quantity: number;
  observed_quantity?: number;
  note?: string;
  photo_path?: string;
}

export type PedidoKind = 'empresa' | 'personal';
export type PedidoItemState =
  | 'solicitado'
  | 'aprobado'
  | 'rechazado'
  | 'recibido'
  | 'parcial'
  | 'no_recibido';

export interface PedidoReceipt {
  id: number;
  client_entry_id: string;
  pedido_item_id: number;
  outcome: 'recibido' | 'parcial' | 'no_recibido';
  quantity_received: number;
  incident_note?: string | null;
  created_at: string;
}

export interface PedidoItem {
  id: number;
  client_entry_id?: string | null;
  pedido_id: number;
  catalog_variant_id?: number | null;
  material_name_snapshot: string;
  requested_quantity: number;
  unit_snapshot: string;
  state: PedidoItemState;
  approved_quantity?: number | null;
  received_quantity: number;
  layer: MaterialLayer;
  decision_reason?: string | null;
  incident_note?: string | null;
  pedido_receipts?: PedidoReceipt[];
}

export interface PedidoV2 {
  id: number;
  pedido_number?: string | null;
  client_entry_id?: string | null;
  project_id: number;
  operator_id: string;
  kind: PedidoKind;
  justification?: string | null;
  priority: string;
  status: string;
  needed_by?: string | null;
  notes?: string | null;
  closed_manually: boolean;
  created_at: string;
  projects?: { name?: string | null; location?: string | null } | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
  pedido_items?: PedidoItem[];
}

export interface WaterSample {
  id: number;
  client_entry_id?: string | null;
  project_id: number;
  sample_number: number;
  depth_m?: number | null;
  stage?: string | null;
  operator_id: string;
  notes?: string | null;
  bottle_photo_path?: string | null;
  taken_at: string;
  device_time_flag: boolean;
}

export interface CompletionFinalFields {
  static_level: number;
  dynamic_level: number;
  flow_rate: number;
  specific_flow_rate?: number;
  maximum_flow_rate: number;
  pump_depth_m: number;
  exploration_depth_m: number;
  widening_depth_m: number;
  casing_total_m?: number;
  casing_above_ground_m?: number;
  blind_casing_m?: number;
  filter_casing_m?: number;
  sediment_trap_m?: number;
  centralizer_count?: number;
  bottom_plug_details?: string;
  bentonite_quantity?: number;
  gravel_quantity?: number;
  casing_layout: Array<{
    order: number;
    type: 'ciego' | 'filtro' | 'deposito' | 'otro';
    meters: number;
    diameter?: string;
    notes?: string;
  }>;
  compressor_hours?: number;
  pump_hours?: number;
  water_quality?: string;
  installed_meters?: number;
  perforated_meters?: number;
}

export interface ProjectDossier {
  project: JsonObject | null;
  bars: JsonObject[];
  shifts: JsonObject[];
  materials: JsonObject[];
  consumption: JsonObject[];
  samples: JsonObject[];
  company_pedidos: JsonObject[];
  corrections: JsonObject[];
  discrepancies: JsonObject[];
  completion: JsonObject | null;
  attachments?: JsonObject[];
  reconciliations?: JsonObject[];
  audit?: JsonObject[];
}
