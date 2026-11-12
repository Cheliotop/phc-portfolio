import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Picker } from '@react-native-picker/picker';
import { pedidosApi } from '../../api/supabase-pedidos';
import { formatDisplayDate, formatDisplayDateTime } from '../../utils/dateFormat';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import type {
  MaterialLayer,
  PedidoItem,
  PedidoItemState,
  PedidoKind,
  PedidoV2,
} from '../../types/productV2';
import { showSheet } from '../shared/Sheet';
import { adminErrorText } from '../../domain/adminErrors';

type KindFilter = 'todos' | PedidoKind;
type StatusFilter = 'todos' | 'decision' | 'entrega' | 'cerrado';
type ItemDecision = 'aprobado' | 'rechazado';

interface DecisionContext {
  pedido: PedidoV2;
  item: PedidoItem;
  decision: ItemDecision;
}

interface CloseContext {
  pedido: PedidoV2;
}

const TERMINAL_ITEM_STATES: PedidoItemState[] = [
  'rechazado',
  'recibido',
  'no_recibido',
];
const PEDIDOS_PAGE_SIZE = 20;

const itemStateLabel = (state: PedidoItemState) => {
  switch (state) {
    case 'solicitado': return 'Solicitado';
    case 'aprobado': return 'Aprobado';
    case 'rechazado': return 'Rechazado';
    case 'recibido': return 'Recibido';
    case 'parcial': return 'Recepción parcial';
    case 'no_recibido': return 'No recibido';
    default: return state;
  }
};

const receiptOutcomeLabel = (outcome: string) => {
  switch (outcome) {
    case 'recibido': return 'Recibido';
    case 'parcial': return 'Parcial';
    case 'no_recibido': return 'No recibido';
    default: return outcome;
  }
};

const layerLabel = (layer: MaterialLayer) => (
  layer === 'presupuesto' ? 'Presupuesto' : 'Extras'
);

const formatQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  // Intl is NOT available in Hermes (React Native) and `new Intl.NumberFormat`
  // throws "Can't find variable: Intl", which white-screened the whole admin
  // dashboard. Format manually: up to 3 decimals, no trailing zeros. (This
  // matches how the rest of the app already renders at runtime, since Hermes
  // silently ignores the locale passed to toLocaleString.)
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return String(rounded);
};

// The comment on formatQuantity above already notes that the engine silently
// ignores the locale passed to toLocaleString — this used to call it anyway, so
// every pedido date reached the administrator in English.
const formatDateTime = (value?: string | null) => formatDisplayDateTime(value);

// Supabase errors are plain objects, not Error, so this always fell back to
// "Intentá de nuevo." and hid causes such as "El ítem ya fue decidido", which no
// retry can fix (code read A8).
const errorMessage = (error: unknown, fallback: string) => adminErrorText(error, fallback);

const itemTone = (state: PedidoItemState) => {
  switch (state) {
    case 'recibido': return { color: COLORS.successText, backgroundColor: COLORS.successBg };
    case 'rechazado':
    case 'no_recibido': return { color: COLORS.errorText, backgroundColor: COLORS.errorBg };
    case 'solicitado':
    case 'parcial': return { color: COLORS.warningText, backgroundColor: COLORS.warningBg };
    case 'aprobado':
    default: return { color: COLORS.primaryText, backgroundColor: 'rgba(78,134,216,0.16)' };
  }
};

const pedidoHasOpenItems = (pedido: PedidoV2) => (
  (pedido.pedido_items || []).some((item) => !TERMINAL_ITEM_STATES.includes(item.state))
);

const operatorName = (pedido: PedidoV2) => (
  pedido.profiles?.full_name?.trim()
  || pedido.profiles?.username?.trim()
  || `Operador ${pedido.operator_id}`
);

const projectName = (pedido: PedidoV2) => (
  pedido.projects?.name?.trim() || `Proyecto ${pedido.project_id}`
);

const pedidoLabel = (pedido: PedidoV2) => (
  pedido.pedido_number?.trim() || `Pedido #${pedido.id}`
);

