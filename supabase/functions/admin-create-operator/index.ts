// admin-create-operator — PHC Pass 1.5
// DEPLOYED to project portfolio-project (verify_jwt: ON).
//
// Creates an operator account using the service-role Admin API so the
// calling admin's session is NEVER touched. Replaces the old client-side
// `supabase.auth.signUp(...)` flow, which swapped the admin's session for
// the new operator's session (audit finding #2).
//
// 2026-07-10: added CORS handling. Without it the function worked from the
// mobile app (React Native does not enforce CORS) but every call from the
// web admin panel died in the browser's preflight — "Crear Operador" on
// the web was silently broken. CORS is not an auth boundary here: auth is
// the caller's JWT + is_admin() check below.
//
// Security model:
//  - verify_jwt is ON: Supabase rejects requests without a valid JWT.
//  - We additionally call the `is_admin()` RPC AS THE CALLER, so only
//    admins can create accounts.
//  - Role is always 'operator' here, and the DB trigger `handle_new_user`
//    independently clamps signup roles to 'operator' anyway.
import { createClient } from 'npm:@supabase/supabase-js@2.110.1';
import { publishableKey, serviceKey as serviceKeyFromEnv } from '../_shared/keys.ts';

type Body = {
  email?: string;
  password?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  // Key choice lives in ../_shared/keys.ts (audit SEC-2): production disabled the
  // legacy anon/service_role keys on 2026-07-28 but still injects them, so the new
  // secret and publishable keys are always tried first.
  const anonKey = publishableKey();
  const serviceKey = serviceKeyFromEnv();
  if (!anonKey || !serviceKey) {
    return json(500, {
      error: 'Configuracion incompleta: faltan las claves de Supabase de la funcion',
    });
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
    return json(403, { error: 'Solo un administrador puede crear operadores' });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Cuerpo JSON invalido' });
  }

  // The username is the operator's login (`<username>@phc.local`), so keep it
  // to characters that survive an email local part and a phone keyboard.
  const username = body.username?.trim().toLowerCase() ?? '';
  const password = body.password ?? '';
  const email = body.email?.trim().toLowerCase() || (username ? `${username}@phc.local` : '');

  if (!username) return json(400, { error: 'username es obligatorio' });
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return json(400, {
      error: 'El usuario debe tener 3 a 32 caracteres: letras, numeros, punto, guion o guion bajo, sin espacios',
    });
  }
  if (password.length < 8) {
    return json(400, { error: 'La contrasena debe tener al menos 8 caracteres' });
  }
  if (!email) return json(400, { error: 'email es obligatorio' });

  // Service-role client — server-side only; never exposed to the app.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      role: 'operator',
      first_name: body.first_name ?? '',
      last_name: body.last_name ?? '',
      full_name: [body.first_name, body.last_name].filter(Boolean).join(' ') || username,
    },
  });

  if (createError || !created?.user) {
    const msg = createError?.message ?? 'No se pudo crear el usuario';
    const status = /already|registered|exists/i.test(msg) ? 409 : 500;
    return json(status, { error: msg });
  }

  // handle_new_user trigger has created the profiles row (role clamped to
  // 'operator'). Read it back so the app gets the canonical record.
  const { data: profile } = await admin
    .from('profiles')
    .select('id, username, email, role, first_name, last_name, full_name, is_active')
    .eq('id', created.user.id)
    .single();

  return json(200, { user: profile ?? { id: created.user.id, email, username, role: 'operator' } });
});
