// admin-reset-operator-password — PHC handoff-hardening pass (2026-07-10).
//
// Lets the admin set a new password for an OPERATOR account from the web
// panel, using the service-role Admin API server-side. Without this, a
// forgotten operator password was a dead end: no UI anywhere could fix it,
// only the Supabase dashboard.
//
// CORS handling is required because the web admin calls this from a real
// browser (the mobile app never enforced CORS). CORS is not an auth
// boundary here: auth is the caller's JWT + is_admin() check below.
//
// Security model (mirrors admin-create-operator):
//  - verify_jwt is ON: Supabase rejects requests without a valid JWT.
//  - We additionally call the `is_admin()` RPC AS THE CALLER, so only
//    admins can reset passwords.
//  - The target account's profile must have role='operator' — this function
//    refuses to touch admin accounts, so it can never be used to take over
//    or accidentally lock out the admin.
import { createClient } from 'npm:@supabase/supabase-js@2.110.1';
import { publishableKey, serviceKey } from '../_shared/keys.ts';

type Body = {
  operator_id?: string;
  new_password?: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

const serviceRoleKey = serviceKey;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = publishableKey();
  const serviceKey = serviceRoleKey();
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(500, { error: 'Configuracion incompleta de Supabase' });
  }
  const authHeader = req.headers.get('Authorization') ?? '';

  // Client bound to the CALLER's JWT — used only to verify identity/role.
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData?.user) {
    return json(401, { error: 'No autenticado' });
  }

  const { data: isAdmin, error: adminError } = await caller.rpc('is_admin');
  if (adminError || isAdmin !== true) {
    return json(403, { error: 'Solo un administrador puede restablecer contraseñas' });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Cuerpo JSON invalido' });
  }

  const operatorId = body.operator_id?.trim();
  const newPassword = body.new_password ?? '';

  if (!operatorId) return json(400, { error: 'operator_id es obligatorio' });
  if (newPassword.length < 8) {
    return json(400, { error: 'La contrasena debe tener al menos 8 caracteres' });
  }

  // Service-role client — server-side only; never exposed to the app.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Refuse anything that is not an operator account.
  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('id, username, role')
    .eq('id', operatorId)
    .single();

  if (targetError || !target) {
    return json(404, { error: 'Operador no encontrado' });
  }
  if (target.role !== 'operator') {
    return json(403, { error: 'Solo se pueden restablecer contraseñas de operadores' });
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(operatorId, {
    password: newPassword,
  });

  if (updateError) {
    return json(500, { error: updateError.message || 'No se pudo actualizar la contrasena' });
  }

  // A reset usually means the old password leaked or a phone was lost: end
  // every existing session so the old credentials stop working on any device.
  const { error: revokeError } = await admin.rpc('revoke_user_sessions', { p_user_id: operatorId });
  if (revokeError) {
    return json(500, { error: 'Contrasena actualizada, pero no se pudieron cerrar las sesiones abiertas' });
  }

  return json(200, { ok: true, username: target.username });
});