const PedidosV2AdminTab = () => {
  const [pedidos, setPedidos] = useState<PedidoV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('todos');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [search, setSearch] = useState('');
  const [pedidoPage, setPedidoPage] = useState(1);
  const [hasMorePedidos, setHasMorePedidos] = useState(true);
  const [loadingMorePedidos, setLoadingMorePedidos] = useState(false);
  // Filters must see every pedido, not only the pages already on screen: once a
  // filter is active the whole list is read from the server (see loadAllPedidos).
  const [fullListLoaded, setFullListLoaded] = useState(false);
  const [loadingAllPedidos, setLoadingAllPedidos] = useState(false);

  const [decisionContext, setDecisionContext] = useState<DecisionContext | null>(null);
  const [approvedQuantity, setApprovedQuantity] = useState('');
  const [decisionLayer, setDecisionLayer] = useState<MaterialLayer>('extras');
  const [decisionReason, setDecisionReason] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);

  const [closeContext, setCloseContext] = useState<CloseContext | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [closeBusy, setCloseBusy] = useState(false);

  const loadPedidos = useCallback(async (isRefresh = false, page = 1, append = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLastError(null);

    try {
      const response = await pedidosApi.getAll({ page, pageSize: PEDIDOS_PAGE_SIZE });
      setPedidoPage(page);
      setHasMorePedidos(response.data.length === PEDIDOS_PAGE_SIZE);
      if (!append) setFullListLoaded(false);
      setPedidos((current) => append ? [...current, ...response.data] : (response.data || []));
    } catch (error: unknown) {
      setLastError(errorMessage(error, 'No se pudieron cargar los pedidos.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadAllPedidos = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoadingAllPedidos(true);
    }
    setLastError(null);
    try {
      const response = await pedidosApi.getAllPages(PEDIDOS_PAGE_SIZE);
      setPedidos(response.data || []);
      setHasMorePedidos(false);
      setFullListLoaded(true);
    } catch (error: unknown) {
      setLastError(adminErrorText(error, 'No se pudieron cargar los pedidos.'));
    } finally {
      setLoadingAllPedidos(false);
      setRefreshing(false);
    }
  }, []);

  const loadMorePedidos = async () => {
    if (!hasMorePedidos || loadingMorePedidos) return;
    setLoadingMorePedidos(true);
    try {
      await loadPedidos(false, pedidoPage + 1, true);
    } finally {
      setLoadingMorePedidos(false);
    }
  };

  useEffect(() => {
    loadPedidos();
  }, [loadPedidos]);

  const filterActive = kindFilter !== 'todos' || statusFilter !== 'todos' || search.trim() !== '';

  useEffect(() => {
    if (filterActive && !fullListLoaded && !loading) {
      void loadAllPedidos();
    }
  }, [filterActive, fullListLoaded, loading, loadAllPedidos]);

  // Reloads what is on screen: the whole list while a filter is active, otherwise
  // the first page. Used after a change and on pull-to-refresh.
  const reloadPedidos = useCallback(
    (isRefresh = false) => (filterActive ? loadAllPedidos(isRefresh) : loadPedidos(isRefresh)),
    [filterActive, loadAllPedidos, loadPedidos],
  );

  const filteredPedidos = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('es');

    return pedidos.filter((pedido) => {
      if (kindFilter !== 'todos' && pedido.kind !== kindFilter) {
        return false;
      }

      const items = pedido.pedido_items || [];
      if (statusFilter === 'decision' && !items.some((item) => item.state === 'solicitado')) {
        return false;
      }
      if (
        statusFilter === 'entrega'
        && !items.some((item) => item.state === 'aprobado' || item.state === 'parcial')
      ) {
        return false;
      }
      if (
        statusFilter === 'cerrado'
        && (
          (pedido.status || '').toLocaleLowerCase('es') !== 'cerrado'
          && (items.length === 0 || items.some((item) => !TERMINAL_ITEM_STATES.includes(item.state)))
        )
      ) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }
      const searchable = [
        pedidoLabel(pedido),
        projectName(pedido),
        pedido.projects?.location,
        operatorName(pedido),
        pedido.justification,
        pedido.notes,
        ...items.map((item) => item.material_name_snapshot),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('es');
      return searchable.includes(normalizedSearch);
    });
  }, [kindFilter, pedidos, search, statusFilter]);

  // The state that matters for a decision or a manual close: the pedido status and
  // every item's state.
  const pedidoSnapshot = (pedido: PedidoV2) => [
    pedido.status ?? '',
    ...(pedido.pedido_items || []).map((item) => `${item.id}:${item.state}`),
  ].join('|');

  // Re-reads the pedido before a write. If anything changed since the screen was
  // drawn (another admin, or a receipt that just synced from the tablet), nothing
  // is written: the list is updated and the admin decides again on the new data.
  const confirmPedidoUnchanged = async (shown: PedidoV2): Promise<boolean> => {
    const fresh = await pedidosApi.getById(shown.id);
    if (!fresh) {
      showSheet('Pedido no disponible', 'El pedido ya no está disponible. Actualizá la lista.');
      return false;
    }
    setPedidos((current) => current.map((pedido) => (pedido.id === fresh.id ? fresh : pedido)));
    if (pedidoSnapshot(fresh) !== pedidoSnapshot(shown)) {
      showSheet(
        'El pedido cambió',
        'Mientras lo mirabas llegaron cambios (una decisión, una recepción o un cierre). Revisá los datos actualizados antes de seguir.',
      );
      return false;
    }
    return true;
  };

  const openDecision = (pedido: PedidoV2, item: PedidoItem, decision: ItemDecision) => {
    setDecisionContext({ pedido, item, decision });
    setApprovedQuantity(decision === 'aprobado' ? String(item.requested_quantity) : '');
    setDecisionLayer(item.layer || 'extras');
    setDecisionReason('');
  };

  const closeDecisionModal = () => {
    if (decisionBusy) {
      return;
    }
    setDecisionContext(null);
    setApprovedQuantity('');
    setDecisionReason('');
    setDecisionLayer('extras');
  };

  const performDecision = async (
    context: DecisionContext,
    quantity: number | undefined,
    reason: string,
  ) => {
    setDecisionBusy(true);
    try {
      if (!(await confirmPedidoUnchanged(context.pedido))) {
        closeDecisionModalAfterSave();
        return;
      }
      await pedidosApi.decideItem({
        itemId: context.item.id,
        decision: context.decision,
        approvedQuantity: quantity,
        reason: reason || undefined,
        layer: decisionLayer,
      });
      closeDecisionModalAfterSave();
      await reloadPedidos();
      showSheet(
        context.decision === 'aprobado' ? 'Ítem aprobado' : 'Ítem rechazado',
        context.decision === 'aprobado'
          ? 'La autorización quedó registrada. El inventario todavía no cambió; cambia cuando el operador confirma la recepción.'
          : 'El rechazo y su motivo quedaron registrados.',
      );
    } catch (error: unknown) {
      showSheet('No se pudo registrar la decisión', errorMessage(error, 'Intentá de nuevo.'));
    } finally {
      setDecisionBusy(false);
    }
  };

  const closeDecisionModalAfterSave = () => {
    setDecisionContext(null);
    setApprovedQuantity('');
    setDecisionReason('');
    setDecisionLayer('extras');
  };

  const requestDecisionConfirmation = () => {
    if (!decisionContext) {
      return;
    }

    const reason = decisionReason.trim();
    if (decisionContext.decision === 'rechazado') {
      if (reason.length < 3) {
        showSheet('Motivo requerido', 'Escribí un motivo de rechazo de al menos 3 caracteres.');
        return;
      }
      showSheet(
        'Confirmar rechazo',
        `Vas a rechazar “${decisionContext.item.material_name_snapshot}”. Esta decisión no se puede editar desde esta pantalla.\n\nMotivo: ${reason}`,
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Rechazar ítem',
            style: 'destructive',
            onPress: () => performDecision(decisionContext, undefined, reason),
          },
        ],
      );
      return;
    }

    const quantity = Number(approvedQuantity.replace(',', '.'));
    if (!approvedQuantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      showSheet('Cantidad inválida', 'Ingresá una cantidad aprobada mayor que cero.');
      return;
    }

    const exceedsRequested = quantity > Number(decisionContext.item.requested_quantity);
    showSheet(
      exceedsRequested ? 'Cantidad superior a la solicitada' : 'Confirmar aprobación',
      [
        `Vas a aprobar ${formatQuantity(quantity)} ${decisionContext.item.unit_snapshot} de “${decisionContext.item.material_name_snapshot}” en ${layerLabel(decisionLayer)}.`,
        exceedsRequested ? `La cantidad solicitada fue ${formatQuantity(decisionContext.item.requested_quantity)}. Verificá este aumento.` : '',
        'La aprobación NO modifica el inventario. El inventario cambia solamente cuando el operador confirma la recepción.',
      ].filter(Boolean).join('\n\n'),
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: exceedsRequested ? 'Aprobar de todos modos' : 'Aprobar ítem',
          onPress: () => performDecision(decisionContext, quantity, reason),
        },
      ],
    );
  };

  const openManualClose = (pedido: PedidoV2) => {
    setCloseContext({ pedido });
    setCloseReason('');
  };

  const closeManualCloseModal = () => {
    if (closeBusy) {
      return;
    }
    setCloseContext(null);
    setCloseReason('');
  };

  const performManualClose = async (pedido: PedidoV2, reason: string) => {
    setCloseBusy(true);
    try {
      if (!(await confirmPedidoUnchanged(pedido))) {
        setCloseContext(null);
        setCloseReason('');
        return;
      }
      await pedidosApi.closeManually(pedido.id, reason);
      setCloseContext(null);
      setCloseReason('');
      await reloadPedidos();
      showSheet('Pedido cerrado', 'El cierre manual y su motivo quedaron registrados.');
    } catch (error: unknown) {
      showSheet('No se pudo cerrar el pedido', errorMessage(error, 'Intentá de nuevo.'));
    } finally {
      setCloseBusy(false);
    }
  };

  const requestManualCloseConfirmation = () => {
    if (!closeContext) {
      return;
    }
    const reason = closeReason.trim();
    if (reason.length < 3) {
      showSheet('Motivo requerido', 'Escribí un motivo de cierre de al menos 3 caracteres.');
      return;
    }

    showSheet(
      'Confirmar cierre manual',
      `Cerrarás ${pedidoLabel(closeContext.pedido)} y todos sus ítems pendientes o en entrega. La acción no se puede deshacer desde la app.\n\nSi el operador confirmó una recepción en la tablet sin señal, puede que todavía no haya llegado: ese ítem pasaría a «no recibido».\n\nMotivo: ${reason}`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Cerrar pedido',
          style: 'destructive',
          onPress: () => performManualClose(closeContext.pedido, reason),
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Cargando pedidos…</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => reloadPedidos(true)}
            colors={[COLORS.accent]}
            tintColor={COLORS.accent}
          />
        }
      >
        <Text style={styles.title}>Pedidos</Text>
        <Text style={styles.subtitle}>Decisiones por ítem y seguimiento de entregas</Text>

        <View style={styles.boundaryNotice}>
          <Text style={styles.boundaryTitle}>Aprobación ≠ inventario</Text>
          <Text style={styles.boundaryText}>
            Aprobar autoriza el ítem, pero no suma existencias. En pedidos Empresa,
            el inventario cambia únicamente cuando el operador confirma la recepción.
            Los pedidos Personal nunca afectan inventario.
          </Text>
        </View>

        {lastError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{lastError}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => reloadPedidos()}>
              <Text style={styles.retryButtonText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.filtersCard}>
          <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
            style={styles.input}
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar pedido, pozo, operador o material"
            placeholderTextColor={COLORS.placeholder}
            autoCorrect={false}
          />

          <Text style={styles.filterLabel}>Tipo</Text>
          <View style={styles.filterRow}>
            {([
              ['todos', 'Todos'],
              ['empresa', 'Empresa'],
              ['personal', 'Personal'],
            ] as Array<[KindFilter, string]>).map(([value, label]) => (
              <TouchableOpacity
                key={value}
                style={[styles.filterChip, kindFilter === value && styles.filterChipActive]}
                onPress={() => setKindFilter(value)}
              >
                <Text style={[styles.filterChipText, kindFilter === value && styles.filterChipTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.filterLabel}>Estado operativo</Text>
          <View style={styles.filterRow}>
            {([
              ['todos', 'Todos'],
              ['decision', 'Por decidir'],
              ['entrega', 'En entrega'],
              ['cerrado', 'Cerrados'],
            ] as Array<[StatusFilter, string]>).map(([value, label]) => (
              <TouchableOpacity
                key={value}
                style={[styles.filterChip, statusFilter === value && styles.filterChipActive]}
                onPress={() => setStatusFilter(value)}
              >
                <Text style={[styles.filterChipText, statusFilter === value && styles.filterChipTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.resultHeader}>
          <Text style={styles.resultCount}>
            {filteredPedidos.length} pedido(s) {fullListLoaded ? 'según los filtros' : 'cargado(s)'}
          </Text>
          <Text style={styles.refreshHint}>Deslizá hacia abajo para actualizar</Text>
        </View>

        {filteredPedidos.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Sin pedidos para estos filtros</Text>
            <Text style={styles.emptyText}>
              {loadingAllPedidos ? 'Buscando en todos los pedidos…' : 'Cambiá los filtros o actualizá desde el servidor.'}
            </Text>
          </View>
        ) : (
          filteredPedidos.map((pedido) => {
            const items = pedido.pedido_items || [];
            const canCloseManually = !pedido.closed_manually && pedidoHasOpenItems(pedido);

            return (
              <View key={pedido.id} style={styles.pedidoCard}>
                <View style={styles.pedidoHeader}>
                  <View style={styles.headerMain}>
                    <Text style={styles.pedidoNumber}>{pedidoLabel(pedido)}</Text>
                    <Text style={styles.pedidoDate}>{formatDateTime(pedido.created_at)}</Text>
                  </View>
                  <View
                    style={[
                      styles.kindBadge,
                      pedido.kind === 'empresa' ? styles.companyBadge : styles.personalBadge,
                    ]}
                  >
                    <Text style={styles.kindBadgeText}>
                      {pedido.kind === 'empresa' ? 'Empresa' : 'Personal'}
                    </Text>
                  </View>
                </View>

                <View style={styles.metaGrid}>
                  <Text style={styles.metaText}><Text style={styles.metaLabel}>Pozo: </Text>{projectName(pedido)}</Text>
                  {pedido.projects?.location ? (
                    <Text style={styles.metaText}><Text style={styles.metaLabel}>Ubicación: </Text>{pedido.projects.location}</Text>
                  ) : null}
                  <Text style={styles.metaText}><Text style={styles.metaLabel}>Operador: </Text>{operatorName(pedido)}</Text>
                  <Text style={styles.metaText}><Text style={styles.metaLabel}>Prioridad: </Text>{pedido.priority || 'Normal'}</Text>
                  <Text style={styles.metaText}><Text style={styles.metaLabel}>Estado: </Text>{pedido.status || 'Pendiente'}</Text>
                  {pedido.needed_by ? (
                    <Text style={styles.metaText}><Text style={styles.metaLabel}>Necesario: </Text>{formatDisplayDate(pedido.needed_by)}</Text>
                  ) : null}
                </View>

                {pedido.kind === 'empresa' ? (
                  <View style={styles.justificationBox}>
                    <Text style={styles.sectionLabel}>Justificación de empresa</Text>
                    <Text style={styles.bodyText}>{pedido.justification || 'Sin justificación visible'}</Text>
                  </View>
                ) : (
                  <View style={styles.personalNotice}>
                    <Text style={styles.personalNoticeText}>Pedido personal · sin efecto en inventario</Text>
                  </View>
                )}
                {pedido.notes ? (
                  <Text style={styles.notesText}><Text style={styles.metaLabel}>Notas: </Text>{pedido.notes}</Text>
                ) : null}

                <Text style={styles.itemsHeading}>Ítems ({items.length})</Text>
                {items.length === 0 ? (
                  <View style={styles.itemWarning}>
                    <Text style={styles.warningText}>El servidor no devolvió ítems para este pedido.</Text>
                  </View>
                ) : (
                  items.map((item, index) => {
                    const tone = itemTone(item.state);
                    const receipts = item.pedido_receipts || [];
                    return (
                      <View key={item.id} style={styles.itemCard}>
                        <View style={styles.itemHeader}>
                          <Text style={styles.itemTitle}>{index + 1}. {item.material_name_snapshot}</Text>
                          <View style={[styles.stateBadge, { backgroundColor: tone.backgroundColor }]}>
                            <Text style={[styles.stateBadgeText, { color: tone.color }]}>
                              {itemStateLabel(item.state)}
                            </Text>
                          </View>
                        </View>

                        <View style={styles.quantityGrid}>
                          <View style={styles.quantityCell}>
                            <Text style={styles.quantityLabel}>Solicitado</Text>
                            <Text style={styles.quantityValue}>{formatQuantity(item.requested_quantity)} {item.unit_snapshot}</Text>
                          </View>
                          <View style={styles.quantityCell}>
                            <Text style={styles.quantityLabel}>Aprobado</Text>
                            <Text style={styles.quantityValue}>{formatQuantity(item.approved_quantity)} {item.unit_snapshot}</Text>
                          </View>
                          <View style={styles.quantityCell}>
                            <Text style={styles.quantityLabel}>Recibido</Text>
                            <Text style={styles.quantityValue}>{formatQuantity(item.received_quantity)} {item.unit_snapshot}</Text>
                          </View>
                        </View>
                        <Text style={styles.layerText}>Capa: {layerLabel(item.layer)}</Text>

                        {item.decision_reason ? (
                          <View style={styles.auditNote}>
                            <Text style={styles.auditNoteLabel}>Motivo/nota de decisión</Text>
                            <Text style={styles.auditNoteText}>{item.decision_reason}</Text>
                          </View>
                        ) : null}
                        {item.incident_note ? (
                          <View style={[styles.auditNote, styles.incidentNote]}>
                            <Text style={styles.auditNoteLabel}>Incidente acumulado</Text>
                            <Text style={styles.auditNoteText}>{item.incident_note}</Text>
                          </View>
                        ) : null}

                        {item.state === 'solicitado' ? (
                          <View style={styles.itemActions}>
                            <TouchableOpacity
                              style={[styles.actionButton, styles.approveButton]}
                              onPress={() => openDecision(pedido, item, 'aprobado')}
                            >
                              <Text style={styles.actionButtonText}>Aprobar ítem</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.actionButton, styles.rejectButton]}
                              onPress={() => openDecision(pedido, item, 'rechazado')}
                            >
                              <Text style={styles.actionButtonText}>Rechazar</Text>
                            </TouchableOpacity>
                          </View>
                        ) : null}

                        <View style={styles.receiptsSection}>
                          <Text style={styles.receiptsHeading}>Historial de recepciones</Text>
                          {receipts.length === 0 ? (
                            <Text style={styles.noReceiptsText}>Aún no hay confirmaciones de recepción.</Text>
                          ) : (
                            receipts.map((receipt) => (
                              <View key={receipt.id} style={styles.receiptRow}>
                                <View style={styles.receiptHeader}>
                                  <Text style={styles.receiptOutcome}>{receiptOutcomeLabel(receipt.outcome)}</Text>
                                  <Text style={styles.receiptDate}>{formatDateTime(receipt.created_at)}</Text>
                                </View>
                                <Text style={styles.receiptQuantity}>
                                  Cantidad: {formatQuantity(receipt.quantity_received)} {item.unit_snapshot}
                                </Text>
                                {receipt.incident_note ? (
                                  <Text style={styles.receiptIncident}>Incidente: {receipt.incident_note}</Text>
                                ) : null}
                              </View>
                            ))
                          )}
                        </View>
                      </View>
                    );
                  })
                )}

                {pedido.closed_manually ? (
                  <View style={styles.manualClosedBox}>
                    <Text style={styles.manualClosedText}>Pedido cerrado manualmente por administración.</Text>
                  </View>
                ) : null}
                {canCloseManually ? (
                  <TouchableOpacity style={styles.manualCloseButton} onPress={() => openManualClose(pedido)}>
                    <Text style={styles.manualCloseButtonText}>Cerrar pedido manualmente</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })
        )}
        {hasMorePedidos ? (
          <TouchableOpacity
            style={styles.loadMoreButton}
            onPress={loadMorePedidos}
            disabled={loadingMorePedidos}
          >
            <Text style={styles.loadMoreButtonText}>
              {loadingMorePedidos ? 'Cargando…' : 'Cargar más pedidos'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      <Modal
        visible={decisionContext !== null}
        transparent
        animationType="slide"
        onRequestClose={closeDecisionModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <ScrollView
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
              <Text style={styles.modalTitle}>
                {decisionContext?.decision === 'aprobado' ? 'Aprobar ítem' : 'Rechazar ítem'}
              </Text>
              <Text style={styles.modalContext}>{decisionContext ? pedidoLabel(decisionContext.pedido) : ''}</Text>
              <Text style={styles.modalItemName}>{decisionContext?.item.material_name_snapshot}</Text>
              <Text style={styles.modalRequested}>
                Solicitado: {formatQuantity(decisionContext?.item.requested_quantity)} {decisionContext?.item.unit_snapshot}
              </Text>

              {decisionContext?.decision === 'aprobado' ? (
                <>
                  <Text style={styles.inputLabel}>Cantidad aprobada</Text>
                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                    style={styles.input}
                    value={approvedQuantity}
                    onChangeText={setApprovedQuantity}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor={COLORS.placeholder}
                    editable={!decisionBusy}
                  />

                  <Text style={styles.inputLabel}>Capa de material</Text>
                  <View style={styles.pickerContainer}>
                    <Picker
                      selectedValue={decisionLayer}
                      onValueChange={(value) => setDecisionLayer(value as MaterialLayer)}
                      enabled={!decisionBusy}
                      style={styles.picker}
                      dropdownIconColor={COLORS.text}
                    >
                      <Picker.Item label="Extras" value="extras" />
                      <Picker.Item label="Presupuesto" value="presupuesto" />
                    </Picker>
                  </View>
                </>
              ) : null}

              <Text style={styles.inputLabel}>
                {decisionContext?.decision === 'rechazado' ? 'Motivo del rechazo *' : 'Motivo o nota (opcional)'}
              </Text>
              <TextInput
                style={[styles.input, styles.multilineInput]}
                value={decisionReason}
                onChangeText={setDecisionReason}
                placeholder={decisionContext?.decision === 'rechazado' ? 'Explicá por qué se rechaza' : 'Observación administrativa'}
                placeholderTextColor={COLORS.placeholder}
                multiline
                maxLength={500}
                editable={!decisionBusy}
              />

              {decisionContext?.decision === 'aprobado' ? (
                <View style={styles.modalBoundaryNotice}>
                  <Text style={styles.modalBoundaryText}>
                    Esta aprobación no modifica inventario. La recepción del operador es el único evento que lo modifica para pedidos Empresa.
                  </Text>
                </View>
              ) : null}

              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.cancelButton]}
                  onPress={closeDecisionModal}
                  disabled={decisionBusy}
                >
                  <Text style={styles.cancelButtonText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modalButton,
                    decisionContext?.decision === 'rechazado' ? styles.rejectButton : styles.approveButton,
                    decisionBusy && styles.disabledButton,
                  ]}
                  onPress={requestDecisionConfirmation}
                  disabled={decisionBusy}
                >
                  {decisionBusy ? (
                    <ActivityIndicator color={COLORS.text} />
                  ) : (
                    <Text style={styles.actionButtonText}>Revisar y confirmar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={closeContext !== null}
        transparent
        animationType="fade"
        onRequestClose={closeManualCloseModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <ScrollView
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
              <Text style={styles.modalTitle}>Cerrar pedido manualmente</Text>
              <Text style={styles.modalContext}>{closeContext ? pedidoLabel(closeContext.pedido) : ''}</Text>
              <View style={styles.closeWarning}>
                <Text style={styles.closeWarningText}>
                  Los ítems solicitados serán rechazados y los aprobados o parciales quedarán como no recibidos. El motivo formará parte del registro de auditoría.
                </Text>
              </View>
              <Text style={styles.inputLabel}>Motivo del cierre *</Text>
              <TextInput
                style={[styles.input, styles.multilineInput]}
                value={closeReason}
                onChangeText={setCloseReason}
                placeholder="Explicá por qué se cierra el pedido"
                placeholderTextColor={COLORS.placeholder}
                multiline
                maxLength={500}
                editable={!closeBusy}
              />
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.cancelButton]}
                  onPress={closeManualCloseModal}
                  disabled={closeBusy}
                >
                  <Text style={styles.cancelButtonText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, styles.rejectButton, closeBusy && styles.disabledButton]}
                  onPress={requestManualCloseConfirmation}
                  disabled={closeBusy}
                >
                  {closeBusy ? (
                    <ActivityIndicator color={COLORS.text} />
                  ) : (
                    <Text style={styles.actionButtonText}>Revisar y cerrar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.lg, paddingBottom: SPACING.huge2 },
  centered: { justifyContent: 'center', alignItems: 'center', padding: SPACING.xl },
  loadingText: { color: COLORS.textSecondary, marginTop: SPACING.md, fontSize: TYPE.body },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  subtitle: { color: COLORS.textSecondary, fontSize: TYPE.body, marginTop: SPACING.xs, marginBottom: SPACING.lg },
  boundaryNotice: {
    backgroundColor: COLORS.warningBg,
    borderColor: COLORS.warning,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  boundaryTitle: { color: COLORS.warningText, fontSize: TYPE.body, fontWeight: TYPE.bold, marginBottom: SPACING.xs },
  boundaryText: { color: COLORS.text, fontSize: TYPE.label, lineHeight: 20 },
  errorBox: {
    backgroundColor: COLORS.errorBg,
    borderColor: COLORS.error,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
  },
  errorText: { color: COLORS.text, lineHeight: 20 },
  retryButton: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', marginTop: SPACING.sm, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md },
  retryButtonText: { color: COLORS.primaryText, fontWeight: TYPE.bold },
  filtersCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
  },
  input: {
    minHeight: 48,
    backgroundColor: COLORS.input,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    color: COLORS.text,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: TYPE.body,
  },
  filterLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold, marginTop: SPACING.md, marginBottom: SPACING.sm },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  filterChip: { minHeight: 48, justifyContent: 'center',
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    backgroundColor: COLORS.surfaceVariant,
  },
  filterChipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterChipText: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  filterChipTextActive: { color: COLORS.text },
  resultHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.md, gap: SPACING.sm },
  resultCount: { color: COLORS.text, fontWeight: TYPE.semibold },
  refreshHint: { color: COLORS.textMuted, fontSize: TYPE.micro, textAlign: 'right', flex: 1 },
  emptyCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.xl,
    alignItems: 'center',
  },
  emptyTitle: { color: COLORS.text, fontSize: TYPE.body, fontWeight: TYPE.semibold },
  emptyText: { color: COLORS.textSecondary, marginTop: SPACING.xs, textAlign: 'center' },
  pedidoCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  pedidoHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: SPACING.md },
  headerMain: { flex: 1 },
  pedidoNumber: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  pedidoDate: { color: COLORS.textMuted, fontSize: TYPE.caption, marginTop: SPACING.xs },
  kindBadge: { borderRadius: RADIUS.pill, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md },
  companyBadge: { backgroundColor: 'rgba(78,134,216,0.20)' },
  personalBadge: { backgroundColor: 'rgba(124,139,163,0.20)' },
  kindBadgeText: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.bold },
  metaGrid: { marginTop: SPACING.md, gap: SPACING.xs },
  metaText: { color: COLORS.textSecondary, fontSize: TYPE.label, lineHeight: 19 },
  metaLabel: { color: COLORS.text, fontWeight: TYPE.semibold },
  justificationBox: { backgroundColor: COLORS.surfaceVariant, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  sectionLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold, marginBottom: SPACING.xs },
  bodyText: { color: COLORS.text, fontSize: TYPE.label, lineHeight: 20 },
  personalNotice: { backgroundColor: 'rgba(124,139,163,0.16)', borderRadius: RADIUS.md, padding: SPACING.sm, marginTop: SPACING.md },
  personalNoticeText: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  notesText: { color: COLORS.textSecondary, fontSize: TYPE.label, marginTop: SPACING.sm, lineHeight: 20 },
  itemsHeading: { color: COLORS.text, fontSize: TYPE.body, fontWeight: TYPE.bold, marginTop: SPACING.lg, marginBottom: SPACING.sm },
  itemWarning: { backgroundColor: COLORS.warningBg, borderRadius: RADIUS.md, padding: SPACING.md },
  warningText: { color: COLORS.warningText, fontSize: TYPE.label },
  itemCard: { backgroundColor: COLORS.surfaceVariant, borderColor: COLORS.borderLight, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.md },
  itemHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: SPACING.sm },
  itemTitle: { color: COLORS.text, fontSize: TYPE.body, fontWeight: TYPE.semibold, flex: 1, lineHeight: 21 },
  stateBadge: { borderRadius: RADIUS.pill, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.sm },
  stateBadgeText: { fontSize: TYPE.micro, fontWeight: TYPE.bold },
  quantityGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md },
  quantityCell: { flexGrow: 1, flexBasis: 95, backgroundColor: COLORS.background, borderRadius: RADIUS.sm, padding: SPACING.sm },
  quantityLabel: { color: COLORS.textMuted, fontSize: TYPE.micro, marginBottom: SPACING.xs },
  quantityValue: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  layerText: { color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.sm },
  auditNote: { borderLeftColor: COLORS.accent, borderLeftWidth: 3, paddingLeft: SPACING.sm, marginTop: SPACING.md },
  incidentNote: { borderLeftColor: COLORS.warning },
  auditNoteLabel: { color: COLORS.textMuted, fontSize: TYPE.micro, fontWeight: TYPE.semibold },
  auditNoteText: { color: COLORS.text, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs },
  itemActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  actionButton: { flex: 1, minHeight: 44, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.sm },
  approveButton: { backgroundColor: COLORS.success },
  rejectButton: { backgroundColor: COLORS.error },
  actionButtonText: { color: COLORS.text, fontWeight: TYPE.bold, fontSize: TYPE.label, textAlign: 'center' },
  receiptsSection: { borderTopColor: COLORS.border, borderTopWidth: 1, marginTop: SPACING.lg, paddingTop: SPACING.md },
  receiptsHeading: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.bold },
  noReceiptsText: { color: COLORS.textMuted, fontSize: TYPE.caption, marginTop: SPACING.sm },
  receiptRow: { backgroundColor: COLORS.background, borderRadius: RADIUS.sm, padding: SPACING.sm, marginTop: SPACING.sm },
  receiptHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.sm },
  receiptOutcome: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  receiptDate: { color: COLORS.textMuted, fontSize: TYPE.micro, textAlign: 'right' },
  receiptQuantity: { color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.xs },
  receiptIncident: { color: COLORS.warningText, fontSize: TYPE.caption, marginTop: SPACING.xs, lineHeight: 17 },
  manualClosedBox: { backgroundColor: COLORS.errorBg, borderRadius: RADIUS.md, padding: SPACING.sm, marginTop: SPACING.xs },
  manualClosedText: { color: COLORS.errorText, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  manualCloseButton: { borderColor: COLORS.error, borderWidth: 1, borderRadius: RADIUS.md, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.md },
  manualCloseButtonText: { color: COLORS.errorText, fontSize: TYPE.label, fontWeight: TYPE.bold },
  loadMoreButton: {
    minHeight: 46,
    borderRadius: RADIUS.md,
    borderColor: COLORS.accent,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.lg,
  },
  loadMoreButtonText: { color: COLORS.primaryText, fontSize: TYPE.label, fontWeight: TYPE.bold },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  modalCard: { maxHeight: '90%', backgroundColor: COLORS.surface, borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg, borderColor: COLORS.border, borderWidth: 1 },
  modalContent: { padding: SPACING.xl, paddingBottom: SPACING.huge },
  modalTitle: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  modalContext: { color: COLORS.primaryText, fontSize: TYPE.caption, fontWeight: TYPE.semibold, marginTop: SPACING.sm },
  modalItemName: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.semibold, marginTop: SPACING.sm },
  modalRequested: { color: COLORS.textSecondary, fontSize: TYPE.label, marginTop: SPACING.xs, marginBottom: SPACING.md },
  inputLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold, marginTop: SPACING.md, marginBottom: SPACING.sm },
  pickerContainer: { backgroundColor: COLORS.input, borderColor: COLORS.border, borderWidth: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  picker: { color: COLORS.text, minHeight: 48 },
  multilineInput: { minHeight: 100, textAlignVertical: 'top', paddingTop: SPACING.md },
  modalBoundaryNotice: { backgroundColor: COLORS.warningBg, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  modalBoundaryText: { color: COLORS.text, fontSize: TYPE.caption, lineHeight: 18 },
  closeWarning: { backgroundColor: COLORS.errorBg, borderColor: COLORS.error, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.lg },
  closeWarningText: { color: COLORS.text, fontSize: TYPE.label, lineHeight: 20 },
  modalActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xl },
  modalButton: { flex: 1, minHeight: 48, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.sm },
  cancelButton: { backgroundColor: COLORS.surfaceVariant, borderColor: COLORS.border, borderWidth: 1 },
  cancelButtonText: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.bold },
  disabledButton: { opacity: 0.55 },
});

export default PedidosV2AdminTab;
