import { createContext } from 'react';
import type { Session } from '@supabase/supabase-js';

export type AppRole = 'admin' | 'operator';

export interface AppUser {
  id: string;
  email?: string;
  username?: string;
  full_name?: string;
  role: AppRole;
  is_active: true;
}

// Back-compat alias: existing admin components import AdminUser.
export type AdminUser = AppUser;

export interface AuthContextValue {
  session: Session | null;
  user: AppUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  isAdmin: boolean;
  isOperator: boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
