import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Modal, ScrollView } from 'react-native';
import { query } from '../../db/db';
import { resetOutboxForManualRetry } from '../../db/operations';
import { useTheme } from '../../hooks/useTheme';
import { drainOutbox } from '../../sync/drainCoordinator';
import { readQueueStatus } from '../../sync/queueStatus';
import { notifyOperatorDataChanged } from '../../events/operatorDataEvents';
import { subscribeToQueueChanges } from '../../events/queueEvents';
import { rejectedWorkLabel } from '../../domain/rejectedWork';
import { operatorErrorText } from '../../utils/errorMessage';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';

interface SyncQueueItem {
  id: string;
  entity: string;
  state: string | null;
  last_error?: string | null;
  created_at: string;
  reported_at: string | null;
  author_name?: string | null;
}

interface SyncStatusIndicatorProps {
  onPress?: () => void;
  showCount?: boolean;
}

/**
 * The header badge. Amber "Pendiente" while work is on its way, red "Rechazado"
 * while refused work has not reached the admin's review list yet, hidden otherwise.
 * Work that failed only for lack of signal is pending, not failed: it retries by
 * itself. Before, one failed row turned the whole queue red, refused work stayed red
 * after the admin had decided, and the count lagged up to 30 seconds behind a drain.
 */
export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({ onPress, showCount = true }) => {
  const { theme } = useTheme();
  const [waiting, setWaiting] = React.useState(0);
  const [refused, setRefused] = React.useState(0);
  const [opacity] = React.useState(new Animated.Value(0));

  React.useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const status = await readQueueStatus();
        if (!active) return;
        setWaiting(status.waiting);
        setRefused(status.refused);
        Animated.timing(opacity, {
          toValue: status.waiting + status.refused > 0 ? 1 : 0,
          duration: 300,
          useNativeDriver: true,
        }).start();
      } catch (error) {
        console.error('[Sync] Count check failed:', error);
      }
    };
    check();
    const interval = setInterval(check, 15000);
    const unsubscribe = subscribeToQueueChanges(check);
    return () => {
      active = false;
      clearInterval(interval);
      unsubscribe();
    };
  }, [opacity]);

  const total = waiting + refused;
  if (total === 0 && !showCount) {
    return null;
  }

  const color = waiting > 0 ? theme.colors.warning : refused > 0 ? theme.colors.error : theme.colors.success;
  const label = waiting > 0 ? 'Pendiente' : refused > 0 ? 'Rechazado' : 'Al día';
  const count = waiting > 0 ? waiting : refused;

  return (
    <Animated.View style={[styles.container, { opacity }]}>
      <TouchableOpacity
        style={[styles.badge, { backgroundColor: color }]}
        onPress={onPress}
        disabled={!onPress}
      >
        <Text style={styles.badgeLabel}>{label}</Text>
        {showCount && count > 0 && <Text style={styles.count}>{count}</Text>}
      </TouchableOpacity>
    </Animated.View>
  );
};

/** One line, in plain words, about where a queued record stands. */
const itemStatus = (item: SyncQueueItem): string => {
  if (item.state === 'quarantined') {
    const reason = operatorErrorText(item.last_error);
    const prefix = reason ? `El servidor lo rechazó: ${reason}` : 'El servidor lo rechazó.';
    return item.reported_at
      ? `${prefix.replace(/\.?$/, '.')} El administrador lo está revisando.`
      : `${prefix.replace(/\.?$/, '.')} Se enviará al administrador para que lo revise.`;
  }
  const reason = operatorErrorText(item.last_error);
  return reason
    ? `No se pudo subir todavía (${reason.replace(/\.$/, '')}). Se vuelve a intentar solo.`
    : 'Esperando para subir.';
};

