import { createClient } from '@supabase/supabase-js';
import { isSecretKey } from '../domain/supabaseKey.ts';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

const EXPECTED_PROJECT_HOST = 'portfolio-project.supabase.co';
let parsedUrl: URL;
try {
  parsedUrl = new URL(SUPABASE_URL);
} catch {
  throw new Error('VITE_SUPABASE_URL no está configurada correctamente.');
}
if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== EXPECTED_PROJECT_HOST) {
  throw new Error('El panel web no está configurado para el proyecto Supabase de producción.');
}
if (!SUPABASE_PUBLISHABLE_KEY || isSecretKey(SUPABASE_PUBLISHABLE_KEY)) {
  throw new Error('El panel web requiere una clave pública de Supabase; nunca una clave secreta.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
