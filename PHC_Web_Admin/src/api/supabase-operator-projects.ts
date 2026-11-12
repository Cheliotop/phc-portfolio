import { isActiveStatus } from '../domain/projectStatus';
import { supabase } from '../lib/supabase';
import type {
  ActiveOperatorCatalog,
  OperatorClosingAssignment,
  OperatorProject,
  OperatorProjectMaterial,
} from '../types/operatorConsole';
import { friendlyApiError } from './supabase-api-errors';
import { requireAuthenticatedUserId } from './supabase-operator-session';

const PROJECT_FIELDS = [
  'id',
  'name',
  'location',
  'description',
  'client',
  'project_type',
  'target_depth',
  'default_bar_length',
  'default_bar_diameter',
  'coordinates',
  'well_name',
  'status',
  'start_date',
  'end_date',
  'estimated_completion',
  'progress_percentage',
  'assigned_operator_id',
  'created_at',
  'updated_at',
].join(', ');

const MATERIAL_FIELDS = [
  'id',
  'project_id',
  'material_name',
  'quantity_allocated',
  'initial_quantity',
  'current_quantity',
  'unit',
  'layer',
  'catalog_variant_id',
  'active',
  'notes',
  'created_at',
  'updated_at',
].join(', ');

const requireAssignedProject = async (projectId: number): Promise<OperatorProject> => {
  const operatorId = await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_FIELDS)
    .eq('id', projectId)
    .eq('assigned_operator_id', operatorId)
    .maybeSingle();
  if (error) throw friendlyApiError(error, 'No se pudo cargar el proyecto asignado.');
  if (!data) throw new Error('El proyecto no está asignado a la cuenta conectada.');
  return data as unknown as OperatorProject;
};

export const operatorProjectsApi = {
  async getAssigned(options: { includeClosed?: boolean } = {}): Promise<OperatorProject[]> {
    const operatorId = await requireAuthenticatedUserId();
    const { data, error } = await supabase
      .from('projects')
      .select(PROJECT_FIELDS)
      .eq('assigned_operator_id', operatorId)
      .order('updated_at', { ascending: false });
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los proyectos asignados.');
    const projects = (data || []) as unknown as OperatorProject[];
    return options.includeClosed ? projects : projects.filter((project) => isActiveStatus(project.status));
  },

  async getById(projectId: number): Promise<OperatorProject> {
    return requireAssignedProject(projectId);
  },

  async getMaterials(projectId: number): Promise<OperatorProjectMaterial[]> {
    await requireAssignedProject(projectId);
    const { data, error } = await supabase
      .from('project_materials')
      .select(MATERIAL_FIELDS)
      .eq('project_id', projectId)
      .eq('active', true)
      .order('layer', { ascending: true })
      .order('material_name', { ascending: true });
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los materiales asignados.');
    return (data || []) as unknown as OperatorProjectMaterial[];
  },

  async getClosingAssignments(): Promise<OperatorClosingAssignment[]> {
    const operatorId = await requireAuthenticatedUserId();
    const { data, error } = await supabase
      .from('project_closing_assignments')
      .select('project_id, operator_id, created_at, updated_at')
      .eq('operator_id', operatorId)
      .order('updated_at', { ascending: false });
    if (error) throw friendlyApiError(error, 'No se pudo cargar la responsabilidad de cierre.');
    return (data || []) as OperatorClosingAssignment[];
  },

  async getActiveCatalog(): Promise<ActiveOperatorCatalog> {
    await requireAuthenticatedUserId();
    const { data, error } = await supabase
      .from('catalog_materials')
      .select('id, name, external_code, material_type, unit, measurement_method, active, catalog_variants(id, material_id, display_name, external_code, diameter, length_m, dimension_text, active)')
      .eq('active', true)
      .order('name', { ascending: true });
    if (error) throw friendlyApiError(error, 'No se pudo cargar el catálogo operativo.');
    return ((data || []) as ActiveOperatorCatalog).map((material) => ({
      ...material,
      catalog_variants: (material.catalog_variants || [])
        .filter((variant) => variant.active)
        .sort((left, right) => left.display_name.localeCompare(right.display_name, 'es')),
    }));
  },
};
