/**
 * Turn any thrown value into a human-readable string.
 *
 * Supabase / PostgREST / Functions errors are plain OBJECTS, not `Error`
 * instances, so the old `error instanceof Error ? error.message : String(error)`
 * fell through to `String(obj)` === "[object Object]" and that useless text got
 * stored in `sync_outbox.last_error` and shown to the operator. This digs the
 * real message (and code) out of those shapes and only ever falls back to
 * JSON — never "[object Object]".
 */
export const errorMessage = (error: unknown): string => {
  if (error == null) return 'Error desconocido';
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;

  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    // Supabase/PostgREST: { message, details, hint, code }. When the request never
    // reached the server, the client puts the JavaScript stack in `details` and
    // prefixes the message with the error's class name, and both reached the
    // operator's screen (audit B4).
    const parts = [
      typeof obj.message === 'string' ? withoutErrorClass(obj.message) : obj.message,
      typeof obj.details === 'string' && isStackTrace(obj.details) ? null : obj.details,
      obj.hint,
    ].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (parts.length > 0) {
      const code = typeof obj.code === 'string' && obj.code.trim().length > 0 ? ` (${obj.code})` : '';
      return `${parts.join(' · ')}${code}`;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // fall through
    }
  }

  const text = String(error);
  return text === '[object Object]' ? 'Error desconocido' : text;
};

const isStackTrace = (text: string): boolean => /\n\s*at\s/.test(text) || /^\s*at\s/.test(text);

/** "OfflineError: Sin conexión…" reads as "Sin conexión…". */
const withoutErrorClass = (text: string): string => {
  const stripped = text.replace(/^[A-Za-z]*Error:\s+/, '');
  return stripped.trim() ? stripped : text;
};

/**
 * A stored sync error, in words an operator can act on.
 *
 * The outbox keeps the raw text for diagnosis. Screens show this instead: no stack
 * trace, no class name, no SQLSTATE in brackets, and every way of having no signal
 * says the same thing.
 */
export const operatorErrorText = (raw: string | null | undefined): string => {
  if (!raw || !raw.trim()) return '';
  let text = raw.split(' · ').filter((part) => !isStackTrace(part)).join(' · ').split(/\n\s*at\s/)[0];
  text = withoutErrorClass(text.trim());
  if (/^sin conexi[oó]n|network request failed|failed to fetch|aborted|timed? ?out|tiempo de espera/i.test(text)) {
    return 'Sin conexión con el servidor.';
  }
  text = text.replace(/\s*\((?:[0-9A-Z]{5}|PGRST\d+)\)\s*$/, '').trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
};

/**
 * Allowlist for the login screen. Login failures must NEVER surface raw
 * server payloads: a 500 from Auth once rendered Cloudflare cookies and
 * request IDs into the user-facing error sheet. Only two messages are
 * safe to repeat (bad credentials, deactivated account); everything else
 * becomes one generic, actionable line.
 */
export const toFriendlyLoginMessage = (error: unknown, role?: 'admin' | 'operator'): string => {
  const raw = errorMessage(error);
  if (/invalid login|invalid.*credential/i.test(raw)) {
    return role === 'operator' ? 'Usuario o contraseña incorrectos' : 'Email o contraseña incorrectos';
  }
  if (/desactivad/i.test(raw)) {
    return raw;
  }
  return 'No se pudo iniciar sesión. Revisá tu conexión e intentá de nuevo.';
};
