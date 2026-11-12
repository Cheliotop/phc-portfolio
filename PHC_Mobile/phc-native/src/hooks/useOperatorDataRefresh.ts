import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { subscribeToOperatorDataChanges } from '../events/operatorDataEvents';

type Refresh = () => void | Promise<unknown>;

/**
 * Loads an operator tab when it first becomes visible, refreshes it when it is
 * revisited, and refreshes the visible tab after a background outbox drain.
 * Concurrent refresh requests are coalesced so an older response cannot win a
 * race against the post-sync refresh.
 */
export const useOperatorDataRefresh = (refresh: Refresh) => {
  const isFocused = useIsFocused();
  const [revision, setRevision] = useState(0);
  const refreshRef = useRef(refresh);
  const isFocusedRef = useRef(isFocused);
  const runningRef = useRef(false);
  const rerunRef = useRef(false);

  refreshRef.current = refresh;
  isFocusedRef.current = isFocused;

  useEffect(
    () => subscribeToOperatorDataChanges(() => setRevision((current) => current + 1)),
    [],
  );

  const runRefresh = useCallback(async () => {
    if (!isFocusedRef.current) {
      return;
    }
    if (runningRef.current) {
      rerunRef.current = true;
      return;
    }

    runningRef.current = true;
    try {
      do {
        rerunRef.current = false;
        try {
          await refreshRef.current();
        } catch (error) {
          console.warn('[PHC] Operator tab refresh failed:', error);
        }
      } while (rerunRef.current && isFocusedRef.current);
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isFocused) {
      return;
    }
    runRefresh().catch((error) => {
      console.warn('[PHC] Operator tab refresh scheduling failed:', error);
    });
  }, [isFocused, revision, runRefresh]);
};
