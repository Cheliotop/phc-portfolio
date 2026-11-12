import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { pedidosApi, type PedidoDraftItem } from '../../api/supabase-pedidos';
import { productV2Api } from '../../api/supabase-product-v2';
import { loadPedidosCache, savePedidosCache } from '../../api/pedidosCache';
import { loadAssignedProjects, refreshAssignedProjects, type AssignedProject } from '../../api/projectCache';
import { query, queryFirst, runInTransaction } from '../../db/db';
import {
  applyProvisionalPedidoReceipt,
  createLocalPedidoItem,
  createLocalPedidoReceipt,
  ensureServerPedidoItem,
} from '../../db/repositories/pedidos';
import { insertSupplyRequest } from '../../db/repositories/supplyRequests';
import { drainOutboxIncludingNew } from '../../sync/drainCoordinator';
import { readRecordSendState } from '../../sync/queueStatus';
import type { CatalogMaterial, PedidoItem, PedidoKind, PedidoV2 } from '../../types/productV2';
import { createClientEntryId } from '../../utils/clientId';
import { formatQuantity, parseQuantity, quantityPreview, roundQuantity } from '../../utils/quantity';
import { formatDisplayDate, formatDisplayDateTime, storedDateFromToday } from '../../utils/dateFormat';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { pedidoReceiptSavedMessage, syncedPedidoCreatedMessage } from '../../domain/pedidoMessaging';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { showSheet } from '../shared/Sheet';

interface DraftItem {
  id: string;
  catalogVariantId?: number;
  materialName: string;
  quantity: string;
  unit: string;
}

interface DisplayItem {
  id: string;
  serverId?: number;
  localId?: string;
  name: string;
  requested: number;
  approved?: number | null;
  received: number;
  unit: string;
  state: string;
  pendingReceipt?: boolean;
  layer: 'presupuesto' | 'extras';
}

interface DisplayPedido {
  id: string;
  projectId: number;
  local: boolean;
  number?: string | null;
  projectName: string;
  kind: PedidoKind;
  priority: string;
  status: string;
  justification?: string | null;
  createdAt: string;
  syncStatus?: string;
  items: DisplayItem[];
}

interface ReceiptTarget extends DisplayItem {
  pedidoKind: PedidoKind;
  projectId: number;
}

const newDraftItem = (): DraftItem => ({
  id: createClientEntryId('draft_item'),
  materialName: '',
  quantity: '',
  unit: 'unidad',
});

/** The typed quantity as a number, or NaN when it cannot be read. */
const readQuantity = (raw: string): number => {
  const parsed = parseQuantity(raw);
  return parsed.ok === true ? parsed.value : Number.NaN;
};

/**
 * A second tap in the same frame, before React re-renders the disabled button,
 * must not start a second save with a new client id (audit OPB-9).
 */
const runOnce = async (inFlight: { current: boolean }, task: () => Promise<void>) => {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    await task();
  } finally {
    inFlight.current = false;
  }
};

/**
 * When a pedido is actually needed. `null` means no deadline.
 *
 * A drilling crew asks for material in days, not on a calendar — so these are
 * the real answers, offered as buttons. No date picker, which would mean a new
 * native module days before handoff for a field that is optional.
 */
const NEEDED_BY_CHOICES: { label: string; days: number | null }[] = [
  { label: 'Sin fecha', days: null },
  { label: 'Hoy', days: 0 },
  { label: 'Mañana', days: 1 },
  { label: 'En 3 días', days: 3 },
  { label: 'En 1 semana', days: 7 },
];

const statusColor = (status: string) => {
  const normalized = status.toLowerCase();
  if (normalized.includes('rechaz') || normalized === 'no_recibido') return COLORS.error;
  if (normalized.includes('recib') || normalized.includes('complet')) return COLORS.success;
  if (normalized.includes('aprob') || normalized.includes('parcial')) return COLORS.accent;
  return COLORS.warning;
};

const toDisplayPedido = (pedido: PedidoV2): DisplayPedido => ({
  id: `server_${pedido.id}`,
  projectId: pedido.project_id,
  local: false,
  number: pedido.pedido_number,
  projectName: pedido.projects?.name || `Pozo #${pedido.project_id}`,
  kind: pedido.kind,
  priority: pedido.priority || 'Normal',
  status: pedido.status,
  justification: pedido.justification,
  createdAt: pedido.created_at,
  syncStatus: 'synced',
  items: (pedido.pedido_items || []).map((item: PedidoItem) => ({
    id: `server_item_${item.id}`,
    serverId: item.id,
    name: item.material_name_snapshot,
    requested: Number(item.requested_quantity),
    approved: item.approved_quantity,
    received: Number(item.received_quantity || 0),
    unit: item.unit_snapshot,
    state: item.state,
    layer: item.layer,
  })),
});

