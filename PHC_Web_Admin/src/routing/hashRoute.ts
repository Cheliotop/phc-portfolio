export const TAB_KEYS = ['resumen', 'proyectos', 'catalogo', 'operacion', 'operadores', 'pedidos', 'cierres', 'revision'] as const;

export type TabKey = typeof TAB_KEYS[number];

export interface HashRoute {
  tab: TabKey | null;
  projectId?: number;
  unknownPath?: string;
}

const isTabKey = (value: string): value is TabKey =>
  TAB_KEYS.some((key) => key === value);

const positiveInteger = (value: string | null | undefined): number | undefined => {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseHashRoute = (hash = window.location.hash): HashRoute => {
  const raw = hash.replace(/^#/, '').replace(/^\//, '');
  if (!raw) return { tab: 'resumen' };

  const [pathPart, queryPart = ''] = raw.split('?', 2);
  const segments = pathPart.split('/').filter(Boolean).map(safeDecode);
  const candidate = segments[0] || 'resumen';

  if (!isTabKey(candidate)) return { tab: null, unknownPath: pathPart };
  if (candidate !== 'proyectos' && segments.length > 1) {
    return { tab: null, unknownPath: pathPart };
  }
  if (candidate === 'proyectos' && segments.length > 2) {
    return { tab: null, unknownPath: pathPart };
  }

  const pathProjectId = positiveInteger(segments[1]);
  if (candidate === 'proyectos' && segments[1] && pathProjectId === undefined) {
    return { tab: null, unknownPath: pathPart };
  }

  const query = new URLSearchParams(queryPart);
  const projectId = candidate === 'proyectos'
    ? pathProjectId
      ?? positiveInteger(query.get('projectId'))
      ?? positiveInteger(query.get('project'))
      ?? positiveInteger(query.get('id'))
    : undefined;

  return { tab: candidate, projectId };
};

export const hashForTab = (tab: TabKey, projectId?: number) =>
  projectId && tab === 'proyectos' ? `#/${tab}/${projectId}` : `#/${tab}`;
