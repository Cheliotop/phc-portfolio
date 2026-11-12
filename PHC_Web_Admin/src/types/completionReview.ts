export type JsonRecord = Record<string, unknown>;

export interface CompletionReport extends JsonRecord {
  id: number;
  project_id: number;
  operator_id: string;
  format_version?: number | null;
  status: string;
  admin_signature?: string | null;
  operator_signature?: string | null;
  client_signature?: string | null;
  pdf_url?: string | null;
  submitted_at?: string | null;
  finalized_at?: string | null;
  return_reason?: string | null;
  returned_by?: string | null;
  returned_at?: string | null;
  last_resubmission_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  projects?: {
    name?: string | null;
    well_name?: string | null;
    location?: string | null;
  } | null;
  profiles?: {
    full_name?: string | null;
    username?: string | null;
  } | null;
}

export interface CompletionDiscrepancy extends JsonRecord {
  id: number;
  project_id: number;
  completion_report_id?: number | null;
  section: string;
  description: string;
  status: 'open' | 'resolved';
  resolution_note?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface ProjectMaterialRecord extends JsonRecord {
  id: number;
  material_name?: string | null;
  unit?: string | null;
  layer?: string | null;
  active?: boolean | null;
  initial_quantity?: number | null;
  current_quantity?: number | null;
}

export interface MaterialReconciliationRecord extends JsonRecord {
  id: number;
  project_material_id: number;
  sent_quantity?: number | null;
  consumed_quantity?: number | null;
  returned_quantity?: number | null;
  missing_quantity?: number | null;
  notes?: string | null;
}

export interface CompanyPedidoRecord extends JsonRecord {
  id: number;
  status?: string | null;
  pedido_number?: string | null;
  justification?: string | null;
  created_at?: string | null;
  items?: Array<JsonRecord & { receipts?: JsonRecord[] }>;
}

export interface ProjectAttachmentRecord extends JsonRecord {
  id: number;
  kind?: string | null;
  storage_path: string;
  filename?: string | null;
  mime_type?: string | null;
  notes?: string | null;
  uploaded_at?: string | null;
}

export interface ProjectDossier {
  project: JsonRecord | null;
  bars: JsonRecord[];
  shifts: JsonRecord[];
  shift_handovers: JsonRecord[];
  photos: JsonRecord[];
  materials: ProjectMaterialRecord[];
  consumption: JsonRecord[];
  samples: JsonRecord[];
  company_pedidos: CompanyPedidoRecord[];
  corrections: JsonRecord[];
  discrepancies: CompletionDiscrepancy[];
  completion: JsonRecord | null;
  attachments: ProjectAttachmentRecord[];
  reconciliations: MaterialReconciliationRecord[];
  audit: JsonRecord[];
}