const SyncQueueModal: React.FC<{ visible: boolean; onClose: () => void }> = ({ visible, onClose }) => {
  const { theme } = useTheme();
  const [items, setItems] = React.useState<SyncQueueItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [retrying, setRetrying] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      loadQueue();
    }
  }, [visible]);

  const loadQueue = async () => {
    setLoading(true);
    try {
      const result = await query<SyncQueueItem>(`
        SELECT o.id, o.entity, o.state, o.last_error, o.created_at, r.uploaded_at AS reported_at,
               op.name AS author_name
        FROM sync_outbox o
        LEFT JOIN rejected_work r ON r.id = o.id
        LEFT JOIN operators op ON op.id = o.author_id
        ORDER BY o.created_at DESC
        LIMIT 50
      `);
      setItems(result || []);
    } catch (error) {
      console.error('[Sync] Load queue failed:', error);
    } finally {
      setLoading(false);
    }
  };

  // Manual retry: rows that ran out of fast attempts or were rejected get a
  // fresh start (see resetOutboxForManualRetry), then the sync workers run now
  // instead of on the next 30s tick.
  const retryAll = async () => {
    setRetrying(true);
    try {
      await resetOutboxForManualRetry().catch(() => {});
      // drainOutbox runs the same phase order as OperatorDashboard (shifts ->
      // bars -> reports/pedidos/samples) under a shared module-level in-flight
      // lock, so tapping "Reintentar" while a background drain is already
      // running awaits that run instead of starting a second concurrent drain
      // over the same outbox.
      const result = await drainOutbox();
      if (result.synced > 0) {
        notifyOperatorDataChanged();
      }
    } finally {
      await loadQueue();
      setRetrying(false);
    }
  };

  const refusedCount = items.filter((i) => i.state === 'quarantined').length;
  const waitingCount = items.length - refusedCount;

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${day}/${month} ${hours}:${minutes}`;
    } catch {
      return '';
    }
  };

  if (!visible) {
    return null;
  }

  // Rendered as a plain View before, nested wherever the caller happens to
  // place it (inside the header bar's row layout in practice) — it needs
  // RN's actual Modal to portal above the whole screen regardless of where
  // it's declared, otherwise it's laid out squeezed into its parent's row
  // instead of centered over the full device screen.
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.modalOverlay]}>
        <View style={[styles.modalContent, { backgroundColor: theme.colors.surface }]}>
          <View style={styles.modalHeader}>
          <Text style={[styles.modalTitle, { color: theme.colors.text }]}>
            Sincronización
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={[styles.closeButton, { color: theme.colors.textSecondary }]}>Cerrar</Text>
          </TouchableOpacity>
        </View>

        {items.length > 0 && (
          <Text style={[styles.explainText, { color: theme.colors.textSecondary }]}>
            {refusedCount > 0
              ? 'Todo está guardado en este dispositivo. Lo pendiente se sube solo cuando hay conexión. Lo que el servidor rechazó pasa a revisión del administrador.'
              : 'Estos registros están guardados en este dispositivo y se suben solos cuando hay conexión.'}
          </Text>
        )}

        {loading ? (
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
            Cargando…
          </Text>
        ) : items.length === 0 ? (
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
            Todo sincronizado
          </Text>
        ) : (
          // A ScrollView: a plain View with maxHeight clipped every row past the eighth,
          // and refused rows are the ones the operator most needs to reach (AUTH-13).
          <ScrollView style={styles.queueList} nestedScrollEnabled keyboardDismissMode="on-drag">
            {items.map((item) => (
              <View
                key={item.id}
                style={[styles.queueItem, { borderBottomColor: theme.colors.border }]}
              >
                <View style={styles.queueItemHeader}>
                  <Text style={[styles.entityText, { color: theme.colors.text }]}>
                    {rejectedWorkLabel(item.entity)}
                  </Text>
                  <Text style={[styles.queueDate, { color: theme.colors.textMuted }]}>
                    {formatDate(item.created_at)}
                  </Text>
                </View>
                <Text style={[styles.queueDate, { color: theme.colors.textMuted }]}>
                  {`Cargado por ${item.author_name || 'otro operador'}`}
                </Text>
                <Text
                  style={[
                    styles.errorDetail,
                    { color: item.state === 'quarantined' ? theme.colors.error : theme.colors.textSecondary },
                  ]}
                  numberOfLines={4}
                >
                  {itemStatus(item)}
                </Text>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={styles.modalFooter}>
          <Text style={[styles.statsText, { color: theme.colors.textSecondary }]}>
            {waitingCount} pendiente{waitingCount === 1 ? '' : 's'}{refusedCount > 0 ? ` · ${refusedCount} rechazado${refusedCount === 1 ? '' : 's'}` : ''}
          </Text>
          <TouchableOpacity
            style={[styles.retryButton, { backgroundColor: theme.colors.primary }, retrying && { opacity: 0.6 }]}
            onPress={retryAll}
            disabled={retrying || items.length === 0}
          >
            <Text style={styles.retryButtonText}>{retrying ? 'Reintentando…' : 'Reintentar'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-end',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.lg,
  },
  badgeLabel: {
    color: COLORS.text,
    fontSize: TYPE.micro,
    fontWeight: 'bold',
  },
  count: {
    color: COLORS.text,
    fontSize: TYPE.caption,
    fontWeight: 'bold',
    marginLeft: SPACING.xs,
  },
  explainText: {
    fontSize: TYPE.caption,
    lineHeight: 17,
    marginBottom: SPACING.md,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    maxHeight: '80%',
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  modalTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
  },
  closeButton: { minHeight: 48, justifyContent: 'center',
    fontSize: TYPE.h2,
    padding: SPACING.xs,
  },
  loadingText: {
    textAlign: 'center',
    padding: SPACING.xl,
  },
  emptyText: {
    textAlign: 'center',
    padding: SPACING.huge,
    fontSize: TYPE.bodyLg,
  },
  queueList: {
    maxHeight: 400,
  },
  queueItem: {
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
  },
  queueItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  entityText: {
    fontSize: TYPE.label,
    fontWeight: '500',
  },
  queueDate: {
    fontSize: TYPE.micro,
  },
  errorDetail: {
    fontSize: TYPE.caption,
    lineHeight: 17,
    marginTop: SPACING.xs,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.lg,
    paddingTop: SPACING.lg,
    borderTopWidth: 1,
    borderTopColor: COLORS.input,
  },
  statsText: {
    fontSize: TYPE.label,
  },
  retryButton: { minHeight: 48, justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
  },
  retryButtonText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
});

export { SyncQueueModal };
