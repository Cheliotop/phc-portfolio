import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PedidoV2 } from '../types/productV2';

/**
 * The operator's pedidos as the server last returned them (audit H6).
 *
 * The screen showed synced pedidos only straight from the server, so with no signal
 * they vanished and the list read "Sin pedidos". An approved delivery could then only
 * be confirmed offline if the list happened to be on screen already. Kept per
 * operator, so a shared phone never shows one operator's pedidos to another.
 */
export interface CachedPedidos {
  savedAt: string;
  pedidos: PedidoV2[];
}

const keyFor = (operatorId: string) => `pedidosCache:${operatorId}`;

export const savePedidosCache = async (operatorId: string, pedidos: PedidoV2[]): Promise<void> => {
  const value: CachedPedidos = { savedAt: new Date().toISOString(), pedidos };
  await AsyncStorage.setItem(keyFor(operatorId), JSON.stringify(value));
};

export const loadPedidosCache = async (operatorId: string): Promise<CachedPedidos | null> => {
  try {
    const raw = await AsyncStorage.getItem(keyFor(operatorId));
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && Array.isArray(value.pedidos) && typeof value.savedAt === 'string' ? value : null;
  } catch {
    return null;
  }
};
