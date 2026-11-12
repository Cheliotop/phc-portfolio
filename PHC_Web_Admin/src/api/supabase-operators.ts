import { supabase } from '../lib/supabase';
import { friendlyApiError } from './supabase-api-errors';

export const operatorsApi = {
  async getAll() {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('username');
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los operadores.');
    const rows = data || [];
    if (!rows.length) return rows;
    const { data: statuses, error: statusError } = await supabase.rpc('operator_auth_status', {
      p_operator_ids: rows.map((row: any) => row.id),
    });
    if (statusError) throw statusError;
    const available = new Map((statuses || []).map((row: any) => [row.id, row.auth_available]));
    return rows.map((row: any) => ({ ...row, auth_available: available.get(row.id) === true }));
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw friendlyApiError(error, 'No se pudo cargar el operador.');
    return data;
  },

  // Pass 1.5: real server-side activate/deactivate. Allowed only for admins
  // ("Admins can update any profile" RLS policy); the DB trigger
  // protect_profiles_privileged blocks everyone else (and blocks admins from
  // changing their OWN activation). Deactivated users are rejected at login.
  async setActive(id: string, isActive: boolean) {
    const { data, error } = await supabase
      .from('profiles')
      .update({ is_active: isActive })
      .eq('id', id)
      .select('id, username, full_name, role, is_active')
      .single();
    if (error) throw friendlyApiError(error, 'No se pudo actualizar el operador.');
    return data;
  },
};
