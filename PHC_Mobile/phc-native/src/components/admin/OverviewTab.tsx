import { useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { query } from '../../db/db';
import { drillingBarsApi } from '../../api/supabase-drilling-bars';
import { materialsApi } from '../../api/supabase-materials';
import { pedidosApi } from '../../api/supabase-pedidos';
import { completionApi } from '../../api/supabase-completion';
import { adminStatsApi } from '../../api/adminStats';
import { statusToneFor } from '../../domain/projectStatus';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { adminSharedStyles } from './adminSharedStyles';

// Overview Tab Component
const OverviewTab = () => {
  const [stats, setStats] = useState({
    activeProjects: 0,
    totalOperators: 0,
    pendingRequests: 0,
    projectsWithoutMaterials: 0,
    unsignedCierres: 0,
  });
  const [statsFromServer, setStatsFromServer] = useState(false);
  const [recentActivity, setRecentActivity] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setIsLoading(true);
    setLastError(null);
    try {
      await Promise.all([loadStats(), loadRecentActivity()]);
    } catch (error) {
      console.error('[PHC] Error loading dashboard data:', error);
      setLastError('Error al cargar los datos del panel');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
  };

  // Pass 4: server-derived truth. The old version counted from the local
  // SQLite mirror, so a fresh install / second admin device showed 0 until
  // tabs were visited. We now read from Supabase (adminStatsApi); the local
  // mirror is only a labelled fallback, never presented as the real number.
  const loadStats = async () => {
    const token = await AsyncStorage.getItem('authToken');
    if (token) {
      try {
        const s = await adminStatsApi.getStats();
        setStats({
          activeProjects: s.activeProjects,
          totalOperators: s.activeOperators,
          pendingRequests: s.pendingPedidos,
          projectsWithoutMaterials: s.projectsWithoutMaterials,
          unsignedCierres: s.unsignedCierres,
        });
        setStatsFromServer(true);
        return;
      } catch (error) {
        console.warn('[PHC] Server stats failed, falling back to local cache:', error);
      }
    }

    // Fallback: local mirror (may be stale/empty) — flagged in the UI.
    setStatsFromServer(false);
    try {
      const projectsResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM projects WHERE deleted = 0 AND status IN ('active', 'En Progreso')`,
      );
      const requestsResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM supply_requests WHERE status = 'Pendiente'`,
      );
      const noMaterialsResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM projects p
         WHERE p.deleted = 0 AND p.status IN ('active', 'En Progreso')
         AND NOT EXISTS (
           SELECT 1 FROM project_materials pm
           WHERE pm.project_id = p.id AND COALESCE(pm.active, 1) = 1
         )`,
      );
      setStats((prev) => ({
        ...prev,
        activeProjects: projectsResult[0]?.count || 0,
        pendingRequests: requestsResult[0]?.count || 0,
        projectsWithoutMaterials: noMaterialsResult[0]?.count || 0,
      }));
    } catch (error) {
      console.warn('[PHC] Local stats fallback failed:', error);
    }
  };

  // Pass 4: unified activity feed from multiple server sources (drilling
  // progress, pedidos, completion reports) instead of only drilling bars.
  // Best-effort per source; falls back to the local progress mirror offline.
  const loadRecentActivity = async () => {
    const token = await AsyncStorage.getItem('authToken');
    if (token) {
      try {
        const [barsRes, pedidosRes, cierresRes, consumoRes] = await Promise.all([
          drillingBarsApi.getAll().catch(() => ({ data: [] })),
          pedidosApi.getRecent(12).catch(() => ({ data: [] })),
          completionApi.getAll(undefined, { page: 1, pageSize: 12 }).catch(() => ({ data: [] })),
          materialsApi.getRecentConsumption().catch(() => ({ data: [] })),
        ]);

        const feed: any[] = [];
        for (const b of (barsRes.data || []).slice(0, 12) as any[]) {
          feed.push({
            kind: 'progress',
            title: `Progreso · ${b.projects?.name || 'Pozo'}`,
            subtitle: `Profundidad ${b.depth_end ?? '-'} m`,
            created_at: b.created_at,
          });
        }
        for (const p of (pedidosRes.data || []).slice(0, 12) as any[]) {
          feed.push({
            kind: 'pedido',
            title: `Pedido · ${p.material || 'material'}`,
            subtitle: `${p.quantity ?? ''} · ${p.projects?.name || 'Sin proyecto'} · ${p.status || 'Pendiente'}`,
            status: p.status,
            created_at: p.created_at,
          });
        }
        for (const c of (consumoRes.data || []) as any[]) {
          feed.push({
            kind: 'consumo',
            title: `Consumo · ${c.material_name || 'material'}`,
            subtitle: `${c.quantity_used ?? ''} ${c.unit || ''} · ${c.projects?.name || 'Pozo'}`,
            created_at: c.created_at,
          });
        }
        for (const c of (cierresRes.data || []).slice(0, 12)) {
          feed.push({
            kind: 'cierre',
            title: `Cierre · ${c.projects?.name || 'Pozo'}`,
            // A returned Ficha is waiting for the operator, not for the admin's signature.
            subtitle: c.admin_signature
              ? 'Firmado'
              : c.status === 'returned' ? 'Devuelta al operador' : 'Pendiente de firma',
            status: c.admin_signature ? 'approved' : c.status === 'returned' ? 'returned' : 'submitted',
            created_at: c.created_at,
          });
        }

        feed.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
        setRecentActivity(feed.slice(0, 15));
        return;
      } catch (error) {
        console.warn('[PHC] Server activity feed failed, using local:', error);
      }
    }

    try {
      const result = await query<any>(`
        SELECT 'progress' as kind, p.name as project_name, pl.depth_end, pl.created_at
        FROM progress_logs_dashboard pl
        LEFT JOIN projects p ON pl.project_id = p.id
        ORDER BY pl.created_at DESC LIMIT 12
      `);
      setRecentActivity(
        (result || []).map((r: any) => ({
          kind: 'progress',
          title: `Progreso · ${r.project_name || 'Pozo'}`,
          subtitle: `Profundidad ${r.depth_end ?? '-'} m`,
          created_at: r.created_at,
        })),
      );
    } catch (error) {
      console.warn('[PHC] Local activity fallback failed:', error);
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    } catch {
      return 'Fecha inválida';
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando panel de control...</Text>
      </View>
    );
  }

  // Error state
  if (lastError) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorIcon}></Text>
        <Text style={styles.errorText}>{lastError}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={loadDashboardData}
        >
          <Text style={styles.retryButtonText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          colors={[COLORS.primary]}
          tintColor={COLORS.primary}
        />
      }
    >
      <View style={styles.content}>
        <Text style={styles.title}>Panel de Control</Text>
        <Text style={styles.subtitle}>Resumen general del sistema</Text>

        {/* Stats Cards */}
        <View style={styles.statsGrid}>
          <View style={[styles.statCard, { borderLeftColor: COLORS.accent }]}>
            <Text style={styles.statNumber}>{stats.activeProjects}</Text>
            {/* Counts planning + active + closure_submitted (see adminStats.ts), so
                "Activos" overstated it — 26 shown while only 20 were being drilled. */}
            <Text style={styles.statLabel}>Proyectos en curso</Text>
          </View>

          <View style={[styles.statCard, { borderLeftColor: COLORS.neutral }]}>
            <Text style={styles.statNumber}>{stats.totalOperators}</Text>
            <Text style={styles.statLabel}>Operadores</Text>
          </View>

          <View style={[styles.statCard, { borderLeftColor: stats.pendingRequests > 0 ? COLORS.warning : COLORS.border }]}>
            <Text style={[styles.statNumber, stats.pendingRequests > 0 && { color: COLORS.warningText }]}>{stats.pendingRequests}</Text>
            <Text style={styles.statLabel}>Pedidos Pendientes</Text>
          </View>

          <View style={[styles.statCard, { borderLeftColor: stats.projectsWithoutMaterials > 0 ? COLORS.warning : COLORS.border }]}>
            <Text style={[styles.statNumber, stats.projectsWithoutMaterials > 0 && { color: COLORS.warningText }]}>{stats.projectsWithoutMaterials}</Text>
            <Text style={styles.statLabel}>Proyectos Sin Materiales</Text>
          </View>

          <View style={[styles.statCard, { borderLeftColor: stats.unsignedCierres > 0 ? COLORS.warning : COLORS.border }]}>
            <Text style={[styles.statNumber, stats.unsignedCierres > 0 && { color: COLORS.warningText }]}>{stats.unsignedCierres}</Text>
            <Text style={styles.statLabel}>Cierres por firmar</Text>
          </View>
        </View>

        {!statsFromServer && (
          <View style={styles.cacheNote}>
            <Text style={styles.cacheNoteText}>
              Mostrando datos guardados en este dispositivo (sin conexión). Los números pueden estar desactualizados.
            </Text>
          </View>
        )}

        {/* Recent Activity */}
        <View style={styles.activitySection}>
          <Text style={styles.sectionTitle}>Actividad Reciente</Text>
          {recentActivity.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No hay actividad reciente</Text>
            </View>
          ) : (
            recentActivity.map((activity, index) => (
              <View key={index} style={styles.activityItem}>
                <View style={[styles.activityKindDot, { backgroundColor: statusToneFor(activity.status) === 'success' ? COLORS.success : activity.kind === 'pedido' ? COLORS.warning : COLORS.accent }]} />
                <View style={styles.activityContent}>
                  <Text style={styles.activityTitle}>{activity.title}</Text>
                  {!!activity.subtitle && <Text style={styles.activityDetails}>{activity.subtitle}</Text>}
                  <Text style={styles.activityTime}>{formatDate(activity.created_at)}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  ...adminSharedStyles,
  activityContent: {
    flex: 1,
  },
  activityDetails: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  activityItem: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  activityKindDot: {
    width: 8,
    height: 8,
    borderRadius: RADIUS.sm,
    marginTop: SPACING.sm,
    marginRight: SPACING.md,
  },
  activitySection: {
    marginBottom: SPACING.xl,
  },
  activityTime: {
    fontSize: TYPE.caption,
    color: COLORS.primaryText,
  },
  activityTitle: {
    fontSize: TYPE.label,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  cacheNote: {
    backgroundColor: 'rgba(208,138,30,0.14)',
    borderWidth: 1,
    borderColor: COLORS.warning,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
  },
  cacheNoteText: { color: COLORS.text, fontSize: TYPE.caption, lineHeight: 17 },
  sectionTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.lg,
  },
  statCard: {
    width: '48%',
    paddingVertical: SPACING.xl,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.border,
    marginBottom: SPACING.md,
  },
  statLabel: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
    fontWeight: '500',
  },
  statNumber: {
    fontSize: TYPE.display,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: SPACING.xxxl,
  },
  subtitle: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xxl,
  },
});

export default OverviewTab;
