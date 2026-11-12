import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { execute, query } from '../../db/db';
import { projectsApi } from '../../api/supabase-projects';
import { isActiveStatus, normalizeStatus, statusLabel, statusToneFor } from '../../domain/projectStatus';
import { closedWellNotice } from './closedWellNotice';
import { readQueueStatus, type QueueStatus } from '../../sync/queueStatus';
import { COLORS, RADIUS, SPACING, TYPE, toneColor } from '../../theme/phcTheme';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { cacheServerBars } from '../../sync/serverBarsCache';
import { projectMembershipSql } from '../../api/projectCache';
import { mirrorProjects } from '../../db/repositories/projects';
import { formatDisplayDate } from '../../utils/dateFormat';
import type { OperatorTabNavigationProp, OperatorTabParamList } from '../../navigation/types';

interface Project {
  id: string;
  name: string;
  location: string;
  assigned_operator_id: string;
  progress: number;
  status: string;
  created_at: string;
  updated_at: string;
  current_depth?: number;
  target_depth?: number;
  last_activity?: string;
}

const PozosTab = () => {
  const navigation = useNavigation<OperatorTabNavigationProp<'Pozos'>>();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const [syncCounts, setSyncCounts] = useState<QueueStatus>({ waiting: 0, refused: 0 });

  // Pass 3: surface local-but-not-uploaded work so the operator knows their
  // data is saved on the phone and whether anything failed to sync.
  //
  // W-11(b) splits the old two-way count into three. "Fallidos" and "rechazados"
  // demand different actions from the operator: the first may still succeed once
  // there is signal, the second never will and needs the office to look at it.
  // Reporting them as one number told the operator to keep waiting on work the
  // server had already refused for good.
  // OPA-18: the same count as the header badge (readQueueStatus), so the two never disagree.
  const loadSyncCounts = useCallback(async () => {
    try {
      setSyncCounts(await readQueueStatus());
    } catch {
      // sync_outbox may not exist on first run; ignore
    }
  }, []);

  const goTo = (tab: keyof OperatorTabParamList) => navigation.navigate(tab);

  const cacheServerProjects = async () => {
    const token = await AsyncStorage.getItem('authToken');
    if (!token) {
      return;
    }

    const serverProjects = await projectsApi.getAll();
    const currentTime = new Date().toISOString();
    await mirrorProjects(serverProjects, currentTime);

    // Reconcile removals, not just additions. This cache used to be
    // additive-only: when an admin reassigns a well to another operator the
    // server stops returning it, but the old row stayed on the device forever.
    // The previous operator kept seeing the well — with a "Sincronizado" badge —
    // long after RLS had revoked their access, and any project-scoped write they
    // attempted from that stale screen was rejected and then silently abandoned
    // by the outbox.
    //
    // Soft delete only: `deleted = 1` hides the project from the queries that
    // respect the flag without destroying anything the device may still hold.
    // Reached only after projectsApi.getAll() resolved, so a failed fetch throws
    // before this line rather than blanking the cache.
    const serverIds = (serverProjects || []).map((project: any) => project.id);
    if (serverIds.length > 0) {
      await execute(
        `UPDATE projects SET deleted = 1, updated_at = ?
         WHERE (deleted = 0 OR deleted IS NULL)
           AND id NOT IN (${serverIds.map(() => '?').join(',')})`,
        [currentTime, ...serverIds],
      );
    } else {
      await execute(
        `UPDATE projects SET deleted = 1, updated_at = ?
         WHERE (deleted = 0 OR deleted IS NULL)`,
        [currentTime],
      );
    }
  };

  const initializeLoad = async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }
    setLastError(null);
    try {
      await loadSyncCounts();
      // The phone's own well goes on screen as soon as it is read; the server
      // refresh after it can take 30 seconds or more with no internet (code read O7).
      await loadAssignedProject(() => setLoading(false));
    } catch (error) {
      console.error('[PHC] Error in initial load:', error);
      setLastError('Error al cargar proyecto asignado');
    } finally {
      setLoading(false);
    }
  };

  useOperatorDataRefresh(() => initializeLoad(false));

  const handleRefresh = async () => {
    setRefreshing(true);
    setLastError(null);
    try {
      await loadAssignedProject();
      await loadSyncCounts();
    } catch (error) {
      console.error('[PHC] Error refreshing project:', error);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Show the operator's well from the phone alone. Returns false when the phone
   * has none, so a first login keeps waiting on the server instead of saying
   * "no tenés un proyecto asignado".
   */
  const showLocalProject = useCallback(async (operatorId: string, final: boolean): Promise<boolean> => {
    const rows = await query<Project>(`
      SELECT
        p.*,
        COALESCE(
          (SELECT MAX(dbe.depth_end) FROM drilling_bar_entries dbe WHERE dbe.project_id = p.id),
          (SELECT MAX(pl.depth_end) FROM progress_logs_dashboard pl WHERE pl.project_id = p.id),
          0
        ) as current_depth,
        COALESCE(
          (SELECT MAX(dbe.created_at) FROM drilling_bar_entries dbe WHERE dbe.project_id = p.id),
          (SELECT MAX(pl.created_at) FROM progress_logs_dashboard pl WHERE pl.project_id = p.id),
          p.created_at
        ) as last_activity
      FROM projects p
      WHERE ${projectMembershipSql('p')}
      AND (p.deleted = 0 OR p.deleted IS NULL)
    `, [operatorId, operatorId]);

    // An operator can be assigned_operator_id on more than one project at
    // once (e.g. their current active well plus an older completed one
    // where they're still on record as closing operator). Prefer the
    // active project; among ties, the most recently updated one — an
    // unordered LIMIT 1 previously returned whichever row SQLite happened
    // to return first, which in practice was the oldest/completed one.
    const result = [...rows].sort((a, b) => {
      const aActive = isActiveStatus(a.status) ? 1 : 0;
      const bActive = isActiveStatus(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    });

    if (result.length > 0) {
      setProject(result[0]);
      setMessage('');
      return true;
    }
    if (final) {
      setProject(null);
      setMessage('No tenés un proyecto asignado. Hablá con el administrador.');
    }
    return false;
  }, []);

const loadAssignedProject = useCallback(async (onLocalShown?: () => void) => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Load operator ID from session storage
        const operatorId = await AsyncStorage.getItem('operatorId');
        if (!operatorId) {
          setProject(null);
          setMessage('No hay operador autenticado. Volvé a iniciar sesión.');
          return;
        }

        if (await showLocalProject(operatorId, false)) {
          onLocalShown?.();
        }

        await cacheServerProjects().catch((error) => {
          console.warn('[PHC] Could not refresh assigned project from server:', error);
        });

        // "Profundidad Actual" is computed from the local drilling_bar_entries
        // mirror (MAX(depth_end)), which is empty on a fresh login until the
        // Progreso tab pulls the server bars — so this used to show 0m until the
        // operator opened Progreso. Pull the server bars for the operator's
        // assigned project(s) here too, using the same shared helper Progreso
        // uses, so the depth is correct immediately. cacheServerBars is
        // INSERT OR IGNORE, so it never clobbers locally-queued (unsynced) bars.
        const assignedProjects = await query<{ id: string }>(
          `SELECT id FROM projects
           WHERE ${projectMembershipSql()} AND (deleted = 0 OR deleted IS NULL)`,
          [operatorId, operatorId],
        );
        for (const assigned of assignedProjects) {
          await cacheServerBars(assigned.id).catch(() => {});
        }

        await showLocalProject(operatorId, true);

        setLastError(null);
        return;
      } catch (error: any) {
        console.error(`[PHC] Error loading assigned project (attempt ${attempt}):`, error);

        const errorMessage = error instanceof Error ? error.message : String(error);

        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
          continue;
        }

        setLastError(`Error al cargar proyecto asignado: ${errorMessage}`);
        setProject(null);
        setMessage('Error de conexión con la base de datos');
        throw new Error(`Failed to load assigned project after ${MAX_RETRIES} attempts: ${errorMessage}`);
      }
    }
  }, [showLocalProject]);

  // Loading state
  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando proyecto asignado...</Text>
      </View>
    );
  }

  // Error state
  if (lastError && !project) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorIcon}></Text>
        <Text style={styles.errorText}>{lastError}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => initializeLoad()}>
          <Text style={styles.retryButtonText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Mi Pozo</Text>
        <Text style={styles.subtitle}>Tu pozo asignado y las acciones del día</Text>
      </View>

      <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
        style={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[COLORS.primary]}
            tintColor={COLORS.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {lastError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{lastError}</Text>
            <TouchableOpacity onPress={handleRefresh}>
              <Text style={styles.errorBannerRetry}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}

        {project ? (
          <View style={styles.projectCard}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitle}>
                <Text style={styles.projectName}>{project.name}</Text>
                <View style={[styles.statusBadge, { backgroundColor: toneColor(statusToneFor(project.status)).bg }]}>
                  <Text style={[styles.statusText, { color: toneColor(statusToneFor(project.status)).fg }]}>{statusLabel(project.status)}</Text>
                </View>
              </View>
            </View>

            <View style={styles.cardContent}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Ubicación:</Text>
                <Text style={styles.infoValue}>{project.location}</Text>
              </View>

              {project.target_depth && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Profundidad Objetivo:</Text>
                  <Text style={styles.infoValue}>{project.target_depth}m</Text>
                </View>
              )}

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Profundidad Actual:</Text>
                <Text style={styles.infoValue}>{project.current_depth || 0}m</Text>
              </View>

              <View style={styles.progressContainer}>
                <View style={styles.progressHeader}>
                  <Text style={styles.progressLabel}>Progreso del Proyecto</Text>
                  <Text style={styles.progressPercentage}>{project.progress || 0}%</Text>
                </View>
                <View style={styles.progressBar}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.min(project.progress || 0, 100)}%` }
                    ]}
                  />
                </View>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Creado:</Text>
                <Text style={styles.infoValue}>{formatDisplayDate(project.created_at)}</Text>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Última Actividad:</Text>
                <Text style={styles.infoValue}>{formatDisplayDate(project.last_activity)}</Text>
              </View>

              {(syncCounts.waiting > 0 || syncCounts.refused > 0) && (
                <View style={[
                  styles.syncBanner,
                  syncCounts.refused > 0 && styles.syncBannerFailed,
                ]}>
                  <Text style={styles.syncBannerText}>
                    {syncCounts.refused > 0
                      ? `${syncCounts.refused} registro(s) rechazados por el servidor. Están guardados en este dispositivo, pero no se van a subir solos: avisá a la oficina.`
                      : `${syncCounts.waiting} registro(s) guardados en este dispositivo, pendientes de subir.`}
                  </Text>
                </View>
              )}

              {isActiveStatus(project.status) && normalizeStatus(project.status) !== 'closure_submitted' ? (
                <>
                  <Text style={styles.actionsTitle}>¿Qué querés registrar?</Text>
                  <View style={styles.actionsGrid}>
                    <TouchableOpacity style={styles.actionPrimary} onPress={() => goTo('Progreso')}>
                      <Text style={styles.actionPrimaryText}>Registrar barra</Text>
                    </TouchableOpacity>
                    <View style={styles.actionRow}>
                      <TouchableOpacity style={styles.actionSecondary} onPress={() => goTo('Materiales')}>
                        <Text style={styles.actionSecondaryText}>Registrar uso de material</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.actionSecondary} onPress={() => goTo('Pedidos')}>
                        <Text style={styles.actionSecondaryText}>Solicitar material</Text>
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity style={styles.actionCierre} onPress={() => goTo('Cierre')}>
                      <Text style={styles.actionSecondaryText}>Preparar cierre del pozo</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <View style={styles.completedNotice}>
                  <Text style={styles.completedNoticeTitle}>{closedWellNotice(project.status)?.title ?? 'Pozo cerrado'}</Text>
                  <Text style={styles.completedNoticeText}>
                    {closedWellNotice(project.status)?.text ?? 'Este pozo no recibe registros nuevos.'}
                  </Text>
                  {closedWellNotice(project.status)?.showCloseReport && (
                    <TouchableOpacity style={styles.actionCierre} onPress={() => goTo('Cierre')}>
                      <Text style={styles.actionSecondaryText}>Ver informe de cierre</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateIcon}></Text>
            <Text style={styles.emptyStateTitle}>Sin Proyecto Asignado</Text>
            <Text style={styles.emptyStateText}>
              {message || 'No tenés un proyecto asignado. Hablá con el administrador para que te asigne uno.'}
            </Text>
            <TouchableOpacity style={styles.refreshButton} onPress={handleRefresh}>
              <Text style={styles.refreshButtonText}>Verificar Asignación</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.spacer} />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    padding: SPACING.xl,
    paddingBottom: SPACING.md,
  },
  title: {
    fontSize: TYPE.h1,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
  },
  content: {
    flex: 1,
    paddingHorizontal: SPACING.xl,
  },
  projectCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: {
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cardTitle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  projectName: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    flex: 1,
    marginRight: SPACING.md,
  },
  statusBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.lg,
  },
  statusText: {
    color: COLORS.text,
    fontSize: TYPE.caption,
    fontWeight: 'bold',
  },
  cardContent: {
    padding: SPACING.lg,
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: SPACING.sm,
  },
  infoLabel: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    width: 140,
  },
  infoValue: {
    fontSize: TYPE.label,
    color: COLORS.text,
    flex: 1,
    fontWeight: '500',
  },
  progressContainer: {
    marginVertical: SPACING.lg,
    backgroundColor: COLORS.input,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  progressLabel: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  progressPercentage: {
    fontSize: TYPE.label,
    color: COLORS.primaryText,
    fontWeight: 'bold',
  },
  progressBar: {
    height: 8,
    backgroundColor: COLORS.neutral,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.success,
    borderRadius: RADIUS.sm,
  },
  syncBanner: {
    marginTop: SPACING.lg,
    backgroundColor: 'rgba(208,138,30,0.16)',
    borderWidth: 1,
    borderColor: COLORS.warning,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
  },
  syncBannerFailed: {
    backgroundColor: 'rgba(208,72,60,0.16)',
    borderColor: COLORS.danger,
  },
  syncBannerText: { color: COLORS.text, fontSize: TYPE.caption, lineHeight: 19 },
  actionsTitle: {
    color: COLORS.textSecondary,
    fontSize: TYPE.caption,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: SPACING.xl,
    marginBottom: SPACING.md,
    textTransform: 'uppercase',
  },
  actionsGrid: { gap: SPACING.md },
  actionPrimary: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.lg,
    alignItems: 'center',
  },
  actionPrimaryText: { color: COLORS.text, fontSize: TYPE.bodyLg, fontWeight: '700' },
  actionRow: { flexDirection: 'row', gap: SPACING.md },
  actionSecondary: {
    flex: 1,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCierre: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.lg,
    alignItems: 'center',
  },
  actionSecondaryText: { color: COLORS.text, fontSize: TYPE.label, fontWeight: '600', textAlign: 'center' },
  noteContainer: {
    marginTop: SPACING.lg,
    backgroundColor: COLORS.input,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primary,
  },
  noteTitle: {
    fontSize: TYPE.label,
    color: COLORS.text,
    fontWeight: 'bold',
    marginBottom: SPACING.sm,
  },
  noteText: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
    lineHeight: 18,
  },
  emptyState: {
    alignItems: 'center',
    padding: SPACING.huge,
    marginTop: SPACING.huge4,
  },
  emptyStateIcon: {
    fontSize: TYPE.metricLg,
    marginBottom: SPACING.lg,
  },
  emptyStateTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptyStateText: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: SPACING.xxl,
  },
  completedNotice: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    padding: SPACING.lg,
    marginTop: SPACING.sm,
  },
  completedNoticeTitle: {
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
  completedNoticeText: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    lineHeight: 19,
    marginBottom: SPACING.lg,
  },
  refreshButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
  },
  refreshButtonText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
  },
  spacer: {
    height: 40,
  },
  // Bulletproof UI styles
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.bodyLg,
    marginTop: SPACING.lg,
    textAlign: 'center',
  },
  errorIcon: {
    fontSize: TYPE.metric,
    marginBottom: SPACING.lg,
  },
  errorText: {
    color: COLORS.errorText,
    fontSize: TYPE.bodyLg,
    textAlign: 'center',
    marginBottom: SPACING.xxl,
    lineHeight: 24,
  },
  retryButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.xxl,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
  },
  retryButtonText: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
  },
  errorBanner: {
    backgroundColor: COLORS.danger,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorBannerText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    flex: 1,
  },
  errorBannerRetry: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
    textDecorationLine: 'underline',
  },
});

export default PozosTab;
