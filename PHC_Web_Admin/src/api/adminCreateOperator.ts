import { friendlyApiError } from './supabase-api-errors';
// Ported from PHC_Mobile's supabase-auth.ts adminCreateOperator — calls the
// admin-create-operator Edge Function (service-role context server-side).
// Never touches the calling admin's own session (unlike supabase.auth.signUp).
import { supabase } from '../lib/supabase';

export const adminCreateOperator = async (data: {
  username: string;
  password: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}) => {
  const { data: result, error } = await supabase.functions.invoke('admin-create-operator', {
    body: data,
  });
  if (error) {
    let message = error.message || 'No se pudo crear el operador';
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const payload = await ctx.json();
        if (payload?.error) message = payload.error;
      }
    } catch {
      // keep generic message
    }
    throw friendlyApiError({ message }, 'No se pudo crear el operador');
  }
  if (result?.error) throw friendlyApiError({ message: result.error }, 'No se pudo crear el operador');
  if (!result?.user) throw new Error('No se pudo crear el operador');
  return result.user;
};
