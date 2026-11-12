import { supabase } from '../lib/supabase';

export const materialsApi = {
  // Cross-project recent consumption for the dashboard activity feed — the
  // burn rate is the admin's main control signal (assigned vs. consumed),
  // so usage events belong in "Actividad Reciente" alongside progress,
  // pedidos and cierres.
  async getRecentConsumption(limit = 12) {
    const { data, error } = await supabase
      .from('material_consumption')
      .select('*, projects(name)')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { data: data || [] };
  },
};
