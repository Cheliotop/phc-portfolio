import type { ProjectStatus } from '../domain/projectStatus';
import type {
  CatalogMaterial,
  CatalogVariant,
  MaterialLayer,
  PedidoItem,
  PedidoKind,
  PedidoV2,
  ProjectMaterialAssignment,
  Shift,
} from './productV2';

/**
 * Public contract for the browser operator console.
 *
 * Keep these types free of admin-only mutation inputs. The console shares the
 * production Supabase project with the Android app, so the browser must call
 * the same invariant-preserving RPCs rather than writing operational tables.
 */

export interface OperatorProject {
  id: number;
  name: string;
  location?: string | null;
  description?: string | null;
  client?: string | null;
  project_type?: string | null;
  target_depth?: number | null;
  default_bar_length?: number | null;
  default_bar_diameter?: string | null;
  coordinates?: string | null;
  well_name?: string | null;
  status: ProjectStatus | string;
  start_date?: string | null;
  end_date?: string | null;
  estimated_completion?: string | null;
  progress_percentage?: number | null;
  assigned_operator_id: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export type OperatorProjectMaterial = ProjectMaterialAssignment;

export interface OperatorClosingAssignment {
  project_id: number;
  operator_id: string;
  created_at: string;
  updated_at: string;
}

export interface DrillingBar {
  id: number;
  client_entry_id?: string | null;
  project_id: number;
  operator_id: string;
  shift_id?: string | null;
  bar_number: number;
  depth_start: number;
  depth_end: number;
  length: number;
  diameter?: string | null;
  soil_type: string;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes?: number | null;
  water_level?: number | null;
  notes?: string | null;
  photo_paths?: string | null;
  timestamp_local?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  projects?: { name?: string | null } | null;
}

export interface CreateDrillingBarInput {
  client_entry_id: string;
  project_id: number;
  shift_id: string;
  soil_type: string;
  length?: number;
  diameter?: string;
  start_time?: string;
  end_time?: string;
  duration_minutes?: number;
  water_level?: number;
  notes?: string;
  photo_paths?: string;
  timestamp_local?: string;
}

export interface PedidoDraftItem {
  client_entry_id?: string;
  catalog_variant_id?: number;
  material_name?: string;
  requested_quantity: number;
  unit?: string;
  layer?: MaterialLayer;
}

export interface CreatePedidoV2Input {
  clientEntryId: string;
  projectId: number;
  kind: PedidoKind;
  items: PedidoDraftItem[];
  justification?: string;
  priority?: string;
  neededBy?: string;
  notes?: string;
}

export interface CreatePedidoV2Result {
  pedido: PedidoV2;
  items: PedidoItem[];
  idempotent_replay: boolean;
}

export interface ConfirmPedidoReceiptInput {
  itemId: number;
  clientEntryId: string;
  outcome: 'recibido' | 'parcial' | 'no_recibido';
  quantityReceived?: number;
  incidentNote?: string;
}

export interface ConfirmPedidoReceiptResult {
  receipt: {
    id: number;
    client_entry_id: string;
    pedido_item_id: number;
    outcome: 'recibido' | 'parcial' | 'no_recibido';
    quantity_received: number;
    incident_note?: string | null;
    confirmed_by: string;
    created_at: string;
  };
  item: PedidoItem;
  idempotent_replay: boolean;
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
  timestamp_local?: string | null;
  device_time_flag: boolean;
  created_at?: string | null;
  projects?: { name?: string | null } | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
}

export interface RegisterWaterSampleInput {
  clientEntryId: string;
  projectId: number;
  takenAt: string;
  depthM?: number;
  stage?: string;
  notes?: string;
  bottlePhotoPath?: string;
  timestampLocal?: string;
}

export interface CasingLayoutRow {
  order: number;
  type: 'ciego' | 'filtro' | 'deposito' | 'otro';
  meters: number;
  diameter?: string;
  notes?: string;
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
  casing_total_m: number;
  casing_above_ground_m: number;
  blind_casing_m: number;
  filter_casing_m: number;
  sediment_trap_m: number;
  centralizer_count: number;
  bottom_plug_details: string;
  bentonite_quantity: number;
  gravel_quantity: number;
  casing_layout: CasingLayoutRow[];
  compressor_hours?: number;
  pump_hours?: number;
  water_quality?: string;
  installed_meters?: number;
  perforated_meters?: number;
}

export interface OperatorCompletionReport {
  id: number;
  client_entry_id?: string | null;
  project_id: number;
  operator_id: string;
  format_version: number;
  status: string;
  operator_signature?: string | null;
  admin_signature?: string | null;
  completion_notes?: string | null;
  last_resubmission_id?: string | null;
  return_reason?: string | null;
  returned_at?: string | null;
  returned_by?: string | null;
  pdf_url?: string | null;
  submitted_at?: string | null;
  finalized_at?: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface CompletionDiscrepancy {
  id: number;
  project_id: number;
  completion_report_id?: number | null;
  section: string;
  description: string;
  reported_by: string;
  status: 'open' | 'resolved';
  resolution_note?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface OperatorFichaPreview {
  project: Record<string, unknown> | null;
  bars: DrillingBar[];
  shifts: Shift[];
  shift_handovers: Array<Record<string, unknown>>;
  photos: Array<Record<string, unknown>>;
  materials: OperatorProjectMaterial[];
  consumption: Array<Record<string, unknown>>;
  samples: WaterSample[];
  company_pedidos: PedidoV2[];
  corrections: Array<Record<string, unknown>>;
  discrepancies: CompletionDiscrepancy[];
  completion: OperatorCompletionReport | null;
}

export interface SubmitCompletionV2Input {
  projectId: number;
  clientEntryId: string;
  finalFields: CompletionFinalFields;
  operatorSignature: string;
  completionNotes?: string;
  pdfUrl?: string;
}

export interface ResubmitCompletionV2Input extends SubmitCompletionV2Input {
  reportId: number;
}

export type ActiveOperatorCatalog = Array<
  CatalogMaterial & { catalog_variants?: CatalogVariant[] }
>;
