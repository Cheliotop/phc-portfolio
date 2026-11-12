import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';

/**
 * Did the server actually say this user may not continue?
 *
 * Signing out needs the server to sign back in, so doing it during an outage
 * leaves an operator unable to record anything on site. Only a definite answer
 * counts: the auth server refused the session, or the profile row is gone.
 * Anything else (no route, timeout, 5xx, rate limit, a captive portal's HTML)
 * says nothing about the account, so the caller must treat it as "can't reach
 * the server right now".
 */
export const isDefiniteAuthRejection = (error: unknown): boolean => {
  if (isAuthSessionMissingError(error)) return true;
  if (isAuthApiError(error)) {
    const { status } = error;
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
  // `.single()` found no profile row for this user.
  return (error as { code?: unknown } | null)?.code === 'PGRST116';
};
