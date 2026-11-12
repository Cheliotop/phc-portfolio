import supabase from '../lib/supabase';
import type { TablesUpdate } from '../types/supabase.generated';

interface ProjectListOptions {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  orderDir?: string;
}

export const projectsApi = {
  async getAll(options?: ProjectListOptions) {
    let query = supabase.from('projects').select('*');
    if (options?.orderBy) {
      query = query.order(options.orderBy, { ascending: (options.orderDir || 'desc') === 'asc' });
      if (options.orderBy !== 'id') query = query.order('id', { ascending: false });
    } else if (options?.page && options?.pageSize) {
      query = query.order('id', { ascending: false });
    }
    if (options?.page && options?.pageSize) {
      const from = (options.page - 1) * options.pageSize;
      const to = from + options.pageSize - 1;
      query = query.range(from, to);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getAllPages(options: Omit<ProjectListOptions, 'page'> & { pageSize: number }) {
    const rows: any[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await projectsApi.getAll({ ...options, page });
      rows.push(...batch);
      if (batch.length < options.pageSize) return rows;
    }
  },

  async getById(id: number) {
    const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
    if (error) throw error;
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
    if (error) throw error;
    return { project_id: result.id };
  },

  async update(id: number, data: TablesUpdate<'projects'>) {
    const { data: result, error } = await supabase.from('projects').update(data).eq('id', id).select().single();
    if (error) throw error;
    return result;
  },

  async delete(id: number) {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) throw error;
  },
};