const PedidosV2Tab = () => {
  const [operatorId, setOperatorId] = useState('');
  const [projects, setProjects] = useState<AssignedProject[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [catalog, setCatalog] = useState<CatalogMaterial[]>([]);
  const [pedidos, setPedidos] = useState<DisplayPedido[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [kind, setKind] = useState<PedidoKind>('empresa');
  const [priority, setPriority] = useState('Normal');
  const [neededBy, setNeededBy] = useState('');
  const [justification, setJustification] = useState('');
  const [notes, setNotes] = useState('');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([newDraftItem()]);
  const [receiptTarget, setReceiptTarget] = useState<ReceiptTarget | null>(null);
  const [receiptOutcome, setReceiptOutcome] = useState<'recibido' | 'parcial' | 'no_recibido'>('recibido');
  const [receiptQuantity, setReceiptQuantity] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const pedidoInFlight = useRef(false);
  const receiptInFlight = useRef(false);

  const catalogOptions = useMemo(() => catalog.flatMap((material) => {
    const variants = (material.catalog_variants || []).filter((variant) => variant.active);
    if (!variants.length) return [];
    return variants.map((variant) => ({
      id: variant.id,
      name: variant.display_name.toLowerCase() === 'estándar' || variant.display_name.toLowerCase() === 'estandar'
        ? material.name
        : `${material.name} · ${variant.display_name}`,
      unit: material.unit,
    }));
  }), [catalog]);

  /**
   * Pedidos the server doesn't have yet. Offline, `cachedServerIds` lists the ones
   * the saved server list holds, and a pedido that synced after that list was saved
   * is shown from the phone's copy instead of disappearing.
   */
  const loadLocalPedidos = useCallback(async (
    userId: string,
    cachedServerIds: number[] | null = null,
  ): Promise<DisplayPedido[]> => {
    const notCached = cachedServerIds === null
      ? ''
      : ` OR (sr.server_id IS NOT NULL${cachedServerIds.length
        ? ` AND sr.server_id NOT IN (${cachedServerIds.map(() => '?').join(', ')})`
        : ''})`;
    const rows = await query<any>(
      `SELECT sr.*, p.name AS project_name
       FROM supply_requests sr
       LEFT JOIN projects p ON p.id = sr.project_id
       WHERE sr.operator_id = ? AND (sr.server_id IS NULL OR sr.sync_status <> 'synced'${notCached})
       ORDER BY sr.created_at DESC`,
      [userId, ...(cachedServerIds ?? [])],
    );
    const result: DisplayPedido[] = [];
    for (const row of rows) {
      const items = await query<any>(
        `SELECT * FROM pedido_items WHERE pedido_id = ? ORDER BY created_at, id`,
        [row.id],
      );
      result.push({
        id: `local_${row.id}`,
        projectId: Number(row.project_id),
        local: true,
        number: row.pedido_number,
        projectName: row.project_name || `Pozo #${row.project_id}`,
        kind: row.kind === 'personal' ? 'personal' : 'empresa',
        priority: row.priority || 'Normal',
        status: row.status || 'Pendiente',
        justification: row.justification,
        createdAt: row.created_at,
        syncStatus: row.sync_status,
        items: items.map((item) => ({
          id: item.id,
          localId: item.id,
          serverId: item.server_id ?? undefined,
          name: item.material_name_snapshot,
          requested: Number(item.requested_quantity),
          approved: item.approved_quantity,
          received: Number(item.received_quantity || 0),
          unit: item.unit_snapshot,
          state: item.state,
          layer: item.layer || 'extras',
        })),
      });
    }
    return result;
  }, []);

  const withLocalReceipts = useCallback(async (list: DisplayPedido[], savedAt: string | null): Promise<DisplayPedido[]> => {
    const serverIds = list.flatMap((pedido) => pedido.items.map((item) => item.serverId)).filter(Boolean);
    if (serverIds.length === 0) return list;
    const rows = await query<{
      id: string;
      server_id: number;
      state: string;
      received_quantity: number;
      updated_at: string;
      pending_receipt: number;
    }>(
      `SELECT pi.id, pi.server_id, pi.state, pi.received_quantity, pi.updated_at,
              EXISTS (
                SELECT 1 FROM pedido_receipts pr
                JOIN sync_outbox so ON so.entity = 'pedido_receipt' AND so.entity_id = pr.id
                WHERE pr.pedido_item_id = pi.id AND pr.sync_status <> 'synced'
                  AND COALESCE(so.state, 'pending') = 'pending'
              ) AS pending_receipt
       FROM pedido_items pi
       WHERE pi.server_id IN (${serverIds.map(() => '?').join(', ')})
         AND (${savedAt === null ? '' : 'pi.updated_at > ? OR ' }EXISTS (
           SELECT 1 FROM pedido_receipts pr
           JOIN sync_outbox so ON so.entity = 'pedido_receipt' AND so.entity_id = pr.id
           WHERE pr.pedido_item_id = pi.id AND pr.sync_status <> 'synced'
             AND COALESCE(so.state, 'pending') = 'pending'
         ))`,
      savedAt === null ? serverIds : [...serverIds, savedAt],
    );
    const newer = new Map(rows.map((row) => [Number(row.server_id), row]));
    return list.map((pedido) => ({
      ...pedido,
      items: pedido.items.map((item) => {
        const local = item.serverId ? newer.get(Number(item.serverId)) : undefined;
        return local
          ? {
            ...item,
            localId: local.id,
            state: local.state,
            received: Number(local.received_quantity || 0),
            pendingReceipt: Boolean(local.pending_receipt),
          }
          : item;
      }),
    }));
  }, []);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const userId = await AsyncStorage.getItem('operatorId');
      if (!userId) throw new Error('No hay operador autenticado.');
      setOperatorId(userId);
      const cached = await loadAssignedProjects(userId);
      setProjects(cached);
      // Show what the phone has first. The server calls below can take most of a
      // minute with an expired token and no server.
      const saved = await loadPedidosCache(userId);
      const savedList = saved ? await withLocalReceipts(saved.pedidos.map(toDisplayPedido), saved.savedAt) : [];
      const savedLocal = await loadLocalPedidos(userId, saved ? saved.pedidos.map((pedido) => Number(pedido.id)) : []);
      setPedidos([...savedLocal, ...savedList].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setLoading(false);
      setRefreshing(false);

      const assigned = await refreshAssignedProjects(userId);
      setProjects(assigned);
      if (assigned.length === 1) setSelectedProject(String(assigned[0].id));

      let remote: DisplayPedido[] = [];
      let cachedServerIds: number[] | null = null;
      try {
        const response = await pedidosApi.getAll();
        remote = await withLocalReceipts(response.data.map(toDisplayPedido), null);
        setOfflineSince(null);
        await savePedidosCache(userId, response.data).catch((cacheError) => {
          console.warn('[PHC] Could not keep pedidos for offline use:', cacheError);
        });
      } catch (remoteError) {
        console.warn('[PHC] Pedido refresh unavailable:', remoteError);
        // No signal: show what the server last returned, with any delivery
        // confirmed on this phone since then laid over it.
        if (saved) {
          remote = savedList;
          cachedServerIds = saved.pedidos.map((pedido) => Number(pedido.id));
          setOfflineSince(saved.savedAt);
        }
        // With no saved list at all, the phone's own copies are all there is.
        cachedServerIds = cachedServerIds ?? [];
      }
      const local = await loadLocalPedidos(userId, cachedServerIds);
      setPedidos([...local, ...remote].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

      try {
        setCatalog(await productV2Api.getCatalog());
      } catch (catalogError) {
        console.warn('[PHC] Catalog unavailable; free-text pedido remains available:', catalogError);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los pedidos');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadLocalPedidos, withLocalReceipts]);

  useOperatorDataRefresh(() => load(false));

  const resetForm = () => {
    setKind('empresa');
    setPriority('Normal');
    setNeededBy('');
    setJustification('');
    setNotes('');
    setDraftItems([newDraftItem()]);
    if (projects.length === 1) setSelectedProject(String(projects[0].id));
  };

  const updateDraft = (id: string, patch: Partial<DraftItem>) => {
    setDraftItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const submitPedido = async () => {
    if (!selectedProject) {
      showSheet('Falta el pozo', 'Seleccioná un pozo asignado.');
      return;
    }
    if (kind === 'empresa' && justification.trim().length < 3) {
      showSheet('Falta justificación', 'Explicá por qué la empresa debe proveer este pedido.');
      return;
    }
    const unreadable = draftItems.map((item) => parseQuantity(item.quantity)).find((parsed) => parsed.ok === false);
    if (unreadable && unreadable.ok === false) {
      showSheet('Cantidad inválida', unreadable.error);
      return;
    }
    const invalid = draftItems.find((item) => !item.materialName.trim() || !item.unit.trim()
      || !(readQuantity(item.quantity) > 0));
    if (invalid) {
      showSheet('Revisá los ítems', 'Cada ítem necesita nombre, unidad y una cantidad mayor que cero.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const now = new Date().toISOString();
      const clientEntryId = createClientEntryId('pedido');
      const requestItems = draftItems.map((item): PedidoDraftItem => ({
        client_entry_id: createClientEntryId('pedido_item'),
        catalog_variant_id: item.catalogVariantId,
        material_name: item.materialName.trim(),
        requested_quantity: readQuantity(item.quantity),
        unit: item.unit.trim(),
        layer: 'extras',
      }));
      const payload = {
        clientEntryId,
        projectId: Number(selectedProject),
        kind,
        items: requestItems,
        justification: justification.trim() || undefined,
        priority,
        neededBy: neededBy.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      const project = projects.find((item) => String(item.id) === selectedProject);
      let localPedidoId = 0;

      await runInTransaction(async (transaction) => {
        const total = requestItems.reduce((sum, item) => sum + item.requested_quantity, 0);
        const inserted = await insertSupplyRequest(
          {
            client_entry_id: clientEntryId,
            project_id: Number(selectedProject),
            operator_id: operatorId,
            material: `${requestItems.length} ítem${requestItems.length === 1 ? '' : 's'}`,
            quantity: total,
            priority,
            reason: justification.trim() || notes.trim() || null,
            needed_by: neededBy.trim() || null,
            job_site: project?.location || null,
            pedido_type: kind,
            notes: notes.trim() || null,
            kind,
            justification: justification.trim() || null,
            created_at: now,
            updated_at: now,
          },
          transaction.execute,
        );
        localPedidoId = Number(inserted.lastInsertRowId);

        for (const item of requestItems) {
          const localId = item.client_entry_id || createClientEntryId('pedido_item');
          await createLocalPedidoItem(
            {
              id: localId,
              clientEntryId: localId,
              pedidoId: localPedidoId,
              catalogVariantId: item.catalog_variant_id,
              materialName: item.material_name!,
              requestedQuantity: item.requested_quantity,
              unit: item.unit || 'unidad',
              layer: item.layer || 'extras',
              now,
            },
            transaction.execute,
          );
        }
        await transaction.execute(
          `INSERT INTO sync_outbox (
           id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'pedido_v2', ?, 'INSERT', ?, ?, 0, ?, ?)`,
          [createClientEntryId('outbox'), String(localPedidoId), JSON.stringify(payload), operatorId, now, now],
        );
      });

      // The shared drain, under its lock and in its order, rather than the pedido
      // step alone (code read S5). Then judge this pedido by its own queue row.
      await drainOutboxIncludingNew().catch(() => undefined);
      const sent = await readRecordSendState('pedido_v2', String(localPedidoId));
      showSheet('Pedido guardado', sent.kind === 'sent'
        ? syncedPedidoCreatedMessage(kind)
        : sent.kind === 'refused'
          ? `Quedó guardado en este dispositivo, pero el servidor no lo aceptó (${sent.reason}). Pasa a revisión del administrador.`
          : 'Quedó guardado en este dispositivo y se enviará automáticamente.');
      setShowCreate(false);
      resetForm();
      await load(false);
    } catch (saveError) {
      const detail = saveError instanceof Error ? saveError.message : 'No se pudo guardar el pedido';
      setError(detail);
      showSheet('Error al guardar', detail);
    } finally {
      setSaving(false);
    }
  };

  const openReceipt = (item: DisplayItem, pedidoKind: PedidoKind, projectId: number) => {
    // Rounded: 2.3 - 0.7 is 1.5999999999999999 in floating point (audit OPB-6).
    const remaining = roundQuantity(Math.max(0, Number(item.approved || 0) - item.received));
    setReceiptTarget({ ...item, pedidoKind, projectId });
    setReceiptOutcome('recibido');
    setReceiptQuantity(formatQuantity(remaining));
    setReceiptNote('');
  };

  const submitReceipt = async () => {
    if (!receiptTarget?.serverId) {
      showSheet('Aún no sincronizado', 'El ítem debe recibir su decisión del servidor antes de confirmar entrega.');
      return;
    }
    const remaining = roundQuantity(Number(receiptTarget.approved || 0) - receiptTarget.received);
    let quantity = 0;
    if (receiptOutcome !== 'no_recibido') {
      const parsed = parseQuantity(receiptQuantity);
      if (parsed.ok === false) {
        showSheet('Cantidad inválida', parsed.error);
        return;
      }
      quantity = roundQuantity(parsed.value);
    }
    if (quantity < 0 || quantity > remaining) {
      showSheet('Cantidad inválida', `La cantidad debe estar entre 0 y ${formatQuantity(remaining)} ${receiptTarget.unit}.`);
      return;
    }
    if (receiptOutcome === 'recibido' && quantity !== remaining) {
      showSheet('Recepción incompleta', 'Usá “Parcial” hasta completar exactamente la cantidad aprobada.');
      return;
    }
    if (receiptOutcome === 'parcial' && !(quantity > 0 && quantity < remaining)) {
      showSheet(
        'Cantidad inválida',
        `La entrega parcial debe ser mayor que cero y menor que lo pendiente (${formatQuantity(remaining)} ${receiptTarget.unit}). Para recibir todo, elegí “Recibido completo”.`,
      );
      return;
    }
    if ((receiptOutcome === 'parcial' || receiptOutcome === 'no_recibido') && receiptNote.trim().length < 3) {
      showSheet('Falta una nota', 'Describí la entrega parcial o el incidente.');
      return;
    }

    setSaving(true);
    try {
      const now = new Date().toISOString();
      const receiptId = createClientEntryId('receipt');
      const persistedItem = await queryFirst<{ id: string }>(
        'SELECT id FROM pedido_items WHERE server_id = ? LIMIT 1',
        [receiptTarget.serverId],
      );
      const localItemId = receiptTarget.localId || persistedItem?.id || `server_item_${receiptTarget.serverId}`;
      const newReceived = roundQuantity(receiptTarget.received + quantity);
      const provisionalState = receiptOutcome === 'no_recibido'
        ? 'no_recibido'
        : newReceived === roundQuantity(Number(receiptTarget.approved)) ? 'recibido' : 'parcial';
      const payload = {
        projectId: receiptTarget.projectId,
        localItemId,
        itemServerId: receiptTarget.serverId,
        clientEntryId: receiptId,
        outcome: receiptOutcome,
        quantityReceived: quantity,
        incidentNote: receiptNote.trim() || undefined,
      };

      await runInTransaction(async (transaction) => {
        await ensureServerPedidoItem(
          {
            id: localItemId,
            serverId: receiptTarget.serverId,
            materialName: receiptTarget.name,
            requestedQuantity: receiptTarget.requested,
            unit: receiptTarget.unit,
            state: receiptTarget.state,
            approvedQuantity: receiptTarget.approved ?? null,
            receivedQuantity: receiptTarget.received,
            layer: receiptTarget.layer,
            now,
          },
          transaction.execute,
        );
        await createLocalPedidoReceipt(
          {
            id: receiptId,
            clientEntryId: receiptId,
            pedidoItemId: localItemId,
            pedidoItemServerId: receiptTarget.serverId,
            outcome: receiptOutcome,
            quantityReceived: quantity,
            incidentNote: receiptNote.trim() || null,
            confirmedBy: operatorId,
            confirmedAt: now,
          },
          transaction.execute,
        );
        await applyProvisionalPedidoReceipt(
          {
            id: localItemId,
            state: provisionalState,
            receivedQuantity: newReceived,
            updatedAt: now,
          },
          transaction.execute,
        );
        await transaction.execute(
          `INSERT INTO sync_outbox (
             id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'pedido_receipt', ?, 'INSERT', ?, ?, 0, ?, ?)`,
          [createClientEntryId('outbox'), receiptId, JSON.stringify(payload), operatorId, now, now],
        );
      });

      await drainOutboxIncludingNew().catch(() => undefined);
      const sent = await readRecordSendState('pedido_receipt', receiptId);
      showSheet('Recepción guardada', sent.kind === 'refused'
        ? `Quedó guardada en este dispositivo, pero el servidor no la aceptó (${sent.reason}). Pasa a revisión del administrador.`
        : pedidoReceiptSavedMessage(receiptTarget.pedidoKind, sent.kind === 'sent'));
      setReceiptTarget(null);
      await load(false);
    } catch (receiptError) {
      showSheet('Error', receiptError instanceof Error ? receiptError.message : 'No se pudo guardar la recepción');
    } finally {
      setSaving(false);
    }
  };

  const createPedido = () => runOnce(pedidoInFlight, submitPedido);
  const saveReceipt = () => runOnce(receiptInFlight, submitReceipt);

  if (loading) {
    return <View style={[styles.container, styles.centered]}><ActivityIndicator color={COLORS.accent} /><Text style={styles.muted}>Cargando pedidos…</Text></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Pedidos</Text>
          <Text style={styles.muted}>Aprobación y recepción son pasos separados.</Text>
        </View>
        <TouchableOpacity style={styles.primaryButtonSmall} onPress={() => { resetForm(); setShowCreate(true); }}>
          <Text style={styles.buttonText}>+ Nuevo</Text>
        </TouchableOpacity>
      </View>
      {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
      {offlineSince ? (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>
            Sin conexión. Se muestran los pedidos guardados el {formatDisplayDateTime(offlineSince)}.
          </Text>
        </View>
      ) : null}
      <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(false); }} tintColor={COLORS.accent} />}
      >
        {pedidos.length === 0 ? (
          <View style={styles.empty}><Text style={styles.cardTitle}>Sin pedidos</Text><Text style={styles.muted}>Creá un pedido con uno o varios ítems.</Text></View>
        ) : pedidos.map((pedido) => (
          <View key={pedido.id} style={styles.card}>
            <View style={styles.rowBetween}>
              <View style={styles.flex}>
                <Text style={styles.cardTitle}>{pedido.number || 'Pedido pendiente'}</Text>
                <Text style={styles.muted}>{pedido.projectName} · {pedido.kind === 'empresa' ? 'Empresa' : 'Personal'}</Text>
              </View>
              <View style={[styles.badge, { borderColor: statusColor(pedido.status) }]}>
                <Text style={[styles.badgeText, { color: statusColor(pedido.status) }]}>{pedido.status}</Text>
              </View>
            </View>
            {pedido.syncStatus && pedido.syncStatus !== 'synced' ? <Text style={styles.pendingText}>{pedido.syncStatus === 'failed' ? 'No se pudo subir todavía; se vuelve a intentar sola.' : 'Guardado en este dispositivo; se sube cuando haya conexión.'}</Text> : null}
            {pedido.justification ? <Text style={styles.justification}>{pedido.justification}</Text> : null}
            {pedido.items.map((item) => {
              const canReceive = Boolean(item.serverId) && (item.state === 'aprobado' || item.state === 'parcial');
              return (
                <View key={item.id} style={styles.itemRow}>
                  <View style={styles.flex}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.muted}>
                      Solicitado {item.requested} {item.unit}
                      {item.approved != null ? ` · Aprobado ${item.approved}` : ''}
                      {item.received ? ` · Recibido ${item.received}` : ''}
                    </Text>
                  </View>
                  <View style={styles.itemAction}>
                    <Text style={[styles.itemState, { color: statusColor(item.state) }]}>{item.state.replace('_', ' ')}</Text>
                    {item.pendingReceipt ? (
                      <Text style={styles.pendingText}>Recepción guardada, pendiente de envío</Text>
                    ) : canReceive ? (
                      <TouchableOpacity style={styles.receiveButton} onPress={() => openReceipt(item, pedido.kind, pedido.projectId)}>

                        <Text style={styles.receiveText}>Confirmar entrega</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>

      <Modal visible={showCreate} animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.modal} contentContainerStyle={styles.modalContent}>
          <Text style={styles.title}>Nuevo pedido</Text>
          <Text style={styles.label}>Tipo *</Text>
          <View style={styles.segment}>
            {(['empresa', 'personal'] as PedidoKind[]).map((value) => (
              <TouchableOpacity key={value} style={[styles.segmentButton, kind === value && styles.segmentActive]} onPress={() => setKind(value)}>
                <Text style={styles.buttonText}>{value === 'empresa' ? 'Empresa' : 'Personal'}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Pozo *</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={selectedProject} onValueChange={(value) => setSelectedProject(String(value))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
              <Picker.Item label="Seleccioná…" value="" />
              {projects.map((project) => <Picker.Item key={project.id} label={project.name} value={String(project.id)} />)}
            </Picker>
          </View>

          {kind === 'empresa' ? (
            <><Text style={styles.label}>Justificación de empresa *</Text><TextInput style={[styles.input, styles.textArea]} value={justification} onChangeText={setJustification} multiline placeholder="Motivo operativo" placeholderTextColor={COLORS.placeholder} /></>
          ) : null}

          {draftItems.map((item, index) => (
            <View key={item.id} style={styles.draftCard}>
              <View style={styles.rowBetween}><Text style={styles.cardTitle}>Ítem {index + 1}</Text>{draftItems.length > 1 ? <TouchableOpacity onPress={() => setDraftItems((current) => current.filter((row) => row.id !== item.id))}><Text style={styles.removeText}>Quitar</Text></TouchableOpacity> : null}</View>
              {catalogOptions.length ? (
                <View style={styles.pickerWrap}>
                  <Picker
                    selectedValue={item.catalogVariantId || 0}
                    onValueChange={(value) => {
                      const option = catalogOptions.find((entry) => entry.id === Number(value));
                      updateDraft(item.id, option ? { catalogVariantId: option.id, materialName: option.name, unit: option.unit } : { catalogVariantId: undefined });
                    }}
                    style={styles.picker}
                    dropdownIconColor={COLORS.textSecondary}
                  >
                    <Picker.Item label="Catálogo (opcional)" value={0} />
                    {catalogOptions.map((option) => <Picker.Item key={option.id} label={option.name} value={option.id} />)}
                  </Picker>
                </View>
              ) : null}
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={item.materialName} onChangeText={(materialName) => updateDraft(item.id, { materialName, catalogVariantId: undefined })} placeholder="Material o equipo" placeholderTextColor={COLORS.placeholder} />
              <View style={styles.inputRow}>
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={[styles.input, styles.flex]} value={item.quantity} onChangeText={(quantity) => updateDraft(item.id, { quantity })} keyboardType="decimal-pad" placeholder="Cantidad" placeholderTextColor={COLORS.placeholder} />
                {/* A catalog item's unit comes from the catalog: the server replaces
                    whatever is typed here, so it is read-only (audit OPB-5). */}
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={[styles.input, styles.flex, item.catalogVariantId ? styles.inputReadOnly : null]} value={item.unit} onChangeText={(unit) => updateDraft(item.id, { unit })} editable={!item.catalogVariantId} placeholder="Unidad" placeholderTextColor={COLORS.placeholder} />
              </View>
              {quantityPreview(item.quantity) ? <Text style={styles.muted}>{quantityPreview(item.quantity)}</Text> : null}
              {item.catalogVariantId ? <Text style={styles.muted}>Unidad del catálogo.</Text> : null}
            </View>
          ))}
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setDraftItems((current) => [...current, newDraftItem()])}><Text style={styles.buttonText}>+ Agregar ítem</Text></TouchableOpacity>

          <Text style={styles.label}>Prioridad</Text>
          <View style={styles.pickerWrap}><Picker selectedValue={priority} onValueChange={setPriority} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>{['Urgente', 'Normal', 'Baja'].map((value) => <Picker.Item key={value} label={value} value={value} />)}</Picker></View>
          {/* Was a free text field asking the operator to type "AAAA-MM-DD" —
              on a phone, in the field, in gloves, with no validation and no
              indication of what a valid answer looked like. These cover what a
              pedido actually asks for, cannot be mistyped, and still store the
              same AAAA-MM-DD the server expects. */}
          <Text style={styles.label}>Necesario para</Text>
          <View style={styles.chipRow}>
            {NEEDED_BY_CHOICES.map((choice) => {
              const value = choice.days === null ? '' : storedDateFromToday(choice.days);
              const selected = neededBy === value;
              return (
                <TouchableOpacity
                  key={choice.label}
                  style={[styles.chip, selected && styles.chipSelected]}
                  onPress={() => setNeededBy(value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {choice.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {/* The resolved date, so "En 3 días" is never ambiguous. */}
          <Text style={styles.chipResolved}>
            {neededBy ? formatDisplayDate(neededBy) : 'Sin fecha límite'}
          </Text>
          <Text style={styles.label}>Notas</Text>
          <TextInput style={[styles.input, styles.textArea]} value={notes} onChangeText={setNotes} multiline placeholder="Opcional" placeholderTextColor={COLORS.placeholder} />

          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowCreate(false)}><Text style={styles.buttonText}>Cancelar</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.primaryButton, saving && styles.disabled]} disabled={saving} onPress={createPedido}><Text style={styles.buttonText}>{saving ? 'Guardando…' : 'Guardar pedido'}</Text></TouchableOpacity>
          </View>
        </ScrollView>
      </Modal>

      <Modal visible={Boolean(receiptTarget)} transparent animationType="fade" onRequestClose={() => setReceiptTarget(null)}>
        <View style={styles.overlay}><View style={styles.receiptModal}>
          <Text style={styles.cardTitle}>Confirmar entrega</Text>
          <Text style={styles.muted}>{receiptTarget?.name}</Text>
          <View style={styles.pickerWrap}><Picker selectedValue={receiptOutcome} onValueChange={setReceiptOutcome} style={styles.picker} dropdownIconColor={COLORS.textSecondary}><Picker.Item label="Recibido completo" value="recibido" /><Picker.Item label="Entrega parcial" value="parcial" /><Picker.Item label="No recibido" value="no_recibido" /></Picker></View>
          {receiptOutcome !== 'no_recibido' ? <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={receiptQuantity} onChangeText={setReceiptQuantity} keyboardType="decimal-pad" placeholder="Cantidad recibida" placeholderTextColor={COLORS.placeholder} /> : null}
          {receiptOutcome !== 'no_recibido' && quantityPreview(receiptQuantity) ? <Text style={styles.muted}>{quantityPreview(receiptQuantity)}</Text> : null}
          <TextInput style={[styles.input, styles.textArea]} value={receiptNote} onChangeText={setReceiptNote} multiline placeholder={receiptOutcome === 'recibido' ? 'Nota opcional' : 'Explicación obligatoria'} placeholderTextColor={COLORS.placeholder} />
          <Text style={styles.inventoryNote}>{receiptTarget?.pedidoKind === 'empresa' ? 'El inventario cambia al sincronizar esta recepción.' : 'Los pedidos personales nunca cambian inventario.'}</Text>
          <View style={styles.modalActions}><TouchableOpacity style={styles.secondaryButton} onPress={() => setReceiptTarget(null)}><Text style={styles.buttonText}>Cancelar</Text></TouchableOpacity><TouchableOpacity style={[styles.primaryButton, saving && styles.disabled]} disabled={saving} onPress={saveReceipt}><Text style={styles.buttonText}>Confirmar</Text></TouchableOpacity></View>
        </View></View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centered: { justifyContent: 'center', alignItems: 'center', gap: SPACING.md },
  header: { padding: SPACING.xl, paddingBottom: SPACING.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  content: { paddingHorizontal: SPACING.xl, paddingBottom: SPACING.huge4 },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  muted: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18 },
  card: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, padding: SPACING.lg, marginBottom: SPACING.lg },
  cardTitle: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.bold },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACING.sm },
  flex: { flex: 1 },
  badge: { borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.sm },
  chip: {
    minHeight: SPACING.huge2,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.input,
  },
  chipSelected: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { fontSize: TYPE.bodyLg, fontWeight: TYPE.medium, color: COLORS.textSecondary },
  chipTextSelected: { color: COLORS.textOnPrimary, fontWeight: TYPE.semibold },
  chipResolved: { fontSize: TYPE.label, color: COLORS.textMuted, marginBottom: SPACING.sm },
  badgeText: { fontSize: TYPE.micro, fontWeight: TYPE.bold },
  pendingText: { color: COLORS.warningText, fontSize: TYPE.micro, marginTop: SPACING.sm },
  justification: { color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.sm, fontStyle: 'italic' },
  itemRow: { borderTopWidth: 1, borderTopColor: COLORS.borderLight, paddingTop: SPACING.md, marginTop: SPACING.md, flexDirection: 'row', gap: SPACING.sm },
  itemName: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.semibold },
  itemAction: { alignItems: 'flex-end', gap: SPACING.sm },
  itemState: { fontSize: TYPE.micro, fontWeight: TYPE.bold, textTransform: 'capitalize' },
  receiveButton: { minHeight: 48, justifyContent: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.sm, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  receiveText: { color: COLORS.text, fontSize: TYPE.micro, fontWeight: TYPE.bold },
  primaryButtonSmall: { minHeight: 48, justifyContent: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  buttonText: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.bold, textAlign: 'center' },
  empty: { alignItems: 'center', padding: SPACING.xxxl, backgroundColor: COLORS.card, borderRadius: RADIUS.lg },
  offlineBanner: { marginHorizontal: SPACING.xl, marginBottom: SPACING.sm, backgroundColor: COLORS.warningBg, borderWidth: 1, borderColor: COLORS.warning, borderRadius: RADIUS.md, padding: SPACING.md },
  offlineText: { color: COLORS.warningText, fontSize: TYPE.caption, lineHeight: 18 },
  errorBanner: { marginHorizontal: SPACING.xl, backgroundColor: COLORS.errorBg, borderWidth: 1, borderColor: COLORS.error, borderRadius: RADIUS.md, padding: SPACING.md },
  errorText: { color: COLORS.errorText, fontSize: TYPE.caption },
  modal: { flex: 1, backgroundColor: COLORS.background },
  modalContent: { padding: SPACING.xl, paddingTop: SPACING.huge3, paddingBottom: SPACING.huge5 },
  label: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.semibold, marginTop: SPACING.lg, marginBottom: SPACING.sm },
  pickerWrap: { backgroundColor: COLORS.input, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, overflow: 'hidden', marginTop: SPACING.sm },
  picker: { color: COLORS.text },
  segment: { flexDirection: 'row', gap: SPACING.sm },
  segmentButton: { minHeight: 48, justifyContent: 'center', flex: 1, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md },
  segmentActive: { backgroundColor: COLORS.primary, borderColor: COLORS.accent },
  inputReadOnly: { opacity: 0.6 },
  input: { backgroundColor: COLORS.input, color: COLORS.text, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.sm },
  inputRow: { flexDirection: 'row', gap: SPACING.sm },
  textArea: { minHeight: 76, textAlignVertical: 'top' },
  draftCard: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, padding: SPACING.md, marginTop: SPACING.md },
  removeText: { color: COLORS.errorText, fontSize: TYPE.caption, fontWeight: TYPE.bold },
  secondaryButton: { minHeight: 48, justifyContent: 'center', flex: 1, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  primaryButton: { minHeight: 48, justifyContent: 'center', flex: 1, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  disabled: { opacity: 0.45 },
  modalActions: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.lg },
  overlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.72)', padding: SPACING.xl },
  receiptModal: { backgroundColor: COLORS.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.border, padding: SPACING.lg },
  inventoryNote: { color: COLORS.warningText, fontSize: TYPE.caption, marginTop: SPACING.md, lineHeight: 18 },
});

export default PedidosV2Tab;
