import AsyncStorage from '@react-native-async-storage/async-storage';
import { drillingBarsApi } from '../api/supabase-drilling-bars';
import { mirrorServerDrillingBar } from '../db/repositories/drillingBars';

/**
 * Pull the server's drilling bars for a project into the local
 * `drilling_bar_entries` mirror. This is what makes the server-computed depth
 * (MAX(depth_end)) available offline and immediately.
 *
 * Extracted from ProgresoTab so PozosTab ("Mi Pozo") can show the correct
 * "Profundidad Actual" on a fresh login WITHOUT the operator first having to
 * open the Progreso tab. INSERT OR IGNORE keeps any locally-queued
 * (not-yet-synced) bars intact — it only fills in rows the device doesn't have.
 */
export const cacheServerBars = async (projectId: string | number): Promise<void> => {
  const token = await AsyncStorage.getItem('authToken');
  if (!token) {
    return;
  }

  try {
    const response = await drillingBarsApi.getAll(Number(projectId));
    const bars = response.data || [];
    for (const bar of bars) {
      await mirrorServerDrillingBar(bar);
    }
  } catch (error) {
    console.warn('[PHC] Could not refresh drilling bars from server:', error);
  }
};
