import { supabase } from '../lib/supabase';
import type {
  AuditEntry,
  MaterialImportLineInput,
  MaterialImportResult,
  MaterialLayer,
  MaterialReconciliation,
  ProjectClosingAssignment,
  ProjectMaterialAssignment,
  RecordCorrection,
} from '../types/productV2';
import { friendlyApiError } from './supabase-api-errors';

export interface AuditFilters {
  projectId?: number;
  actorId?: string;
  entityType?: string;
  action?: string;
  limit?: number;
}

export const productProjectsApi = {
  /**
   * Finds the record a correction targets, always inside one well (audit WEB-1):
   * bars and samples by the number the admin sees, the Ficha by its well, and
   * shifts and consumptions by id, refused when the id belongs to another well.
   */
  async getCorrectionRecord(
    entityType: 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports',
    projectId: number,
    reference: string,
  ) {
    let query = supabase
      .from(entityType)
      .select('*, projects(name, well_name)')
      .eq('project_id', projectId);
    if (entityType === 'drilling_bars') query = query.eq('bar_number', reference);
    else if (entityType === 'water_samples') query = query.eq('sample_number', reference);
    else if (entityType === 'completion_reports') {
      query = query.order('format_version', { ascending: false }).order('id', { ascending: false }).limit(1);
    } else query = query.eq('id', reference);
    const { data, error } = await query.maybeSingle();
    if (error) throw friendlyApiError(error, 'No se pudo buscar el registro para corregir.');
    return data as Record<string, unknown> | null;
  },

  async getClosingAssignments(projectId?: number): Promise<ProjectClosingAssignment[]> {
    let query = supabase
      .from('project_closing_assignments')
      .select('project_id, operator_id, assigned_by, created_at, updated_at, profiles!project_closing_assignments_operator_id_fkey(id, username, full_name, is_active)')
      .order('updated_at', { ascending: false });
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los responsables de cierre.');
    return (data || []) as unknown as ProjectClosingAssignment[];
  },

  async setClosingOperator(projectId: number, operatorId: string): Promise<ProjectClosingAssignment> {
    const { data, error } = await supabase.rpc('set_project_closing_operator', {
      p_project_id: projectId,
      p_operator_id: operatorId,
    });
    if (error) throw friendlyApiError(error, 'No se pudo asignar el responsable de cierre.');
    return data as ProjectClosingAssignment;
  },

  async getMaterialAssignments(projectId: number, includeInactive = false): Promise<ProjectMaterialAssignment[]> {
    let query = supabase
      .from('project_materials')
      .select('id, project_id, material_name, quantity_allocated, initial_quantity, current_quantity, unit, layer, catalog_variant_id, active, notes, created_at, updated_at')
      .eq('project_id', projectId)
      .order('material_name', { ascending: true });
    if (!includeInactive) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los materiales del proyecto.');
    return (data || []) as ProjectMaterialAssignment[];
  },

  /** Active materials of these wells, in one paged request (code read W5). */
  async getActiveMaterialAssignmentsFor(projectIds: number[]): Promise<ProjectMaterialAssignment[]> {
    if (projectIds.length === 0) return [];
    const rows: ProjectMaterialAssignment[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('project_materials')
        .select('id, project_id, material_name, quantity_allocated, initial_quantity, current_quantity, unit, layer, catalog_variant_id, active, notes, created_at, updated_at')
        .in('project_id', projectIds)
        .eq('active', true)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw friendlyApiError(error, 'No se pudieron cargar los materiales de los proyectos.');
      rows.push(...((data || []) as ProjectMaterialAssignment[]));
      if (!data || data.length < 1000) return rows;
    }
  },

  async assignCatalogMaterial(input: {
    projectId: number;
    variantId: number;
    quantity: number;
    layer: MaterialLayer;
    notes?: string;
  }): Promise<ProjectMaterialAssignment> {
    const { data, error } = await supabase.rpc('assign_catalog_material_to_project', {
      p_project_id: input.projectId,
      p_catalog_variant_id: input.variantId,
      p_quantity: input.quantity,
      p_layer: input.layer,
      p_notes: input.notes?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo asignar el material al proyecto.');
    return data as ProjectMaterialAssignment;
  },

  async updateMaterialAssignment(id: number, newTotal: number, notes?: string): Promise<ProjectMaterialAssignment> {
    const { data, error } = await supabase.rpc('update_project_material_assignment', {
      p_assignment_id: id,
      p_new_total: newTotal,
      p_notes: notes?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo ajustar el material asignado.');
    return data as ProjectMaterialAssignment;
  },

  async deactivateMaterialAssignment(id: number, reason: string): Promise<ProjectMaterialAssignment> {
    const { data, error } = await supabase.rpc('deactivate_project_material_assignment', {
      p_assignment_id: id,
      p_reason: reason.trim(),
    });
    if (error) throw friendlyApiError(error, 'No se pudo desactivar el material asignado.');
    return data as ProjectMaterialAssignment;
  },

  async importMaterials(input: {
    projectId: number;
    documentNumber: string;
    sourceName?: string;
    lines: MaterialImportLineInput[];
  }): Promise<MaterialImportResult> {
    // Allow-list only operational material fields. Prices, taxes and balances
    // cannot cross this adapter even if a caller passes a wider object.
    const safeLines = input.lines.map((line) => ({
      external_code: line.externalCode?.trim() || null,
      description: line.description.trim(),
      quantity: line.quantity,
      unit: line.unit.trim(),
      included: line.included,
      layer: line.layer,
      catalog_variant_id: line.catalogVariantId ?? null,
      create_new: line.createNew ?? false,
      material_type: line.materialType ?? 'other',
      measurement_method: line.measurementMethod ?? 'quantity',
    }));
    const { data, error } = await supabase.rpc('import_project_materials', {
      p_project_id: input.projectId,
      p_document_number: input.documentNumber.trim(),
      p_lines: safeLines,
      p_source_name: input.sourceName?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo importar el presupuesto.');
    return data as MaterialImportResult;
  },

  async getReconciliations(projectId: number): Promise<MaterialReconciliation[]> {
    const { data, error } = await supabase
      .from('material_reconciliations')
      .select('id, project_id, project_material_id, sent_quantity, consumed_quantity, returned_quantity, missing_quantity, notes, created_by, created_at, updated_at')
      .eq('project_id', projectId)
      .order('id', { ascending: true });
    if (error) throw friendlyApiError(error, 'No se pudo cargar la reconciliación.');
    return (data || []) as MaterialReconciliation[];
  },

  async saveReconciliation(input: {
    projectId: number;
    projectMaterialId: number;
    returnedQuantity: number;
    notes?: string;
  }): Promise<MaterialReconciliation> {
    const { data, error } = await supabase.rpc('save_material_reconciliation', {
      p_project_id: input.projectId,
      p_project_material_id: input.projectMaterialId,
      p_returned_quantity: input.returnedQuantity,
      p_notes: input.notes?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo guardar la reconciliación.');
    return data as MaterialReconciliation;
  },

  async recordCorrection(input: {
    entityType: 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports';
    entityId: string;
    fieldName: string;
    correctedValue: unknown;
    reason: string;
  }): Promise<RecordCorrection> {
    const { data, error } = await supabase.rpc('record_admin_correction', {
      p_entity_type: input.entityType,
      p_entity_id: input.entityId,
      p_field_name: input.fieldName.trim(),
      p_corrected_value: input.correctedValue,
      p_reason: input.reason.trim(),
    });
    if (error) throw friendlyApiError(error, 'No se pudo registrar la corrección.');
    return data as RecordCorrection;
  },

  /** The newest events plus the exact count the filters match (audit WEB-7). */
  async getAudit(filters: AuditFilters = {}): Promise<{ rows: AuditEntry[]; total: number }> {
    let query = supabase
      .from('audit_log')
      .select('id, project_id, actor_id, action, entity_type, entity_id, before_data, after_data, reason, metadata, created_at, profiles!audit_log_actor_id_fkey(username, full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(filters.limit ?? 150, 1), 500));
    if (filters.projectId) query = query.eq('project_id', filters.projectId);
    if (filters.actorId) query = query.eq('actor_id', filters.actorId);
    if (filters.entityType) query = query.eq('entity_type', filters.entityType);
    if (filters.action?.trim()) query = query.ilike('action', `%${filters.action.trim()}%`);
    const { data, error, count } = await query;
    if (error) throw friendlyApiError(error, 'No se pudo cargar el historial de auditoría.');
    const rows = (data || []) as AuditEntry[];
    return { rows, total: count ?? rows.length };
  },
};
