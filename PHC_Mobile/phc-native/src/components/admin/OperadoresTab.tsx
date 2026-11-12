import React, { useState, useEffect } from 'react';
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
import { execute, query, runInTransaction } from '../../db/db';
// Aliased: two functions in this file already declare a local `errorMessage`.
import { errorMessage as toErrorMessage, operatorErrorText } from '../../utils/errorMessage';
import { adminErrorText } from '../../domain/adminErrors';
import { operatorsApi } from '../../api/supabase-operators';
import { auth } from '../../api/supabase-auth';
import { adminResetOperatorPassword } from '../../api/adminResetOperatorPassword';
import { mirrorOperator, updateOperatorStatus } from '../../db/repositories/operators';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { showSheet } from '../shared/Sheet';
import { MIN_PASSWORD_LENGTH, normalizeUsername, passwordError, usernameError } from '../../domain/accountRules';
import { operatorDeactivationConfirmation } from './operatorMessages';

interface Operator {
  id: string;
  name: string;
  username?: string;
  role: string;
  status: string;
  assigned_projects: number;
  authAvailable?: boolean;
  created_at: string;
}

const OPERATOR_PAGE_SIZE = 20;

const OperadoresTab = () => {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [newOperatorName, setNewOperatorName] = useState('');
  const [newOperatorUsername, setNewOperatorUsername] = useState('');
  const [newOperatorPassword, setNewOperatorPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  // Show/hide for the two password fields: a typo in an initial or reset password
  // locks the operator out, and it cannot be seen while typed.
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  // Errors raised while the add-operator sheet is open are shown inside it.
  const [addError, setAddError] = useState<string | null>(null);
  const [operatorPage, setOperatorPage] = useState(1);
  const [hasMoreOperators, setHasMoreOperators] = useState(true);
  const [loadingMoreOperators, setLoadingMoreOperators] = useState(false);

  useEffect(() => {
    loadOperators();
  }, []);

  const loadOperators = async (isRefresh = false, page = 1, append = false) => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    if (isRefresh) {
      setRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setLastError(null);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (typeof console.debug === 'function') console.debug(`[PHC] Loading operators (attempt ${attempt}/${MAX_RETRIES})`);

        let serverOperators: any[] | null = null;
        let assignedProjectCounts: Record<string, number> = {};
        const token = await AsyncStorage.getItem('authToken');
        if (token) {
          try {
            serverOperators = await operatorsApi.getAll({ page, pageSize: OPERATOR_PAGE_SIZE });
            try {
              assignedProjectCounts = await operatorsApi.getAssignedProjectCounts(
                (serverOperators || []).map((operator) => String(operator.id)),
              );
            } catch (countError) {
              console.warn('[PHC] Could not load assigned project counts:', countError);
            }
            const currentTime = new Date().toISOString();
            await runInTransaction(async (transaction) => {
              for (const operator of serverOperators || []) {
                // Pass 1.5: only mirror operator accounts, and mirror the REAL
                // server-side activation state (profiles.is_active).
                if (operator.role && operator.role !== 'operator') continue;
                await mirrorOperator({
                  id: String(operator.id),
                  fullName: operator.full_name,
                  username: operator.username,
                  isActive: operator.is_active,
                  createdAt: operator.created_at,
                  currentTime,
                }, transaction.execute);
              }
            });
            setOperatorPage(page);
            setHasMoreOperators(serverOperators.length === OPERATOR_PAGE_SIZE);
          } catch (error) {
            console.warn('[PHC] Could not sync server operators:', error);
          }
        }

        const operatorIds = (serverOperators || [])
          .filter((operator) => !operator.role || operator.role === 'operator')
          .map((operator) => String(operator.id));
        const pageFilter = serverOperators
          ? `WHERE o.id IN (${operatorIds.map(() => '?').join(',') || 'NULL'})`
          : '';
        const result = await query<Operator>(`
          SELECT
            o.*,
            0 as assigned_projects
          FROM operators o
          ${pageFilter}
          ORDER BY o.created_at DESC
        `, operatorIds);
        // Operators log in with their username, and on a shared tablet the admin must
        // tell two people apart. The local mirror has no username column, so it comes
        // from the server page that was just read.
        const usernameById = new Map(
          (serverOperators || []).map((operator) => [String(operator.id), operator.username as string | undefined]),
        );
        for (const operator of result) {
          operator.assigned_projects = assignedProjectCounts[String(operator.id)] || 0;
          operator.username = usernameById.get(String(operator.id)) || undefined;
          operator.authAvailable = serverOperators?.find((row) => String(row.id) === String(operator.id))?.auth_available;
        }

        setOperators((current) => {
          if (!append || !serverOperators) return result || [];
          const merged = new Map(current.map((operator) => [operator.id, operator]));
          for (const operator of result || []) merged.set(operator.id, operator);
          return Array.from(merged.values());
        });
        if (!serverOperators) setHasMoreOperators(false);
        setLastError(null);
        if (typeof console.debug === 'function') console.debug(`[PHC] Operators loaded successfully: ${result.length} items`);
        break;
      } catch (error: any) {
        console.error(`[PHC] Error loading operators (attempt ${attempt}):`, error);

        const errorMessage = operatorErrorText(toErrorMessage(error)) || 'error desconocido';

        if (attempt < MAX_RETRIES) {
          if (typeof console.debug === 'function') console.debug(`[PHC] Retrying operators load in ${RETRY_DELAY * attempt}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
          continue;
        }

        setLastError(`Error al cargar operadores: ${errorMessage}`);
        setOperators([]);
      }
    }

    setIsLoading(false);
    setRefreshing(false);
  };

  const handleAddOperator = async () => {
    setAddError(null);
    if (!newOperatorName.trim()) {
      setAddError('Ingresá el nombre del operador');
      return;
    }

    const invalidAccount = usernameError(newOperatorUsername) ?? passwordError(newOperatorPassword);
    if (invalidAccount) {
      setAddError(invalidAccount);
      return;
    }

    setLoading(true);
    const username = normalizeUsername(newOperatorUsername);
    const operatorName = newOperatorName.trim();
    const currentTime = new Date().toISOString();

    const finishCreation = async (operatorId: string, reconciled: boolean) => {
      await mirrorOperator({
        id: operatorId,
        fullName: operatorName,
        isActive: true,
        createdAt: currentTime,
        currentTime,
      });
      showSheet(
        'Éxito',
        reconciled
          ? 'El operador fue creado. La respuesta se perdió, pero la cuenta quedó confirmada en el servidor.'
          : 'Operador agregado correctamente',
      );
      setNewOperatorName('');
      setNewOperatorUsername('');
      setNewOperatorPassword('');
      setAddError(null);
      setModalVisible(false);
      await loadOperators();
    };

    try {
      // This mutation is deliberately attempted once. It is not idempotent:
      // after an ambiguous/lost response, repeating it turns a successful
      // creation into an "already exists" error.
      const response = await auth.adminCreateOperator({
        username,
        email: `${username}@phc.local`,
        password: newOperatorPassword,
        first_name: operatorName,
        last_name: '',
      });
      await finishCreation(String(response.user.id), false);
    } catch (error: any) {
      console.error('[PHC] Error adding operator:', error);
      const creationMessage = toErrorMessage(error);
      const definiteConflict = /already|registered|exists|ya existe|registrado/i.test(creationMessage);

      if (!definiteConflict) {
        // The creation call itself is deliberately not retried (see comment
        // above), but this reconciliation lookup is read-only and safe to
        // retry — a single transient network blip right after the first one
        // shouldn't be enough to strand the admin not knowing whether the
        // operator actually got created.
        const RECONCILE_RETRIES = 3;
        let reconcileError: unknown = null;
        for (let attempt = 1; attempt <= RECONCILE_RETRIES; attempt++) {
          try {
            const existing = await operatorsApi.getByUsername(username);
            if (existing?.id) {
              await finishCreation(String(existing.id), true);
              return;
            }
            reconcileError = null;
            break;
          } catch (err) {
            reconcileError = err;
            if (attempt < RECONCILE_RETRIES) {
              await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
          }
        }
        if (reconcileError) {
          console.warn('[PHC] Could not reconcile ambiguous operator creation:', reconcileError);
          setModalVisible(false);
          setNewOperatorName('');
          setNewOperatorUsername('');
          setNewOperatorPassword('');
          showSheet(
            'Creación sin confirmar',
            'Se perdió la respuesta y no se pudo consultar el servidor. No vuelvas a crear la cuenta todavía: recuperá la conexión y actualizá la lista de operadores para comprobar si existe.',
          );
          return;
        }
      }

      setAddError(adminErrorText(error, 'No se pudo agregar el operador.'));
    } finally {
      setLoading(false);
    }
  };

  const loadMoreOperators = async () => {
    if (!hasMoreOperators || loadingMoreOperators) return;
    setLoadingMoreOperators(true);
    try {
      await loadOperators(false, operatorPage + 1, true);
    } finally {
      setLoadingMoreOperators(false);
    }
  };

  const handleToggleStatus = async (operatorId: string, currentStatus: string, confirmed = false) => {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    if (newStatus === 'inactive' && !confirmed) {
      const operator = operators.find((entry) => entry.id === operatorId);
      showSheet(
        'Confirmar desactivación',
        operatorDeactivationConfirmation(operator?.name || 'este operador'),
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Desactivar', style: 'destructive', onPress: () => void handleToggleStatus(operatorId, currentStatus, true) },
        ],
      );
      return;
    }
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (typeof console.debug === 'function') console.debug(`[PHC] Updating operator status (attempt ${attempt}/${MAX_RETRIES})`);

        // Pass 1.5: this is now a REAL server-side control. Update
        // profiles.is_active first (admin-only via RLS + DB trigger);
        // deactivated users are rejected at login. Only mirror locally
        // after the server accepted the change — never fake the state.
        await operatorsApi.setActive(operatorId, newStatus === 'active');

        await updateOperatorStatus(operatorId, newStatus, new Date().toISOString());

        showSheet('Éxito', `Operador ${newStatus === 'active' ? 'activado' : 'desactivado'}`);
        await loadOperators();
        return;
      } catch (error: any) {
        console.error(`[PHC] Error updating operator status (attempt ${attempt}):`, error);

        const errorMessage = operatorErrorText(toErrorMessage(error)) || 'error desconocido';

        if (attempt < MAX_RETRIES) {
          if (typeof console.debug === 'function') console.debug(`[PHC] Retrying operator status update in ${RETRY_DELAY * attempt}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
          continue;
        }

        showSheet(
          'Error al actualizar estado',
          `No se pudo actualizar el estado del operador después de ${MAX_RETRIES} intentos: ${errorMessage}`,
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Reintentar',
              onPress: () => handleToggleStatus(operatorId, currentStatus, true)
            }
          ]
        );
      }
    }
  };

  /**
   * Deleting an operator is irreversible and frees their username, so it asks
   * first — and names the person, because these rows look alike and the two
   * buttons beside this one are recoverable.
   */
  const confirmDelete = (operator: Operator) => {
    const label = operator.name || 'este operador';
    showSheet(
      'Eliminar operador',
      `¿Eliminar a ${label}? Esto no se puede deshacer.\n\n`
      + 'Solo funciona si nunca registró trabajo. Si ya trabajó, usá Desactivar '
      + 'para que su historial siga siendo suyo.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => handleDelete(operator),
        },
      ],
    );
  };

  const handleDelete = async (operator: Operator) => {
    try {
      await operatorsApi.deleteUnusedOperator(operator.id);
      // Drop the local mirror too, or the row reappears on the next read from
      // SQLite and looks like the delete silently failed.
      await execute('DELETE FROM operators WHERE id = ?', [operator.id]);
      showSheet('Operador eliminado', `${operator.name || 'El operador'} ya no está en la lista.`);
      await loadOperators();
    } catch (error: any) {
      // The server's refusals are written in Spanish and say what to do
      // instead, so they are shown as-is rather than replaced with a generic
      // failure message.
      showSheet('No se pudo eliminar', adminErrorText(error, 'No se pudo eliminar el operador.'));
    }
  };

  const handleResetPassword = async (operator: Operator) => {
    const invalidPassword = passwordError(resetPassword);
    if (invalidPassword) {
      showSheet('Error', invalidPassword);
      return;
    }
    setResetBusy(true);
    try {
      await adminResetOperatorPassword(operator.id, resetPassword);
      setResettingId(null);
      setResetPassword('');
      showSheet(
        'Contraseña actualizada',
        `Avisale la nueva contraseña a ${operator.name}.`
      );
    } catch (error: any) {
      // The server changes the password first and then ends the open sessions. When
      // only that second step fails, the new password is already in force: report it
      // as done, and say what is still open.
      const rawMessage = toErrorMessage(error);
      if (/actualizada, pero no se pudieron cerrar/i.test(rawMessage)) {
        setResettingId(null);
        setResetPassword('');
        showSheet(
          'Contraseña actualizada',
          `Avisale la nueva contraseña a ${operator.name}. Las sesiones abiertas no se pudieron cerrar: si el operador tiene la tablet con sesión, cerrala desde el panel web.`,
        );
      } else {
        showSheet('Error', adminErrorText(error, 'No se pudo restablecer la contraseña'));
      }
    } finally {
      setResetBusy(false);
    }
  };

  const getStatusColor = (status: string) => {
    return status === 'active' ? COLORS.success : COLORS.danger;
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    } catch {
      return 'Fecha inválida';
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando operadores...</Text>
      </View>
    );
  }

  // Error state
  if (lastError && operators.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorIcon}></Text>
        <Text style={styles.errorText}>{lastError}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => loadOperators()}>
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
          onRefresh={() => loadOperators(true)}
          colors={[COLORS.primary]}
          tintColor={COLORS.primary}
        />
      }
    >
      <View style={styles.content}>
        {lastError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{lastError}</Text>
            <TouchableOpacity onPress={() => loadOperators()}>
              <Text style={styles.errorBannerRetry}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Gestión de Operadores</Text>
            <Text style={styles.subtitle}>Administrá el equipo de trabajo</Text>
          </View>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => setModalVisible(true)}
          >
            <Text style={styles.addButtonText}>+ Agregar</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <View style={styles.statsContainer}>
          <View style={styles.statCard}>
            <Text style={styles.statNumber}>{operators.length}</Text>
            <Text style={styles.statLabel}>Operadores cargados</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statNumber}>
              {operators.filter(op => op.status === 'active').length}
            </Text>
            <Text style={styles.statLabel}>Activos cargados</Text>
          </View>
        </View>

        {/* Operators List */}
        {operators.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>No hay operadores registrados</Text>
          </View>
        ) : (
          operators.map((operator) => (
            <View key={operator.id} style={styles.operatorCard}>
              <View style={styles.operatorHeader}>
                <View>
                  <Text style={styles.operatorName}>{operator.name}</Text>
                  {!!operator.username && (
                    <Text style={styles.operatorDetail}>@{operator.username}</Text>
                  )}
                </View>
                <View style={[styles.statusBadge, { backgroundColor: getStatusColor(operator.status) }]}>
                  <Text style={styles.statusText}>
                    {operator.authAvailable === false ? 'Acceso eliminado' : operator.status === 'active' ? 'Activo' : 'Inactivo'}
                  </Text>
                </View>
              </View>

              <View style={styles.operatorContent}>
                <Text style={styles.operatorDetail}>
                  Proyectos asignados: {operator.assigned_projects || 0}
                </Text>
                <Text style={styles.operatorDetail}>
                  Registrado: {formatDate(operator.created_at)}
                </Text>

                <View style={styles.operatorActions}>
                  <TouchableOpacity
                    style={[
                      styles.actionButton,
                      { backgroundColor: operator.status === 'active' ? COLORS.danger : COLORS.success }
                    ]}
                    disabled={operator.authAvailable === false}
                    onPress={() => handleToggleStatus(operator.id, operator.status)}
                  >
                    <Text style={styles.actionButtonText}>
                      {operator.status === 'active' ? 'Desactivar' : 'Activar'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionButton, { backgroundColor: COLORS.primary, marginLeft: SPACING.sm }]}
                    disabled={operator.authAvailable === false}
                    onPress={() => {
                      setResettingId(resettingId === operator.id ? null : operator.id);
                      setResetPassword('');
                    }}
                  >
                    <Text style={styles.actionButtonText}>
                      {resettingId === operator.id ? 'Cancelar clave' : 'Restablecer clave'}
                    </Text>
                  </TouchableOpacity>
                  {/* Only for an operator who never worked. The server refuses
                      for anyone with history and says why, because their
                      attribution in the audit log is evidence. */}
                  <TouchableOpacity
                    style={[styles.actionButton, styles.deleteButton]}
                    onPress={() => confirmDelete(operator)}
                    accessibilityLabel={`Eliminar a ${operator.name || 'este operador'}`}
                  >
                    <Text style={styles.actionButtonText}>Eliminar</Text>
                  </TouchableOpacity>
                </View>
                {resettingId === operator.id && (
                  <View style={{ marginTop: SPACING.md }}>
                    <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                      testID="reset-password-input"
                      style={styles.modalInput}
                      value={resetPassword}
                      onChangeText={setResetPassword}
                      placeholder={`Nueva contraseña (mín. ${MIN_PASSWORD_LENGTH})`}
                      placeholderTextColor={COLORS.placeholder}
                      secureTextEntry={!showResetPassword}
                    />
                    <TouchableOpacity
                      testID="reset-password-toggle"
                      accessibilityRole="button"
                      accessibilityLabel={showResetPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      onPress={() => setShowResetPassword((shown) => !shown)}
                      style={{ marginTop: SPACING.xs, minHeight: 48, justifyContent: 'center' }}
                    >
                      <Text style={styles.operatorDetail}>{showResetPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionButton, { backgroundColor: COLORS.success, marginTop: SPACING.sm, opacity: resetBusy ? 0.6 : 1 }]}
                      disabled={resetBusy}
                      onPress={() => handleResetPassword(operator)}
                    >
                      <Text style={styles.actionButtonText}>
                        {resetBusy ? 'Guardando…' : 'Confirmar nueva contraseña'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
          ))
        )}
        {hasMoreOperators ? (
          <TouchableOpacity
            style={styles.loadMoreButton}
            onPress={loadMoreOperators}
            disabled={loadingMoreOperators}
          >
            <Text style={styles.loadMoreButtonText}>
              {loadingMoreOperators ? 'Cargando…' : 'Cargar más operadores'}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Add Operator Modal */}
        <Modal
          visible={modalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Agregar Nuevo Operador</Text>

              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                style={styles.modalInput}
                value={newOperatorName}
                onChangeText={setNewOperatorName}
                placeholder="Nombre completo del operador"
                placeholderTextColor={COLORS.placeholder}
                autoFocus
              />

              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                style={styles.modalInput}
                value={newOperatorUsername}
                onChangeText={setNewOperatorUsername}
                placeholder="Usuario para iniciar sesión"
                placeholderTextColor={COLORS.placeholder}
                autoCapitalize="none"
              />

              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                testID="new-operator-password-input"
                style={styles.modalInput}
                value={newOperatorPassword}
                onChangeText={setNewOperatorPassword}
                placeholder="Contraseña inicial"
                placeholderTextColor={COLORS.placeholder}
                secureTextEntry={!showNewPassword}
              />
              <TouchableOpacity
                testID="new-operator-password-toggle"
                accessibilityRole="button"
                accessibilityLabel={showNewPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                onPress={() => setShowNewPassword((shown) => !shown)}
                style={{ minHeight: 48, justifyContent: 'center' }}
              >
                <Text style={styles.operatorDetail}>{showNewPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}</Text>
              </TouchableOpacity>

              {addError && (
                <Text style={styles.errorText} accessibilityRole="alert">{addError}</Text>
              )}

              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalCancelButton]}
	                  onPress={() => {
	                    setModalVisible(false);
	                    setNewOperatorName('');
	                    setNewOperatorUsername('');
	                    setNewOperatorPassword('');
	                    setAddError(null);
	                    setShowNewPassword(false);
	                  }}
                >
                  <Text style={styles.modalCancelText}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.modalButton, styles.modalSaveButton, loading && styles.modalButtonDisabled]}
                  onPress={handleAddOperator}
                  disabled={loading}
                >
                  <Text style={styles.modalSaveText}>
                    {loading ? 'Guardando...' : 'Agregar'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: SPACING.xl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: SPACING.xxl,
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
  },
  addButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
  },
  addButtonText: {
    color: COLORS.text,
    fontWeight: 'bold',
    fontSize: TYPE.label,
  },
  loadMoreButton: { minHeight: 48, justifyContent: 'center',
    borderColor: COLORS.accent,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginBottom: SPACING.xl,
  },
  loadMoreButtonText: {
    color: COLORS.primaryText,
    fontWeight: 'bold',
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.xxl,
  },
  statCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    alignItems: 'center',
    flex: 1,
    marginHorizontal: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statNumber: {
    fontSize: TYPE.h1,
    fontWeight: 'bold',
    color: COLORS.primaryText,
    marginBottom: SPACING.xs,
  },
  statLabel: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  operatorCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  operatorHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  operatorName: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    flex: 1,
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
  operatorContent: {
    padding: SPACING.lg,
  },
  operatorDetail: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  operatorActions: {
    marginTop: SPACING.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  actionButton: { minHeight: 48, justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
  },
  // Outlined rather than filled: the two buttons beside it are recoverable and
  // this one is not, so it should not compete for the thumb.
  deleteButton: {
    marginLeft: SPACING.sm,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.danger,
  },
  actionButtonText: {
    color: COLORS.text,
    fontWeight: 'bold',
    fontSize: TYPE.label,
  },
  emptyState: {
    alignItems: 'center',
    padding: SPACING.huge,
  },
  emptyStateText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
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
    marginBottom: SPACING.xl,
    textAlign: 'center',
  },
  modalInput: {
    backgroundColor: COLORS.background,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    fontSize: TYPE.bodyLg,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.xl,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: { minHeight: 48, justifyContent: 'center',
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    marginHorizontal: SPACING.sm,
  },
  modalCancelButton: {
    backgroundColor: COLORS.neutral,
  },
  modalSaveButton: {
    backgroundColor: COLORS.primary,
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

export default OperadoresTab;
