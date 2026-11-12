import { StatusTone } from '../theme/phcTheme';

/**
 * Pass 4: one canonical project lifecycle vocabulary + Spanish display labels.
 * Prevents scattered string comparisons. The server stores canonical English
 * values (planning/active/completed/paused/cancelled/closure_submitted); older
 * SQLite caches stored Spanish labels ("En Progreso", "Completado", "Pausado").
 * `normalizeStatus` maps any of those to the canonical key so display and
 * filtering are consistent.
 */
export type ProjectStatus =
  | 'planning'
  | 'active'
  | 'closure_submitted'
  | 'completed'
  | 'paused'
  | 'cancelled';

const LABELS: Record<ProjectStatus, string> = {
  planning: 'Planificado',
  active: 'En progreso',
  closure_submitted: 'Cierre enviado',
  completed: 'Completado',
  paused: 'Pausado',
  cancelled: 'Cancelado',
};

const TONES: Record<ProjectStatus, StatusTone> = {
  planning: 'neutral',
  active: 'active',
  closure_submitted: 'warning',
  completed: 'success',
  paused: 'warning',
  cancelled: 'danger',
};

// Canonical set that counts as "active/ongoing" for dashboard stats.
export const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = ['planning', 'active', 'closure_submitted'];

export const normalizeStatus = (raw?: string | null): ProjectStatus => {
  const s = (raw || '').toString().trim().toLowerCase();
  switch (s) {
    case 'planning':
    case 'planificado':
      return 'planning';
    case 'active':
    case 'en progreso':
    case 'en progreso ':
      return 'active';
    case 'closure_submitted':
    case 'cierre enviado':
      return 'closure_submitted';
    case 'completed':
    case 'completado':
      return 'completed';
    case 'paused':
    case 'pausado':
      return 'paused';
    case 'cancelled':
    case 'canceled':
    case 'cancelado':
      return 'cancelled';
    default:
      // Unknown/empty -> treat as active (the common in-progress default).
      return 'active';
  }
};

export const statusLabel = (raw?: string | null): string => LABELS[normalizeStatus(raw)];
export const statusToneFor = (raw?: string | null): StatusTone => TONES[normalizeStatus(raw)];
export const isActiveStatus = (raw?: string | null): boolean =>
  ACTIVE_PROJECT_STATUSES.includes(normalizeStatus(raw));
