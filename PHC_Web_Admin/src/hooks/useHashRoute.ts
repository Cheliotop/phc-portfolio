import { useCallback, useEffect, useState } from 'react';
import { hashForTab, parseHashRoute, type TabKey } from '../routing/hashRoute';

export const useHashRoute = () => {
  const [route, setRoute] = useState(parseHashRoute);

  useEffect(() => {
    if (!window.location.hash || window.location.hash === '#') {
      window.history.replaceState(window.history.state, '', hashForTab('resumen'));
    }

    const syncFromLocation = () => setRoute(parseHashRoute());
    window.addEventListener('hashchange', syncFromLocation);
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  const navigate = useCallback((tab: TabKey, projectId?: number) => {
    const nextHash = hashForTab(tab, projectId);
    if (window.location.hash === nextHash) {
      setRoute(parseHashRoute(nextHash));
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return { route, navigate };
};
