export type MaterialLayer = 'presupuesto' | 'extras';
export type PedidoKind = 'empresa' | 'personal';
export type PedidoItemState = 'solicitado' | 'aprobado' | 'rechazado' | 'recibido' | 'parcial' | 'no_recibido';
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

export interface PedidoReceipt {
  id: number;
  client_entry_id: string;
  pedido_item_id: number;
  outcome: 'recibido' | 'parcial' | 'no_recibido';
  quantity_received: number;
  incident_note?: string | null;
  confirmed_by?: string | null;
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
  updated_at?: string | null;
  projects?: { name?: string | null; location?: string | null } | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
  pedido_items?: PedidoItem[];
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
  projects?: { name?: string; location?: string };
  profiles?: { username?: string; full_name?: string };
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

export interface ProjectClosingAssignment {
  project_id: number;
  operator_id: string;
  assigned_by: string;
  created_at: string;
  updated_at: string;
  profiles?: OperatorDirectoryEntry | null;
}

export interface ProjectMaterialAssignment {
  id: number;
  project_id: number;
  material_name: string;
  quantity_allocated: number;
  initial_quantity: number;
  current_quantity: number;
  unit?: string | null;
  layer: MaterialLayer;
  catalog_variant_id?: number | null;
  active: boolean;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MaterialImportLineInput {
  externalCode?: string;
  description: string;
  quantity: number;
  unit: string;
  included: boolean;
  layer: MaterialLayer;
  catalogVariantId?: number;
  createNew?: boolean;
  materialType?: MaterialType;
  measurementMethod?: MeasurementMethod;
}

export interface MaterialImportResult {
  import_id: number;
  idempotent_replay: boolean;
  line_count: number;
  included_count?: number;
}

export interface MaterialReconciliation {
  id: number;
  project_id: number;
  project_material_id: number;
  sent_quantity: number;
  consumed_quantity: number;
  returned_quantity: number;
  missing_quantity: number;
  notes?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
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
  metadata: Record<string, unknown>;
  created_at: string;
  profiles?: { username?: string | null; full_name?: string | null } | null;
}

export interface RecordCorrection {
  id: number;
  project_id?: number | null;
  entity_type: string;
  entity_id: string;
  field_name: string;
  original_value: unknown;
  corrected_value: unknown;
  corrected_by: string;
  reason: string;
  created_at: string;
}

export interface ProjectDossier {
  project: Record<string, unknown> | null;
  bars: Array<Record<string, unknown>>;
  shifts: Shift[];
  materials: Array<Record<string, unknown>>;
  consumption: Array<Record<string, unknown>>;
  samples: Array<Record<string, unknown>>;
  company_pedidos: PedidoV2[];
  corrections: Array<Record<string, unknown>>;
  discrepancies: Array<Record<string, unknown>>;
  completion: Record<string, unknown> | null;
  attachments: Array<Record<string, unknown>>;
  reconciliations: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
}
