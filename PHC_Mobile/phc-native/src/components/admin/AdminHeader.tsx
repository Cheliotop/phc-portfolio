import { useState } from 'react';
import {
  Keyboard,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { pedidosApi } from '../../api/supabase-pedidos';
import { projectsApi } from '../../api/supabase-projects';
import { COLORS, CONTENT_MAX_WIDTH, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import PHCLogo from '../../components/shared/PHCLogo';
import { SyncQueueModal, SyncStatusIndicator } from '../../components/shared/SyncStatusIndicator';
import { exportProjectsToCsv, exportSupplyRequestsToCsv, shareCsvFile } from '../../utils/exportCsv';
import { exportPedidosListPdf, exportProjectsListPdf, sharePdfFile } from '../../utils/adminListPdf';
import supabase from '../../lib/supabase';
import { auditDataExport } from '../../utils/auditLog';
import { auth } from '../../api/supabase-auth';
import type { RootStackNavigationProp } from '../../navigation/types';
import { adminSharedStyles } from './adminSharedStyles';
import { showSheet } from '../shared/Sheet';
import { MIN_PASSWORD_LENGTH, passwordError } from '../../domain/accountRules';
import { adminErrorText } from '../../domain/adminErrors';

const AdminHeader = () => {
  const { width } = useWindowDimensions();
  const isTablet = width >= 600;
  const navigation = useNavigation<RootStackNavigationProp<'AdminDashboard'>>();
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  // Shown inside the change-password card: the page sheet would sit behind the modal.
  const [changePasswordError, setChangePasswordError] = useState<string | null>(null);

  const handleChangeOwnPassword = async () => {
    setChangePasswordError(null);
    const invalidPassword = passwordError(newPassword);
    if (invalidPassword) {
      setChangePasswordError(invalidPassword);
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePasswordError('Las contraseñas no coinciden');
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setShowChangePassword(false);
      setNewPassword('');
      setConfirmPassword('');
      showSheet('Listo', 'Contraseña actualizada correctamente');
    } catch (error: any) {
      setChangePasswordError(adminErrorText(error, 'No se pudo cambiar la contraseña'));
    } finally {
      setSavingPassword(false);
    }
  };


  const handleLogout = () => {
    showSheet(
      'Cerrar Sesión',
      '¿Seguro que querés cerrar sesión?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sí, cerrar',
          style: 'destructive',
          onPress: async () => {
            try {
              await auth.logout();
            } catch (error) {
              console.error('Error logging out:', error);
            } finally {
              navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
            }
          },
        },
      ]
    );
  };

  // Pass 4: export now pulls from the server (source of truth) and actually
  // shares the generated CSV file, and is reachable from the header button.
  const runExport = async (type: 'projects' | 'pedidos', format: 'csv' | 'pdf') => {
    try {
      let fileUri: string;
      if (type === 'projects') {
        const projects = await projectsApi.getAllPages({ pageSize: 50, orderBy: 'updated_at', orderDir: 'desc' });
        fileUri = format === 'pdf'
          ? await exportProjectsListPdf(projects as any[])
          : await exportProjectsToCsv(projects as any[]);
      } else {
        const requests = await pedidosApi.getAllPages();
        fileUri = format === 'pdf'
          ? await exportPedidosListPdf(requests.data || [])
          : await exportSupplyRequestsToCsv((requests.data || []) as any[]);
      }
      await auditDataExport(type, 1);
      try {
        if (format === 'pdf') await sharePdfFile(fileUri);
        else await shareCsvFile(fileUri);
      } catch {
        showSheet('Exportado', `Archivo ${format.toUpperCase()} generado:\n${fileUri}`);
      }
    } catch (error: any) {
      console.error('[Export] Failed:', error);
      showSheet('Error', error?.message === 'No data to export' ? 'No hay datos para exportar' : 'No se pudieron exportar los datos');
    }
  };

  const handleMenu = () => {
    showSheet('Administración', undefined, [
      { text: 'Exportar', onPress: handleExport },
      { text: 'Cambiar clave', onPress: () => setShowChangePassword(true) },
      { text: 'Cerrar sesión', style: 'destructive', onPress: handleLogout },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };

  // PDF first: it is the format that gets printed, filed and handed to a
  // client, and it was previously listed below CSV so CSV read as the default.
  // CSV stays available underneath for spreadsheet work.
  const handleExport = () => {
    showSheet('Exportar', 'Elegí qué exportar', [
      { text: 'Exportar PDF · Proyectos', onPress: () => runExport('projects', 'pdf') },
      { text: 'Exportar PDF · Pedidos', onPress: () => runExport('pedidos', 'pdf') },
      { text: 'Exportar CSV · Proyectos', onPress: () => runExport('projects', 'csv') },
      { text: 'Exportar CSV · Pedidos', onPress: () => runExport('pedidos', 'csv') },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };

  return (
    <View style={[styles.header, isTablet && styles.tabletHeader]}>
      <View style={styles.headerLeft}>
        <PHCLogo height={28} />
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>Administración</Text>
          <Text style={styles.headerSubtitle}>Panel de Control</Text>
        </View>
      </View>
      <View style={[styles.headerRight, isTablet && styles.tabletHeaderRight]}>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowSyncModal(true)}>
          <SyncStatusIndicator showCount={true} />
        </TouchableOpacity>
        {/* Exportar / Clave / Salir were three permanent buttons on every
            screen. They are occasional actions, and "Salir" being one tap away
            on a shared field phone was a hazard rather than a convenience. */}
        <TouchableOpacity
          testID="admin-header-menu"
          accessibilityRole="button"
          accessibilityLabel="Menú de administración"
          style={[styles.logoutButton, { marginLeft: SPACING.sm }]}
          onPress={handleMenu}
        >
          <Text style={styles.logoutButtonText}>Menú</Text>
        </TouchableOpacity>
      </View>
      <SyncQueueModal visible={showSyncModal} onClose={() => setShowSyncModal(false)} />
      <Modal
        visible={showChangePassword}
        transparent
        animationType="slide"
        onRequestClose={() => setShowChangePassword(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.rqCard}>
            <Text style={styles.rqTitle}>Cambiar mi contraseña</Text>
            <Text style={styles.rqSub}>Mínimo {MIN_PASSWORD_LENGTH} caracteres</Text>
            {changePasswordError && (
              <Text style={styles.rqSub} accessibilityRole="alert">{changePasswordError}</Text>
            )}
            <Text style={styles.rqLabel}>Nueva contraseña</Text>
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
              style={styles.rqInput}
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              placeholderTextColor={COLORS.placeholder}
            />
            <Text style={styles.rqLabel}>Repetir contraseña</Text>
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
              style={styles.rqInput}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              placeholderTextColor={COLORS.placeholder}
            />
            <View style={styles.rqButtons}>
              <TouchableOpacity
                style={styles.rqCancel}
                onPress={() => {
                  setShowChangePassword(false);
                  setNewPassword('');
                  setConfirmPassword('');
                }}
              >
                <Text style={styles.rqCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.rqConfirm, savingPassword && { opacity: 0.6 }]}
                onPress={handleChangeOwnPassword}
                disabled={savingPassword}
              >
                <Text style={styles.rqConfirmText}>{savingPassword ? 'Guardando…' : 'Guardar'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  ...adminSharedStyles,
  header: {
    backgroundColor: COLORS.appBar,
    paddingTop: SPACING.huge2,
    paddingBottom: SPACING.md,
    paddingHorizontal: SPACING.xl,
    alignItems: 'stretch',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tabletHeader: { flexDirection: 'row', alignItems: 'center' },
  headerButton: { minHeight: 48, justifyContent: 'center',
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
    marginRight: SPACING.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: SPACING.md,
  },
  tabletHeaderRight: { marginTop: SPACING.none, flexShrink: 0 },
  headerSubtitle: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  headerText: {
    marginLeft: SPACING.md,
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: TYPE.body,
    fontWeight: TYPE.bold,
    color: COLORS.text,
  },
  logoutButton: { minHeight: 48, justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
  },
  logoutButtonText: {
    color: COLORS.textSecondary,
    fontWeight: TYPE.semibold,
    fontSize: TYPE.caption,
  },
  rqButtons: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.xl },
  rqCancel: { flex: 1, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, paddingVertical: SPACING.lg, alignItems: 'center' },
  rqCancelText: { color: COLORS.textSecondary, fontWeight: '600' },
  rqCard: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
  },
  rqConfirm: { flex: 1, backgroundColor: COLORS.success, borderRadius: RADIUS.md, paddingVertical: SPACING.lg, alignItems: 'center' },
  rqConfirmText: { color: COLORS.text, fontWeight: '700' },
  rqInput: {
    backgroundColor: COLORS.input,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
  },
  rqLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: '600', marginTop: SPACING.md, marginBottom: SPACING.sm },
  rqSub: { color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.xs, marginBottom: SPACING.lg },
  rqTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: '700' },
});

export default AdminHeader;
