import supabase from '../lib/supabase';
import type { Json } from '../types/supabase.generated';
import { projectDossierFromJson } from '../utils/productV2Json';
import type {
  AuditEntry,
  CatalogMaterial,
  CatalogVariant,
  MaterialLayer,
  ProjectDossier,
} from '../types/productV2';

export const productV2Api = {
  async getCatalog(includeInactive = false): Promise<CatalogMaterial[]> {
    let query = supabase
      .from('catalog_materials')
      .select('*, catalog_variants(*)')
      .order('name');
    if (!includeInactive) {
      query = query.eq('active', true);
    }
    const { data, error } = await query;
    if (error) throw error;
    return ((data || []) as CatalogMaterial[]).map((material) => ({
      ...material,
      catalog_variants: [...(material.catalog_variants || [])].sort((a, b) =>
        a.display_name.localeCompare(b.display_name, 'es'),
      ),
    }));
  },

  async saveCatalogMaterial(input: {
    id?: number;
    name: string;
    unit: string;
    materialType: CatalogMaterial['material_type'];
    measurementMethod: CatalogMaterial['measurement_method'];
    externalCode?: string;
    active?: boolean;
  }): Promise<CatalogMaterial> {
    const { data, error } = await supabase.rpc('upsert_catalog_material', {
      p_name: input.name,
      p_unit: input.unit,
      p_material_type: input.materialType,
      p_measurement_method: input.measurementMethod,
      p_external_code: input.externalCode ?? null,
      p_active: input.active ?? true,
      p_material_id: input.id ?? null,
    });
    if (error) throw error;
    return data as CatalogMaterial;
  },

  async saveCatalogVariant(input: {
    id?: number;
    materialId: number;
    displayName: string;
    externalCode?: string;
    diameter?: string;
    lengthM?: number;
    dimensionText?: string;
    active?: boolean;
  }): Promise<CatalogVariant> {
    const { data, error } = await supabase.rpc('upsert_catalog_variant', {
      p_material_id: input.materialId,
      p_display_name: input.displayName,
      p_external_code: input.externalCode ?? null,
      p_diameter: input.diameter ?? null,
      p_length_m: input.lengthM ?? null,
      p_dimension_text: input.dimensionText ?? null,
      p_active: input.active ?? true,
      p_variant_id: input.id ?? null,
    });
    if (error) throw error;
    return data as CatalogVariant;
  },

  // Subcontractor operators on a well. The responsible operator stays
  // projects.assigned_operator_id; these may log field work but cannot create
  // pedidos or close the well (enforced in RLS and the RPCs, not here).
  async getSecondaryOperators(projectId: number) {
    const { data, error } = await supabase
      .from('project_secondary_operators')
      .select('project_id, operator_id, created_at')
      .eq('project_id', projectId);
    if (error) throw error;
    return data || [];
  },

  // Every subcontractor assignment this user is allowed to see. No filter is
  // needed or wanted: the "Team members read secondary assignments" policy
  // already scopes the result to the caller's own assignments plus the wells
  // they are responsible for. Adding an `.eq('operator_id', me)` here would
  // break the admin case, which needs the whole set to count them.
  async getVisibleSecondaryAssignments() {
    const { data, error } = await supabase
      .from('project_secondary_operators')
      .select('project_id, operator_id, created_at');
    if (error) throw error;
    return data || [];
  },

  async addSecondaryOperator(projectId: number, operatorId: string) {
    const { error } = await supabase
      .from('project_secondary_operators')
      .insert({ project_id: projectId, operator_id: operatorId });
    if (error) throw error;
  },

  async removeSecondaryOperator(projectId: number, operatorId: string) {
    const { error } = await supabase
      .from('project_secondary_operators')
      .delete()
      .eq('project_id', projectId)
      .eq('operator_id', operatorId);
    if (error) throw error;
  },

  async setClosingOperator(projectId: number, operatorId: string) {
    const { data, error } = await supabase.rpc('set_project_closing_operator', {
      p_project_id: projectId,
      p_operator_id: operatorId,
    });
    if (error) throw error;
    return data;
  },

  async getClosingAssignments(projectId?: number) {
    let query = supabase
      .from('project_closing_assignments')
      .select('*, profiles!project_closing_assignments_operator_id_fkey(id, username, full_name, is_active)');
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async assignCatalogMaterial(input: {
    projectId: number;
    variantId: number;
    quantity: number;
    layer: MaterialLayer;
    notes?: string;
  }) {
    const { data, error } = await supabase.rpc('assign_catalog_material_to_project', {
      p_project_id: input.projectId,
      p_catalog_variant_id: input.variantId,
      p_quantity: input.quantity,
      p_layer: input.layer,
      p_notes: input.notes ?? null,
    });
    if (error) throw error;
    return data;
  },

  async updateAssignment(id: number, newTotal: number, notes?: string) {
    const { data, error } = await supabase.rpc('update_project_material_assignment', {
      p_assignment_id: id,
      p_new_total: newTotal,
      p_notes: notes ?? null,
    });
    if (error) throw error;
    return data;
  },

  async deactivateAssignment(id: number, reason: string) {
    const { data, error } = await supabase.rpc('deactivate_project_material_assignment', {
      p_assignment_id: id,
      p_reason: reason,
    });
    if (error) throw error;
    return data;
  },

  async importMaterials(input: {
    projectId: number;
    documentNumber: string;
    sourceName?: string;
    lines: Array<{
      code?: string;
      description: string;
      quantity: number;
      unit: string;
      included: boolean;
      layer: MaterialLayer;
      catalog_variant_id?: number;
      create_new?: boolean;
      material_type?: CatalogMaterial['material_type'];
      measurement_method?: CatalogMaterial['measurement_method'];
    }>;
  }) {
    // Deliberately construct an allow-listed payload. Monetary fields from an
    // accounting export never cross this API boundary.
    const lines = input.lines.map((line) => ({
      external_code: line.code || null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      included: line.included,
      layer: line.layer,
      catalog_variant_id: line.catalog_variant_id ?? null,
      create_new: line.create_new ?? false,
      material_type: line.material_type ?? 'other',
      measurement_method: line.measurement_method ?? 'quantity',
    }));
    const { data, error } = await supabase.rpc('import_project_materials', {
      p_project_id: input.projectId,
      p_document_number: input.documentNumber,
      p_lines: lines,
      p_source_name: input.sourceName ?? null,
    });
    if (error) throw error;
    return data;
  },

  async saveReconciliation(input: {
    projectId: number;
    projectMaterialId: number;
    returnedQuantity: number;
    notes?: string;
  }) {
    const { data, error } = await supabase.rpc('save_material_reconciliation', {
      p_project_id: input.projectId,
      p_project_material_id: input.projectMaterialId,
      p_returned_quantity: input.returnedQuantity,
      p_notes: input.notes ?? null,
    });
    if (error) throw error;
    return data;
  },

  async recordCorrection(input: {
    entityType: 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports';
    entityId: string;
    fieldName: string;
    correctedValue: Json;
    reason: string;
  }) {
    const { data, error } = await supabase.rpc('record_admin_correction', {
      p_entity_type: input.entityType,
      p_entity_id: input.entityId,
      p_field_name: input.fieldName,
      p_corrected_value: input.correctedValue,
      p_reason: input.reason,
    });
    if (error) throw error;
    return data;
  },

  // Looks up the record a correction targets, inside the well the admin picked,
  // so the phone can show the well, the record and the current value first.
  async getCorrectionRecord(
    entityType: 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports',
    projectId: number,
    reference: string,
  ) {
    // The table is picked at runtime, so the column filters are loosely typed here.
    let query: any = supabase
      .from(entityType)
      .select('*, projects(name, well_name)')
      .eq('project_id', projectId);
    if (entityType === 'drilling_bars') query = query.eq('bar_number', reference);
    else if (entityType === 'water_samples') query = query.eq('sample_number', reference);
    else if (entityType === 'completion_reports') {
      query = query.order('format_version', { ascending: false }).order('id', { ascending: false }).limit(1);
    } else query = query.eq('id', reference);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return (data as Record<string, unknown> | null) ?? null;
  },

  // One transaction for operador 1 and operador 2 of a well (set_project_equipo).
  async setProjectEquipo(projectId: number, operatorId: string | null, partnerId: string | null) {
    // Not in the generated types yet; called through a loose alias, bound to the client.
    const looseRpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => ReturnType<typeof supabase.rpc>;
    const { data, error } = await looseRpc('set_project_equipo', {
      p_project_id: projectId,
      p_operator_id: operatorId,
      p_partner_id: partnerId,
    });
    if (error) throw error;
    return data;
  },

  async getAudit(filters: {
    projectId?: number;
    actorId?: string;
    entityType?: string;
    action?: string;
    limit?: number;
  } = {}): Promise<AuditEntry[]> {
    let query = supabase
      .from('audit_log')
      .select('*, profiles!audit_log_actor_id_fkey(username, full_name)')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(filters.limit ?? 150, 1), 500));
    if (filters.projectId) query = query.eq('project_id', filters.projectId);
    if (filters.actorId) query = query.eq('actor_id', filters.actorId);
    if (filters.entityType) query = query.eq('entity_type', filters.entityType);
    if (filters.action?.trim()) query = query.ilike('action', `%${filters.action.trim()}%`);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []) as AuditEntry[];
  },

  async getDossier(projectId: number): Promise<ProjectDossier> {
    const { data, error } = await supabase.rpc('get_admin_project_dossier', {
      p_project_id: projectId,
    });
    if (error) throw error;
    return projectDossierFromJson(data);
  },
};
