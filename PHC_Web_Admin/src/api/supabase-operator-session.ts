import { supabase } from '../lib/supabase';
import { friendlyApiError } from './supabase-api-errors';

/**
 * Resolve the authenticated principal from Supabase Auth rather than trusting
 * a caller-provided operator id. This matters when an administrator is also
 * signed into the same web client: operator queries must never silently turn
 * into unrestricted admin queries.
 */
export const requireAuthenticatedUserId = async (): Promise<string> => {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw friendlyApiError(error, 'No se pudo validar la sesión.');
  if (!data.user?.id) throw new Error('Iniciá sesión para usar la vista de operador.');
  return data.user.id;
};

export const createOperatorClientEntryId = (): string => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Este navegador no puede crear identificadores seguros. Actualizalo e intentá de nuevo.');
  }
  return globalThis.crypto.randomUUID();
};
