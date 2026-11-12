// Calls the admin-reset-operator-password Edge Function (service-role
// context server-side). The function only accepts targets whose profile
// role is 'operator' — it can never touch an admin account.
// Mirrors PHC_Web_Admin/src/api/adminResetOperatorPassword.ts.
import supabase from '../lib/supabase';

export const adminResetOperatorPassword = async (operatorId: string, newPassword: string) => {
  const { data: result, error } = await supabase.functions.invoke('admin-reset-operator-password', {
    body: { operator_id: operatorId, new_password: newPassword },
  });
  if (error) {
    let message = error.message || 'No se pudo restablecer la contraseña';
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const payload = await ctx.json();
        if (payload?.error) message = payload.error;
      }
    } catch {
      // keep generic message
    }
    throw new Error(message);
  }
  if (result?.error) throw new Error(result.error);
  return result;
};
