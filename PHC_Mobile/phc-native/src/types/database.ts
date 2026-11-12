export interface Well {
  id: string;
  name: string;
  project_id?: string;
  coordinates?: string;
  target_depth?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
  origin: string;
  version: number;
  deleted: number;
}

export interface ProgressLog {
  id: string;
  well_id: string;
  meters_drilled: number;
  rod_length: number;
  diameter: number;
  depth_reached: number;
  note?: string;
  photo_id?: string;
  timestamp_local: string;
  sync_status: string;
  origin: string;
  version: number;
  deleted: number;
  created_at?: string;
  updated_at?: string;
}

export interface MaterialCatalog {
  id: string;
  name: string;
  unit: string;
  active: number;
  created_at?: string;
  updated_at?: string;
}

export interface MaterialMovement {
  id: string;
  team_id: string;
  well_id?: string;
  project_id?: string;
  material_type_id: string;
  quantity: number;
  unit: string;
  movement_type: 'IN' | 'OUT';
  note?: string;
  photo_id?: string;
  timestamp_local: string;
  sync_status: string;
  origin: string;
  version: number;
  deleted: number;
  created_at?: string;
  updated_at?: string;
}

export interface Photo {
  id: string;
  local_uri: string;
  uploaded_url?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  well_id?: string;
  movement_id?: string;
  created_at?: string;
  updated_at?: string;
  sync_status: string;
  origin: string;
  version: number;
  deleted: number;
}

export interface OutboxEntry {
  id: string;
  entity: string;
  entity_id: string;
  op: string;
  payload_json: string;
  retries: number;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

// ============================================
// Dashboard & Projects Types
// ============================================

export interface Project {
  id: number;
  name: string;
  location: string;
  assigned_operator_id: string;
  progress: number;
  status: ProjectStatus;
  target_depth?: number;
  current_depth?: number;
  created_at: string;
  updated_at: string;
  deleted: number;
  operator_name?: string;
}

export type ProjectStatus = 'En Progreso' | 'Completado' | 'Pausado' | 'Planning' | 'active' | 'in_progress' | 'completed' | 'on_hold';

export interface Operator {
  id: string;
  name: string;
  role: string;
  status: string;
  pin?: string;
  created_at: string;
  updated_at: string;
}

export interface SupplyRequest {
  id: number;
  project_id: number;
  operator_id: string;
  material: string;
  quantity: number;
  priority: RequestPriority;
  reason?: string;
  needed_by?: string;
  status: RequestStatus;
  admin_notes?: string;
  created_at: string;
  updated_at: string;
  project_name?: string;
  operator_name?: string;
}

export type RequestPriority = 'Urgente' | 'Alta' | 'Normal' | 'Baja';
export type RequestStatus = 'Pendiente' | 'Aprobado' | 'Rechazado' | 'Entregado';

// ============================================
// Inventory Types
// ============================================

export interface MaterialInventoryItem {
  id: number;
  material_name: string;
  current_stock: number;
  min_stock: number;
  unit: string;
  location?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  status: InventoryStatus;
}

export type InventoryStatus = 'good' | 'low' | 'critical';

export interface ProjectMaterial {
  id: number;
  project_id: number;
  material_name: string;
  initial_quantity: number;
  current_quantity: number;
  unit: string;
  notes?: string;
  assigned_date: string;
  created_at: string;
  updated_at: string;
}

export interface MaterialConsumption {
  id: number;
  project_id: number;
  operator_id: string;
  material_name: string;
  quantity_used: number;
  unit: string;
  date: string;
  notes?: string;
  created_at: string;
  operator_name?: string;
}

// ============================================
// Progress Report Types
// ============================================

export interface ProgressLogDashboard {
  id: number;
  project_id: number;
  operator_id?: string;
  date: string;
  depth_start: number;
  depth_end: number;
  bars_added?: number;
  bar_type?: string;
  drilling_method?: string;
  soil_type?: string;
  water_level?: number;
  notes?: string;
  photo_paths?: string;
  created_at: string;
  updated_at: string;
  project_name?: string;
  operator_name?: string;
}

// ============================================
// Pagination Types
// ============================================

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

// ============================================
// Query Options Types
// ============================================

export interface QueryOptions {
  pagination?: PaginationParams;
  orderBy?: string;
  orderDir?: 'ASC' | 'DESC';
  filters?: Record<string, any>;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
