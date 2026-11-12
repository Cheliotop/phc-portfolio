/**
 * Operator account rules. The admin-create-operator and
 * admin-reset-operator-password Edge Functions enforce the same limits; these
 * copies only let the form explain the problem before the round trip.
 */
export const MIN_PASSWORD_LENGTH = 8;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** The username is the login (`<username>@phc.local`), so it is lowercase. */
export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

/** Spanish error for the form, or null when the username is acceptable. */
export const usernameError = (value: string): string | null => {
  const username = normalizeUsername(value);
  if (!username) return 'Ingresá el usuario del operador';
  if (!USERNAME_PATTERN.test(username)) {
    return 'El usuario debe tener 3 a 32 caracteres: letras, números, punto, guion o guion bajo, sin espacios';
  }
  return null;
};

export const passwordError = (value: string): string | null =>
  value.length < MIN_PASSWORD_LENGTH
    ? `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`
    : null;
