import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { query } from '../../db/db';
import { materialsApi } from '../../api/supabase-materials';
import { projectsApi } from '../../api/supabase-projects';
import { projectMembershipSql } from '../../api/projectCache';
import { isActiveStatus } from '../../domain/projectStatus';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { mirrorProjectMaterials } from '../../db/repositories/projectMaterials';
import { mirrorProjects } from '../../db/repositories/projects';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { showSheet } from '../shared/Sheet';
import { formatDisplayDate } from '../../utils/dateFormat';
import { formatQuantity } from '../../utils/quantity';

interface ProjectMaterial {
  id: string;
  project_id: string;
  material_name: string;
  initial_quantity: number;
  current_quantity: number;
  unit: string;
  assigned_date: string;
  notes?: string;
  status: 'good' | 'low' | 'critical';
}

interface UsageRecord {
  id: string;
  material_name: string;
  quantity_used: number;
  unit: string;
  date: string;
  notes?: string;
}

const MaterialesTab = () => {
  const [projectMaterials, setProjectMaterials] = useState<ProjectMaterial[]>([]);
  const [recentUsage, setRecentUsage] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [projectStatus, setProjectStatus] = useState<string | null>(null);

  const cacheServerProjects = async () => {
    const token = await AsyncStorage.getItem('authToken');
    if (!token) {
      return;
    }

    const serverProjects = await projectsApi.getAll();
    await mirrorProjects(serverProjects);
  };

  const initializeLoad = async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }
    setLastError(null);
    try {
      // The phone's own materials go on screen as soon as they are read; the
      // server refresh after them can take 30 seconds or more with no internet
      // (code read O7).
      await loadProjectMaterials(() => setLoading(false));
      await loadRecentUsage();
    } catch (error) {
      console.error('[PHC] Error in materials initial load:', error);
      setLastError('Error al cargar materiales del proyecto');
    } finally {
      setLoading(false);
    }
  };

  useOperatorDataRefresh(() => initializeLoad(false));

  const handleRefresh = async () => {
    setRefreshing(true);
    setLastError(null);
    try {
      await loadProjectMaterials();
      await loadRecentUsage();
    } catch (error) {
      console.error('[PHC] Error refreshing materials:', error);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Show the operator's well and its materials from the phone alone. Returns the
   * well, or null when the phone has none: then a first login keeps waiting on
   * the server, and only the final pass says "no tenés un proyecto asignado".
   */
  const showLocalMaterials = useCallback(async (
    operatorId: string,
    final: boolean,
  ): Promise<{ id: string; name: string } | null> => {
    // Get operator's project first. An operator can be assigned_operator_id
    // on more than one project at once (e.g. their current active well
    // plus an older completed one where they're still on record as
    // closing operator) — prefer the active project, then the most
    // recently touched, instead of an unordered LIMIT 1 (which previously
    // returned whichever row SQLite happened to return first).
    const projectRows = await query<{ id: string; name: string; status?: string; updated_at?: string }>(`
      SELECT id, name, status, updated_at FROM projects
      WHERE ${projectMembershipSql()}
      AND (deleted = 0 OR deleted IS NULL)
    `, [operatorId, operatorId]);
    const projectResult = [...projectRows].sort((a, b) => {
      const aActive = isActiveStatus(a.status) ? 1 : 0;
      const bActive = isActiveStatus(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    });

    if (!projectResult || projectResult.length === 0) {
      if (final) {
        setProjectMaterials([]);
        setProjectName('');
        setProjectStatus(null);
        setLastError('No tenés un proyecto asignado. Hablá con el administrador.');
      }
      return null;
    }

    const project = projectResult[0];
    setProjectName(project.name);
    setProjectStatus(project.status ?? null);

    // Get materials assigned to this project
    const materialsResult = await query<ProjectMaterial>(`
      SELECT * FROM project_materials
      WHERE project_id = ? AND COALESCE(active, 1) = 1
      ORDER BY material_name ASC
    `, [project.id]);

    // Calculate status for each material
    const materialsWithStatus = (materialsResult || []).map(material => ({
      ...material,
      status: getStockStatus(material.current_quantity, material.initial_quantity)
    }));

    setProjectMaterials(materialsWithStatus);
    setLastError(null);
    return project;
  }, []);

  const loadProjectMaterials = useCallback(async (onLocalShown?: () => void) => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {

        // Load operator ID from session
        const operatorId = await AsyncStorage.getItem('operatorId');
        if (!operatorId) {
          setProjectMaterials([]);
          setProjectName('');
          setLastError('No hay operador autenticado. Volvé a iniciar sesión.');
          return;
        }

        if (await showLocalMaterials(operatorId, false)) {
          onLocalShown?.();
        }

        await cacheServerProjects().catch((error) => {
          console.warn('[PHC] Could not refresh operator projects from server:', error);
        });

        // The server's well can differ from the phone's, so pick it again.
        const project = await showLocalMaterials(operatorId, true);
        if (!project) {
          return;
        }

        const token = await AsyncStorage.getItem('authToken');
        if (token) {
          try {
            const serverMaterials = await materialsApi.getProjectMaterials(Number(project.id));
            // This used to be a hand-written 10-column INSERT OR REPLACE that
            // omitted layer, catalog_variant_id and active. SQLite's REPLACE
            // deletes the row and re-inserts it, so those three fell back to
            // their defaults — 'presupuesto' became 'extras', a deactivated
            // material came back to life, and catalog_variant_id was nulled,
            // which is the exact shape that made shift handovers fail. Merely
            // opening this tab corrupted the cache. One shared mirror now.
            await mirrorProjectMaterials(serverMaterials.data);
          } catch (error) {
            console.warn('[PHC] Could not refresh assigned materials from server:', error);
          }
        }

        await showLocalMaterials(operatorId, true);
        return;
      } catch (error: any) {
        console.error(`[PHC] Error loading project materials (attempt ${attempt}):`, error);

        const errorMessage = error instanceof Error ? error.message : String(error);

        if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
          continue;
        }

        setLastError(`Error al cargar materiales: ${errorMessage}`);
        setProjectMaterials([]);
        throw new Error(`Failed to load project materials after ${MAX_RETRIES} attempts: ${errorMessage}`);
      }
    }
  }, [showLocalMaterials]);

  const loadRecentUsage = async () => {
    try {
      const operatorId = await AsyncStorage.getItem('operatorId');
      if (!operatorId) {
        setRecentUsage([]);
        return;
      }

      // Same "prefer the active project" rule as loadProjectMaterials above —
      // keep this in sync with that logic if an operator can have more than
      // one assigned project.
      const projectRowsForUsage = await query<{ id: string; status?: string; updated_at?: string }>(`
        SELECT id, status, updated_at FROM projects
        WHERE ${projectMembershipSql()}
        AND (deleted = 0 OR deleted IS NULL)
      `, [operatorId, operatorId]);
      const projectResult = [...projectRowsForUsage].sort((a, b) => {
        const aActive = isActiveStatus(a.status) ? 1 : 0;
        const bActive = isActiveStatus(b.status) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      });

      const showLocalUsage = async () => {
        // Same well as the server's list, so the two don't swap wells on screen.
        const projectId = projectResult[0]?.id;
        const usageResult = await query<UsageRecord>(`
          SELECT material_name, quantity_used, unit, date, notes
          FROM material_consumption
          WHERE ${projectId ? 'project_id = ?' : 'operator_id = ?'}
          ORDER BY date DESC, created_at DESC
          LIMIT 10
        `, [projectId ?? operatorId]);
        setRecentUsage(usageResult || []);
      };
      // The phone's records first; the server's replace them when it answers (code read O7).
      await showLocalUsage();

      const token = await AsyncStorage.getItem('authToken');
      if (token && projectResult[0]?.id) {
        try {
          const serverUsage = await materialsApi.getProjectConsumption(Number(projectResult[0].id));
          setRecentUsage((serverUsage.data || []).map((item: any) => ({
            id: String(item.id),
            material_name: item.material_name,
            quantity_used: item.quantity_used,
            unit: item.unit,
            date: item.date || item.created_at,
            notes: item.notes,
          })));
          return;
        } catch (error) {
          console.warn('[PHC] Could not refresh recent material usage from server:', error);
        }
      }
    } catch (error) {
      console.error('[PHC] Error loading recent usage:', error);
    }
  };

  /**
   * Two decimals with a decimal comma, and no float noise: 12.6 - 0.3 reads "12,3",
   * not 12.299999999999999 (OPB-16).
   */
  const formatStock = (value: number | null | undefined): string => (
    value == null || !Number.isFinite(value) ? '—' : formatQuantity(Math.round(value * 100) / 100)
  );

  const getStockStatus = (current: number, initial: number): 'good' | 'low' | 'critical' => {
    if (current <= 0) return 'critical';
    // Nothing assigned or received means there is no stock to call "good" (OPB-16).
    if (!(initial > 0)) return 'critical';
    const percentage = (current / initial) * 100;
    if (percentage <= 25) return 'critical';
    if (percentage <= 50) return 'low';
    return 'good';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'good':
        return COLORS.success;
      case 'low':
        return COLORS.warning;
      case 'critical':
        return COLORS.danger;
      default:
        return COLORS.neutral;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'good':
        return 'Buen Stock';
      case 'low':
        return 'Stock Bajo';
      case 'critical':
        return 'Stock Crítico';
      default:
        return 'Desconocido';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'good':
        return '';
      case 'low':
        return '';
      case 'critical':
        return '';
      default:
        return '';
    }
  };

  const handleRegisterUsage = (material: ProjectMaterial) => {
    showSheet(
      'Uso por turno',
      `El uso de ${material.material_name} se informa junto con los demás materiales al finalizar el turno.`,
    );
  };

  // A stored date is a calendar day. `new Date('2026-11-08')` is UTC midnight, which
  // in Paraguay is the evening before, so every date showed a day early (code read O9).
  const formatDate = (dateString: string) => formatDisplayDate(dateString);

  // Loading state
  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando materiales del proyecto...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Materiales del Proyecto</Text>
        {projectName && (
          <Text style={styles.projectName}>{projectName}</Text>
        )}
        <Text style={styles.subtitle}>Consulta el saldo; el uso se informa al finalizar el turno.</Text>
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

        {!isActiveStatus(projectStatus) && (
          <View style={styles.completedNotice}>
            <Text style={styles.completedNoticeText}>
              Este pozo ya fue completado. El registro de uso de material ya no está disponible.
            </Text>
          </View>
        )}

        {isActiveStatus(projectStatus) && (
          <View style={styles.completedNotice}>
            <Text style={styles.completedNoticeText}>
              Esta pantalla es de consulta. Para registrar cantidades exactas, aproximadas o cero,
              abrí Turnos y completá el informe al finalizar.
            </Text>
          </View>
        )}

        {/* Materials Stats */}
        <View style={styles.statsContainer}>
          <View style={[styles.statCard, { borderLeftColor: COLORS.accent }]}>
            <Text style={styles.statNumber}>{projectMaterials.length}</Text>
            <Text style={styles.statLabel}>Materiales</Text>
          </View>
          {(() => {
            const low = projectMaterials.filter(m => m.status === 'low').length;
            const crit = projectMaterials.filter(m => m.status === 'critical').length;
            return (
              <>
                <View style={[styles.statCard, { borderLeftColor: low > 0 ? COLORS.warning : COLORS.border }]}>
                  <Text style={[styles.statNumber, low > 0 && { color: COLORS.warningText }]}>{low}</Text>
                  <Text style={styles.statLabel}>Stock Bajo</Text>
                </View>
                <View style={[styles.statCard, { borderLeftColor: crit > 0 ? COLORS.danger : COLORS.border }]}>
                  <Text style={[styles.statNumber, crit > 0 && { color: COLORS.errorText }]}>{crit}</Text>
                  <Text style={styles.statLabel}>Críticos</Text>
                </View>
              </>
            );
          })()}
        </View>

        {/* Materials List */}
        {projectMaterials.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateIcon}></Text>
            <Text style={styles.emptyStateTitle}>Sin Materiales Asignados</Text>
            <Text style={styles.emptyStateText}>
              {lastError ?
                'Error al cargar materiales. Revisá la conexión e intentá de nuevo.' :
                'No hay materiales asignados a tu proyecto. Hablá con el administrador para que asigne materiales.'
              }
            </Text>
            <TouchableOpacity style={styles.refreshButton} onPress={handleRefresh}>
              <Text style={styles.refreshButtonText}>Verificar Materiales</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {projectMaterials.map((material) => (
              <View key={material.id} style={styles.materialCard}>
                <View style={styles.materialHeader}>
                  <View style={styles.materialTitle}>
                    <Text style={styles.materialName}>{material.material_name}</Text>
                    <View style={[styles.statusBadge, { backgroundColor: getStatusColor(material.status) }]}>
                      <Text style={styles.statusText}>
                        {getStatusIcon(material.status)} {getStatusText(material.status)}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={styles.materialContent}>
                  <View style={styles.stockInfo}>
                    <View style={styles.stockRow}>
                      <Text style={styles.stockLabel}>Disponible:</Text>
                      <Text style={[styles.stockValue, { color: getStatusColor(material.status) }]}>
                        {material.current_quantity < 0
                          ? 'Consumo mayor que lo asignado'
                          : `${formatStock(material.current_quantity)} ${material.unit}`}
                      </Text>
                    </View>
                    <View style={styles.stockRow}>
                      <Text style={styles.stockLabel}>Asignado + recibido:</Text>
                      <Text style={styles.stockValue}>
                        {formatStock(material.initial_quantity)} {material.unit}
                      </Text>
                    </View>
                    <View style={styles.stockRow}>
                      <Text style={styles.stockLabel}>Consumido:</Text>
                      <Text style={styles.stockValue}>
                        {formatStock(material.initial_quantity - material.current_quantity)} {material.unit}
                      </Text>
                    </View>
                    <View style={styles.stockRow}>
                      <Text style={styles.stockLabel}>Asignado:</Text>
                      <Text style={styles.stockValue}>
                        {formatDate(material.assigned_date)}
                      </Text>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={styles.useButton}
                    onPress={() => handleRegisterUsage(material)}
                  >
                    <Text style={styles.useButtonText}>Informar en Turnos</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}

            {/* Recent Usage Section */}
            {recentUsage.length > 0 && (
              <View style={styles.recentUsageSection}>
                <Text style={styles.sectionTitle}>Uso Reciente</Text>
                {recentUsage.slice(0, 5).map((usage, index) => (
                  <View key={index} style={styles.usageRecord}>
                    <View style={styles.usageHeader}>
                      <Text style={styles.usageMaterial}>{usage.material_name}</Text>
                      <Text style={styles.usageDate}>{formatDate(usage.date)}</Text>
                    </View>
                    <Text style={styles.usageAmount}>
                      Usado: {usage.quantity_used} {usage.unit}
                    </Text>
                    {usage.notes && (
                      <Text style={styles.usageNotes}>{usage.notes}</Text>
                    )}
                  </View>
                ))}
              </View>
            )}
          </>
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
  projectName: {
    fontSize: TYPE.bodyLg,
    color: COLORS.primaryText,
    fontWeight: '600',
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
  },
  content: {
    flex: 1,
    paddingHorizontal: SPACING.xl,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.xxl,
  },
  statCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.md,
    flex: 1,
    marginHorizontal: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.border,
  },
  statNumber: {
    fontSize: TYPE.h1,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  statLabel: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  materialCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  materialHeader: {
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  materialTitle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  materialName: {
    fontSize: TYPE.bodyLg,
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
  materialContent: {
    padding: SPACING.lg,
  },
  stockInfo: {
    marginBottom: SPACING.lg,
  },
  stockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  stockLabel: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
  },
  stockValue: {
    fontSize: TYPE.label,
    color: COLORS.text,
    fontWeight: '600',
  },
  useButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    alignItems: 'center',
  },
  useButtonDisabled: {
    backgroundColor: COLORS.neutral,
  },
  useButtonText: {
    color: COLORS.text,
    fontWeight: 'bold',
    fontSize: TYPE.label,
  },
  recentUsageSection: {
    marginTop: SPACING.sm,
    marginBottom: SPACING.lg,
  },
  sectionTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.md,
  },
  usageRecord: {
    backgroundColor: COLORS.input,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.sm,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
  },
  usageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  usageMaterial: {
    fontSize: TYPE.label,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  usageDate: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
  },
  usageAmount: {
    fontSize: TYPE.caption,
    color: COLORS.warningText,
    marginBottom: SPACING.xs,
  },
  usageNotes: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
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
  errorBanner: {
    backgroundColor: COLORS.danger,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  completedNotice: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    padding: SPACING.md,
    marginBottom: SPACING.lg,
  },
  completedNoticeText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.caption,
    lineHeight: 18,
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
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  modalContent: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.xxl,
  },
  modalTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.lg,
    textAlign: 'center',
  },
  modalMaterialInfo: {
    backgroundColor: COLORS.input,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.xl,
  },
  modalMaterialName: {
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  modalAvailableStock: {
    fontSize: TYPE.label,
    color: COLORS.primaryText,
    fontWeight: '600',
  },
  modalForm: {
    marginBottom: SPACING.xxl,
  },
  modalLabel: {
    fontSize: TYPE.label,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.sm,
    marginTop: SPACING.md,
  },
  modalInput: {
    backgroundColor: COLORS.background,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    fontSize: TYPE.bodyLg,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalInputMultiline: {
    height: 80,
    textAlignVertical: 'top',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: { minHeight: 48, justifyContent: 'center',
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    marginHorizontal: SPACING.sm,
  },
  modalCancelButton: {
    backgroundColor: COLORS.neutral,
  },
  modalSaveButton: {
    backgroundColor: COLORS.success,
  },
  modalButtonDisabled: {
    backgroundColor: COLORS.neutral,
  },
  modalCancelText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
  modalSaveText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
});

export default MaterialesTab;
