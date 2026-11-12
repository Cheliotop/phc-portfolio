// Ported from PHC_Mobile/phc-native/src/domain/projectStatus.ts — same canonical
// vocabulary, same backend, kept in sync manually since this is a separate app.
export type ProjectStatus =
  | 'planning'
  | 'active'
  | 'closure_submitted'
  | 'completed'
  | 'paused'
  | 'cancelled';

export type StatusTone = 'neutral' | 'active' | 'warning' | 'success' | 'danger';

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

export const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = ['planning', 'active', 'closure_submitted'];

export const normalizeStatus = (raw?: string | null): ProjectStatus => {
  const s = (raw || '').toString().trim().toLowerCase();
  switch (s) {
    case 'planning':
    case 'planificado':
      return 'planning';
    case 'active':
    case 'en progreso':
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
      return 'active';
  }
};

export const statusLabel = (raw?: string | null): string => LABELS[normalizeStatus(raw)];
export const statusToneFor = (raw?: string | null): StatusTone => TONES[normalizeStatus(raw)];
export const isActiveStatus = (raw?: string | null): boolean =>
  ACTIVE_PROJECT_STATUSES.includes(normalizeStatus(raw));
