import { supabase } from '../lib/supabase';
import { friendlyApiError } from './supabase-api-errors';

export const projectsApi = {
  async getAll(options?: { page?: number; pageSize?: number; orderBy?: string; orderDir?: string }) {
    let query = supabase.from('projects').select('*');
    if (options?.orderBy) {
      query = query.order(options.orderBy, { ascending: (options.orderDir || 'desc') === 'asc' });
    }
    if (options?.page && options?.pageSize) {
      const from = (options.page - 1) * options.pageSize;
      const to = from + options.pageSize - 1;
      query = query.range(from, to);
    }
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los proyectos.');
    return data || [];
  },

  async getById(id: number) {
    const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
    if (error) throw friendlyApiError(error, 'No se pudo cargar el proyecto.');
    return data;
  },

  async create(data: {
    name: string;
    location?: string;
    well_name?: string;
    client?: string;
    coordinates?: string;
    assigned_operator_id?: string;
    target_depth?: number;
    default_bar_length?: number;
    default_bar_diameter?: string;
    project_type?: string;
    status?: string;
  }) {
    const { data: result, error } = await supabase.from('projects').insert(data).select().single();
    if (error) throw friendlyApiError(error, 'No se pudo crear el proyecto.');
    return { project_id: result.id };
  },

  async update(id: number, data: Record<string, any>) {
    const { data: result, error } = await supabase.from('projects').update(data).eq('id', id).select().single();
    if (error) throw friendlyApiError(error, 'No se pudo actualizar el proyecto.');
    return result;
  },

  async delete(id: number) {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) throw friendlyApiError(error, 'No se pudo eliminar el proyecto.');
  },
};
