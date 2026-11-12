import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { completionApi } from '../../api/supabase-completion';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { showSheet } from '../shared/Sheet';
import { adminErrorText } from '../../domain/adminErrors';

const COMPLETION_PAGE_SIZE = 20;

const CompletionReportsTab = () => {
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reportPage, setReportPage] = useState(1);
  const [hasMoreReports, setHasMoreReports] = useState(true);
  const [loadingMoreReports, setLoadingMoreReports] = useState(false);

  const formatChecklist = (value: any) => {
    if (!value) {
      return '-';
    }
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    return String(value);
  };

  useEffect(() => {
    loadReports();
  }, []);

  const loadReports = async (page = 1, append = false) => {
    if (!append) setLoading(true);
    setLastError(null);
    try {
      const response = await completionApi.getAll(undefined, { page, pageSize: COMPLETION_PAGE_SIZE });
      setReportPage(page);
      setHasMoreReports(response.data.length === COMPLETION_PAGE_SIZE);
      setReports((current) => append ? [...current, ...response.data] : (response.data || []));
    } catch (error: any) {
      setLastError(adminErrorText(error, 'Error al cargar informes'));
      setReports([]);
    } finally {
      if (!append) setLoading(false);
    }
  };

  const loadMoreReports = async () => {
    if (!hasMoreReports || loadingMoreReports) return;
    setLoadingMoreReports(true);
    try {
      await loadReports(reportPage + 1, true);
    } finally {
      setLoadingMoreReports(false);
    }
  };

  const viewPdf = async (report: any) => {
    if (!report.pdf_url) {
      showSheet('Sin PDF', 'Este informe todavía no tiene un PDF generado.');
      return;
    }
    try {
      const signedUrl = await completionApi.getPdfSignedUrl(report.pdf_url);
      if (signedUrl) {
        await Linking.openURL(signedUrl);
      }
    } catch (error: any) {
      showSheet('Error', adminErrorText(error, 'No se pudo abrir el PDF'));
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando cierres...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Informes de Cierre</Text>
      {lastError ? (
        <TouchableOpacity style={styles.errorBox} onPress={() => loadReports()}>
          <Text style={styles.errorText}>{lastError}</Text>
          <Text style={styles.retryText}>Tocar para reintentar</Text>
        </TouchableOpacity>
      ) : null}

      {reports.length === 0 ? (
        <Text style={styles.emptyText}>No hay informes de cierre todavía.</Text>
      ) : (
        reports.map((report) => (
          <View key={String(report.id)} style={styles.card}>
            <Text style={styles.projectName}>{report.projects?.name || `Proyecto ${report.project_id}`}</Text>
            <Text style={styles.detail}>Operador: {report.profiles?.full_name || report.profiles?.username || '-'}</Text>
            <Text style={styles.detail}>Caudal: {report.flow_rate || '-'} {report.flow_unit || 'L/h'}</Text>
            <Text style={styles.detail}>Nivel estático: {report.static_level || '-'} m</Text>
            <Text style={styles.detail}>Nivel dinámico: {report.dynamic_level || '-'} m</Text>
            <Text style={styles.detail}>Calidad: {report.water_quality || '-'}</Text>
            <Text style={styles.detail}>Checklist: {formatChecklist(report.completion_checklist)}</Text>
            <Text style={styles.detail}>Firma operador: {report.operator_signature || '-'}</Text>
            <Text style={styles.detail}>Firma cliente: {report.client_signature || '-'}</Text>
            <Text style={styles.detail}>Firma admin: {report.admin_signature || '-'}</Text>
            <Text style={styles.detail}>
              Estado: {report.admin_signature
                ? 'Firmado'
                : report.status === 'returned' ? 'Devuelta al operador para corregir' : 'Enviado (pendiente de firma)'}
            </Text>
            {report.pdf_url && (
              <TouchableOpacity style={styles.pdfButton} onPress={() => viewPdf(report)}>
                <Text style={styles.signButtonText}>Ver PDF</Text>
              </TouchableOpacity>
            )}
            <Text style={styles.disclaimer}>
              Revisá y firmá la Ficha desde el panel web.
            </Text>
          </View>
        ))
      )}
      {hasMoreReports ? (
        <TouchableOpacity
          style={styles.loadMoreButton}
          onPress={loadMoreReports}
          disabled={loadingMoreReports}
        >
          <Text style={styles.loadMoreButtonText}>
            {loadingMoreReports ? 'Cargando…' : 'Cargar más cierres'}
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.xl, paddingBottom: SPACING.huge },
  centered: { justifyContent: 'center', alignItems: 'center', padding: SPACING.xl },
  loadingText: { color: COLORS.textSecondary, marginTop: SPACING.md },
  title: { color: COLORS.text, fontSize: TYPE.h1, fontWeight: 'bold', marginBottom: SPACING.lg },
  errorBox: { backgroundColor: COLORS.errorBg, padding: SPACING.md, borderRadius: RADIUS.md, marginBottom: SPACING.lg },
  errorText: { color: COLORS.text },
  retryText: { color: COLORS.textSecondary, marginTop: SPACING.xs },
  emptyText: { color: COLORS.textSecondary, textAlign: 'center', marginTop: SPACING.xxxl },
  disclaimer: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 17, marginBottom: SPACING.lg },
  card: { backgroundColor: COLORS.surface, borderRadius: RADIUS.md, borderColor: COLORS.border, borderWidth: 1, padding: SPACING.lg, marginBottom: SPACING.md },
  projectName: { color: COLORS.text, fontSize: TYPE.bodyLg, fontWeight: 'bold', marginBottom: SPACING.sm },
  detail: { color: COLORS.textSecondary, marginBottom: SPACING.xs },
  pdfButton: { minHeight: 48, justifyContent: 'center', backgroundColor: COLORS.primary, padding: SPACING.md, borderRadius: RADIUS.md, alignItems: 'center', marginTop: SPACING.md },
  signButtonText: { color: COLORS.text, fontWeight: 'bold' },
  loadMoreButton: { minHeight: 48, justifyContent: 'center', borderColor: COLORS.accent, borderWidth: 1, padding: SPACING.md, borderRadius: RADIUS.md, alignItems: 'center', marginTop: SPACING.xs },
  loadMoreButtonText: { color: COLORS.primaryText, fontWeight: 'bold' },
});

export default CompletionReportsTab;
