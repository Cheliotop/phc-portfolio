// Key guard helpers for the web admin (WEB-19). No imports: the node tests load this file directly.

// Role inside a JWT-shaped key (legacy anon/service_role keys). Null for anything else.
export const jwtPayloadRole = (key: string): string | null => {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
};

// A secret key, in the new format or as a legacy service_role JWT, must never ship in the public bundle.
export const isSecretKey = (key: string): boolean =>
  key.startsWith('sb_secret_') || jwtPayloadRole(key) === 'service_role';
