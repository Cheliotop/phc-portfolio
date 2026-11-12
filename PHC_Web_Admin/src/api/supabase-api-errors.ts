interface SupabaseLikeError {
  code?: string;
  message?: string;
  details?: string;
}

export const friendlyApiError = (error: unknown, fallback: string): Error => {
  const candidate = error as SupabaseLikeError | null;
  if (candidate?.code === '23505') {
    const detail = `${candidate.message || ''} ${candidate.details || ''}`.toLowerCase();
    if (detail.includes('project_secondary_operators')) {
      return new Error('Ese operador ya forma parte del equipo de este pozo.');
    }
    if (detail.includes('idempotency') || detail.includes('client_entry_id')) {
      return new Error('Ese intento ya fue recibido con datos diferentes. Recargá el registro antes de reintentar.');
    }
    if (detail.includes('external_code')) {
      return new Error('Ese código externo ya está usado por otro material o variante.');
    }
    return new Error('Ya existe un registro con ese nombre. Usá un nombre distinto o editá el existente.');
  }
  if (candidate?.code === '22023' && /responsable del pozo|operador 1 del pozo|operador principal|secondary/i.test(candidate.message || '')) {
    return new Error('El operador principal no puede ser también operador 2 del equipo.');
  }
  if (candidate?.code === '42501') {
    return new Error('Tu sesión no tiene permisos para realizar esta acción.');
  }
  // Server and auth messages that reach the admin in English (code read W9).
  const message = candidate?.message || '';
  if (/completed project core data is immutable|completed projects? .*immutable/i.test(message)) {
    return new Error('Un proyecto completado no se puede editar.');
  }
  if (/already been registered|already registered|user already exists/i.test(message)) {
    return new Error('Ya existe una cuenta con ese usuario. Elegí otro.');
  }
  if (/Failed to fetch|NetworkError|network request failed/i.test(message)) {
    return new Error('Sin conexión con el servidor. Revisá la conexión e intentá de nuevo.');
  }
  // Auth (GoTrue) messages from password changes and sign-in (WEB-16).
  const code = candidate?.code || '';
  if (code === 'same_password' || /same as (the )?old password|different from the old password/i.test(message)) {
    return new Error('La nueva contraseña debe ser distinta de la anterior.');
  }
  if (code === 'weak_password' || /weak and easy to guess|Password should contain/i.test(message)) {
    return new Error('La contraseña es muy débil o no cumple los requisitos. Elegí una más segura.');
  }
  if (/Password should be at least/i.test(message)) {
    return new Error('La contraseña es demasiado corta. Elegí una más larga.');
  }
  if (/over_request_rate_limit|over_email_send_rate_limit|rate limit|too many requests|you can only request this after/i.test(`${code} ${message}`)) {
    return new Error('Hiciste demasiados intentos seguidos. Esperá un momento e intentá de nuevo.');
  }
  return new Error(message || fallback);
};
