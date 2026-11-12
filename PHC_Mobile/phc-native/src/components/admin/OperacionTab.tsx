import React, { useCallback, useEffect, useState } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';

import { productV2Api } from '../../api/supabase-product-v2';
import { projectsApi } from '../../api/supabase-projects';
import { shiftsApi } from '../../api/supabase-shifts';
import { COLORS, RADIUS, SPACING, STATUS, TYPE } from '../../theme/phcTheme';
import type { Json } from '../../types/supabase.generated';
import type {
  AuditEntry,
  OperatorAccountabilityMetrics,
  OperatorDirectoryEntry,
  Shift,
  ShiftStatus,
} from '../../types/productV2';
import { adminErrorText } from '../../domain/adminErrors';
import { formatDisplayDateTime } from '../../utils/dateFormat';
import { auditActionLabel, entityLabel, fieldLabel } from '../../domain/auditLabels';
import { adminSharedStyles } from './adminSharedStyles';
import { animateNextLayout } from '../../utils/motion';

interface ProjectOption {
  id: number;
  name: string;
  location?: string | null;
  status?: string | null;
}

interface OperationFilters {
  projectId: string;
  operatorId: string;
  shiftStatus: '' | ShiftStatus;
  entityType: string;
  action: string;
}

type CorrectionEntity = 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports';

/**
 * This tab used to render everything at once: filters, the shift list, a
 * metric grid per operator, the correction form and the audit log, stacked in
 * one scroll. That was 26 interactive controls on a phone screen, and the
 * single filter card served two unrelated queries — "Entidad del historial"
 * sat directly above the *Turnos* list while filtering something else.
 *
 * Splitting by view keeps each screen to one question, and lets the filters
 * shown be only the ones that affect what is actually on screen.
 */
type OperationView = 'turnos' | 'cumplimiento' | 'historial';

const VIEWS: { key: OperationView; label: string; blurb: string }[] = [
  { key: 'turnos', label: 'Turnos', blurb: 'Turnos abiertos, cerrados y entregas con diferencias' },
  { key: 'cumplimiento', label: 'Cumplimiento', blurb: 'Rendimiento e informes por operador' },
  { key: 'historial', label: 'Historial', blurb: 'Registro append-only y correcciones administrativas' },
];

const EMPTY_FILTERS: OperationFilters = {
  projectId: '',
  operatorId: '',
  shiftStatus: '',
  entityType: '',
  action: '',
};

const ENTITY_TYPES = [
  'projects',
  'project_closing_assignments',
  'shifts',
  'catalog_materials',
  'catalog_variants',
  'project_materials',
  'material_reconciliations',
  'pedidos',
  'pedido_items',
  'completion_reports',
  'completion_discrepancies',
  'water_samples',
  'project_attachments',
  'photos',
];

// Fields stored as numbers: a typed "12,5" is saved as 12.5, not as the text "12,5".
const NUMERIC_CORRECTION_FIELDS = new Set([
  'depth_start', 'depth_end', 'length', 'diameter', 'water_level', 'duration_minutes', 'quantity_used',
  'sample_number', 'depth_m', 'static_level', 'dynamic_level', 'flow_rate', 'specific_flow_rate',
  'maximum_flow_rate', 'pump_depth_m', 'exploration_depth_m', 'widening_depth_m', 'casing_total_m',
]);

// How the admin names the record inside the chosen well (same rules as the web).
const CORRECTION_REFERENCE: Record<CorrectionEntity, { label: string; placeholder: string; missing: string }> = {
  drilling_bars: { label: 'N.º de barra', placeholder: 'Ej: 7', missing: 'Ese pozo no tiene una barra con ese número.' },
  water_samples: { label: 'N.º de muestra', placeholder: 'Ej: 3', missing: 'Ese pozo no tiene una muestra con ese número.' },
  shifts: { label: 'ID del turno', placeholder: 'Pegá el ID del turno', missing: 'Ese turno no es de este pozo.' },
  material_consumption: { label: 'ID del consumo', placeholder: 'Ej: 42', missing: 'Ese pozo no tiene un consumo con ese ID.' },
  completion_reports: { label: 'Ficha del pozo', placeholder: '', missing: 'Ese pozo todavía no tiene Ficha.' },
};

const CORRECTION_FIELDS: Record<CorrectionEntity, string[]> = {
  drilling_bars: ['depth_start', 'depth_end', 'length', 'diameter', 'soil_type', 'start_time', 'end_time', 'duration_minutes', 'water_level', 'notes'],
  shifts: ['started_at', 'ended_at', 'end_type', 'notes'],
  material_consumption: ['quantity_used', 'unit', 'date', 'notes', 'approximate'],
  water_samples: ['sample_number', 'depth_m', 'stage', 'notes', 'taken_at'],
  completion_reports: ['static_level', 'dynamic_level', 'flow_rate', 'specific_flow_rate', 'maximum_flow_rate', 'pump_depth_m', 'exploration_depth_m', 'widening_depth_m', 'casing_total_m', 'casing_layout', 'water_quality', 'completion_notes'],
};

// Was `toLocaleString('es-PY', …)`. The release build runs on JavaScriptCore
// without full ICU, which ignores the locale and silently returns English —
// "Jul 31, 2026" in the middle of a Spanish history screen. formatDisplayDateTime
// builds the string from the parts and needs no locale data at all.
const formatDateTime = (value?: string | null) => formatDisplayDateTime(value);

const formatHours = (start: string, end?: string | null) => {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '—';
  return `${Math.round(((endMs - startMs) / 36e5) * 10) / 10} h`;
};

const correctionDisplay = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

// What the admin is about to change, in words: well, record, current and new value.
const correctionPreview = (
  entityType: CorrectionEntity,
  record: Record<string, unknown>,
  fieldName: string,
  correctedValue: unknown,
) => {
  const project = record.projects as { name?: string | null; well_name?: string | null } | null;
  let recordLabel: string;
  if (entityType === 'drilling_bars') recordLabel = `Barra ${correctionDisplay(record.bar_number)}`;
  else if (entityType === 'water_samples') recordLabel = `Muestra N.º ${correctionDisplay(record.sample_number)}`;
  else if (entityType === 'shifts') recordLabel = `Turno del ${formatDateTime(String(record.started_at ?? ''))}`;
  else if (entityType === 'completion_reports') recordLabel = `Ficha #${correctionDisplay(record.id)}`;
  else recordLabel = `Consumo #${correctionDisplay(record.id)}`;
  return {
    wellName: project?.name || `Proyecto #${correctionDisplay(record.project_id)}`,
    recordLabel,
    currentValue: correctionDisplay(record[fieldName]),
    correctedValue: correctionDisplay(correctedValue),
  };
};

const operatorName = (operator?: OperatorDirectoryEntry) =>
  operator?.full_name || operator?.username || 'Operador';

const shiftStatusLabel = (status: ShiftStatus) => {
  if (status === 'open') return 'Abierto';
  if (status === 'report_pending') return 'Informe pendiente';
  return 'Cerrado';
};

// Naming lives in domain/auditLabels: the audit trigger writes raw table names
// and `lower(TG_OP)`, so anything rendered straight from the row reaches the
// administrator in English.

const OperacionTab = () => {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [operators, setOperators] = useState<OperatorDirectoryEntry[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [metrics, setMetrics] = useState<OperatorAccountabilityMetrics[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [draftFilters, setDraftFilters] = useState<OperationFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<OperationFilters>(EMPTY_FILTERS);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [correction, setCorrection] = useState<{
    projectId: string;
    entityType: CorrectionEntity;
    entityId: string;
    fieldName: string;
    value: string;
    reason: string;
  }>({ projectId: '', entityType: 'drilling_bars', entityId: '', fieldName: 'depth_end', value: '', reason: '' });
  const [savingCorrection, setSavingCorrection] = useState(false);
  // The record the correction will target, looked up inside the chosen well. The
  // save stays disabled until this matches the form, so the admin sees the record first.
  const [correctionRecord, setCorrectionRecord] = useState<{ key: string; record: Record<string, unknown> } | null>(null);
  const [correctionLookup, setCorrectionLookup] = useState<'idle' | 'loading' | 'missing' | 'error' | 'ready'>('idle');
  const [view, setView] = useState<OperationView>('turnos');
  const [showCorrection, setShowCorrection] = useState(false);
  const [forceClose, setForceClose] = useState<{ shiftId: string; reason: string } | null>(null);
  const [savingForceClose, setSavingForceClose] = useState(false);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [projectRows, operatorRows] = await Promise.all([
        projectsApi.getAll({ orderBy: 'created_at', orderDir: 'desc' }) as Promise<ProjectOption[]>,
        shiftsApi.getOperatorDirectory(),
      ]);
      const selectedOperators = appliedFilters.operatorId
        ? operatorRows.filter((operator) => operator.id === appliedFilters.operatorId)
        : operatorRows;
      // Metrics load on their own: one slow operator must not blank the shifts
      // (where "Cerrar turno" lives) or the audit log.
      const metricsRequest = shiftsApi.getAllOperatorMetrics(selectedOperators).then(
        (rows) => ({ rows, failed: false }),
        () => ({ rows: [] as OperatorAccountabilityMetrics[], failed: true }),
      );
      const [shiftRows, metricResult, auditRows] = await Promise.all([
        shiftsApi.getAll({
          projectId: appliedFilters.projectId ? Number(appliedFilters.projectId) : undefined,
          operatorId: appliedFilters.operatorId || undefined,
          status: appliedFilters.shiftStatus || undefined,
        }),
        metricsRequest,
        productV2Api.getAudit({
          projectId: appliedFilters.projectId ? Number(appliedFilters.projectId) : undefined,
          actorId: appliedFilters.operatorId || undefined,
          entityType: appliedFilters.entityType || undefined,
          action: appliedFilters.action || undefined,
        }),
      ]);
      setProjects(projectRows);
      setOperators(operatorRows);
      setShifts(shiftRows);
      setMetrics(metricResult.rows);
      setAudit(auditRows);
      if (metricResult.failed) {
        setError('No se pudieron cargar las métricas por operador. Los turnos y el historial sí se cargaron.');
      }
    } catch (loadError) {
      setError(adminErrorText(loadError, 'No se pudo cargar la operación.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [appliedFilters, reloadToken]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const saveForceClose = async () => {
    if (!forceClose) return;
    if (forceClose.reason.trim().length < 3) {
      setError('Indicá el motivo del cierre.');
      return;
    }
    setSavingForceClose(true);
    setError(null);
    setNotice(null);
    try {
      await shiftsApi.forceClose(forceClose.shiftId, forceClose.reason.trim());
      setNotice('Turno cerrado. El motivo quedó en el historial.');
      setForceClose(null);
      setReloadToken((value) => value + 1);
    } catch (closeError) {
      setError(adminErrorText(closeError, 'No se pudo cerrar el turno.'));
    } finally {
      setSavingForceClose(false);
    }
  };

  const correctionKey = `${correction.projectId}:${correction.entityType}:${correction.entityType === 'completion_reports' ? '' : correction.entityId.trim()}`;

  // Looks the record up inside the chosen well. A typed ID that is not in that
  // well is refused here, instead of corrected silently.
  useEffect(() => {
    let cancelled = false;
    const reference = correction.entityId.trim();
    const key = correctionKey;
    setCorrectionRecord(null);
    const needsReference = correction.entityType !== 'completion_reports';
    if (!correction.projectId || (needsReference && !reference)) {
      setCorrectionLookup('idle');
      return () => { cancelled = true; };
    }
    const wellFormed = correction.entityType === 'shifts'
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)
      : !needsReference || /^\d+$/.test(reference);
    if (!wellFormed) {
      setCorrectionLookup('missing');
      return () => { cancelled = true; };
    }
    setCorrectionLookup('loading');
    productV2Api
      .getCorrectionRecord(correction.entityType, Number(correction.projectId), reference)
      .then((record) => {
        if (cancelled) return;
        if (!record) {
          setCorrectionLookup('missing');
          return;
        }
        setCorrectionRecord({ key, record });
        setCorrectionLookup('ready');
      })
      .catch(() => {
        if (!cancelled) setCorrectionLookup('error');
      });
    return () => { cancelled = true; };
  }, [correctionKey, correction.entityType, correction.projectId, correction.entityId]);

  // Numbers are typed with a decimal comma on this phone; text stays text.
  const parseCorrectedValue = (fieldName: string, raw: string): Json => {
    const trimmed = raw.trim();
    if (NUMERIC_CORRECTION_FIELDS.has(fieldName)) {
      const normalized = trimmed.replace(',', '.');
      if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
        throw new Error('Ingresá un número. Podés usar coma decimal, por ejemplo 12,5.');
      }
      return Number(normalized);
    }
    try {
      return JSON.parse(trimmed) as Json;
    } catch {
      // Plain text is valid; JSON is only needed for structured fields.
      return trimmed;
    }
  };

  const saveCorrection = async () => {
    const needsReference = correction.entityType !== 'completion_reports';
    if (!correction.projectId || (needsReference && !correction.entityId.trim()) || !correction.fieldName || correction.reason.trim().length < 3 || !correction.value.trim()) {
      setError('Registro, campo, valor corregido y motivo son obligatorios.');
      return;
    }
    if (!correctionRecord || correctionRecord.key !== correctionKey || correctionLookup !== 'ready') {
      setError('Buscá el registro y revisá la vista previa antes de registrar la corrección.');
      return;
    }
    let correctedValue: Json;
    try {
      correctedValue = parseCorrectedValue(correction.fieldName, correction.value);
    } catch (parseError) {
      setError(adminErrorText(parseError, 'El valor corregido no es válido.'));
      return;
    }
    setSavingCorrection(true);
    setError(null);
    setNotice(null);
    try {
      await productV2Api.recordCorrection({
        entityType: correction.entityType,
        entityId: String(correctionRecord.record.id),
        fieldName: correction.fieldName,
        correctedValue,
        reason: correction.reason.trim(),
      });
      const preview = correctionPreview(correction.entityType, correctionRecord.record, correction.fieldName, correctedValue);
      setNotice(`Corrección registrada: ${preview.wellName} · ${preview.recordLabel}. El valor original permanece intacto y el dossier mostrará ambos.`);
      setCorrection((current) => ({ ...current, entityId: '', value: '', reason: '' }));
      setReloadToken((value) => value + 1);
    } catch (correctionError) {
      setError(adminErrorText(correctionError, 'No se pudo registrar la corrección.'));
    } finally {
      setSavingCorrection(false);
    }
  };

  const projectName = (projectId: number) =>
    projects.find((project) => project.id === projectId)?.name || `Proyecto #${projectId}`;
  const operatorById = (operatorId: string) => operators.find((operator) => operator.id === operatorId);

  return (
    <View style={styles.container}>
      <ScrollView
      keyboardDismissMode="on-drag"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={COLORS.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.toolbar}>
          <View style={styles.toolbarCopy}>
            <Text style={styles.title}>Operación</Text>
            <Text style={styles.subtitle}>{VIEWS.find((entry) => entry.key === view)?.blurb}</Text>
          </View>
          <TouchableOpacity style={styles.secondaryButton} disabled={loading} onPress={() => setReloadToken((value) => value + 1)}>
            <Text style={styles.secondaryButtonText}>{loading ? 'Actualizando…' : 'Actualizar'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.segment}>
          {VIEWS.map((entry) => (
            <TouchableOpacity
              key={entry.key}
              testID={`operation-view-${entry.key}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: view === entry.key }}
              style={[styles.segmentButton, view === entry.key && styles.segmentActive]}
              onPress={() => { animateNextLayout(); setView(entry.key); }}
            >
              <Text style={[styles.segmentText, view === entry.key && styles.segmentTextActive]}>{entry.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Suppressed while the correction modal is open: that modal repeats
            the banner, and showing both means the same error twice. */}
        {error && !showCorrection && <Text style={styles.errorBanner} accessibilityRole="alert">{error}</Text>}
        {notice && <Text style={styles.noticeBanner}>{notice}</Text>}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Filtros</Text>
          <Text style={styles.fieldLabel}>Proyecto</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={draftFilters.projectId} onValueChange={(projectId) => setDraftFilters((current) => ({ ...current, projectId }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
              <Picker.Item label="Todos los proyectos" value="" />
              {projects.map((project) => <Picker.Item key={project.id} label={project.name} value={String(project.id)} />)}
            </Picker>
          </View>
          <Text style={styles.fieldLabel}>Operador</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={draftFilters.operatorId} onValueChange={(operatorId) => setDraftFilters((current) => ({ ...current, operatorId }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
              <Picker.Item label="Todos los operadores" value="" />
              {operators.map((operator) => <Picker.Item key={operator.id} label={`${operatorName(operator)}${operator.is_active ? '' : ' (inactivo)'}`} value={operator.id} />)}
            </Picker>
          </View>
          {view === 'turnos' && (
            <>
              <Text style={styles.fieldLabel}>Estado del turno</Text>
              <View style={styles.pickerWrap}>
                <Picker selectedValue={draftFilters.shiftStatus} onValueChange={(shiftStatus) => setDraftFilters((current) => ({ ...current, shiftStatus }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
                  <Picker.Item label="Todos" value="" />
                  <Picker.Item label="Abierto" value="open" />
                  <Picker.Item label="Informe pendiente" value="report_pending" />
                  <Picker.Item label="Cerrado" value="closed" />
                </Picker>
              </View>
            </>
          )}
          {view === 'historial' && (
            <>
              <Text style={styles.fieldLabel}>Entidad</Text>
              <View style={styles.pickerWrap}>
                <Picker selectedValue={draftFilters.entityType} onValueChange={(entityType) => setDraftFilters((current) => ({ ...current, entityType }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
                  <Picker.Item label="Todas" value="" />
                  {ENTITY_TYPES.map((entity) => <Picker.Item key={entity} label={entityLabel(entity)} value={entity} />)}
                </Picker>
              </View>
              <Text style={styles.fieldLabel}>Acción</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={draftFilters.action} onChangeText={(action) => setDraftFilters((current) => ({ ...current, action }))} placeholder="ej: shift.closed" placeholderTextColor={COLORS.placeholder} />
            </>
          )}
          <View style={styles.actions}>
            <TouchableOpacity testID="operation-apply-filters" style={styles.primaryButton} onPress={() => setAppliedFilters({ ...draftFilters })}><Text style={styles.primaryButtonText}>Aplicar filtros</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => { setDraftFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS); }}><Text style={styles.secondaryButtonText}>Limpiar</Text></TouchableOpacity>
          </View>
        </View>

        {view === 'turnos' && (
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <View style={styles.toolbarCopy}>
              <Text style={styles.cardTitle}>Turnos</Text>
              <Text style={styles.subtitle}>{shifts.length} turno(s) según los filtros</Text>
            </View>
            <View style={styles.flagSummary}>
              <Text style={[styles.badge, styles.dangerBadge]}>{shifts.filter((shift) => shift.end_type === 'auto').length} autocierre(s)</Text>
              <Text style={[styles.badge, styles.warningBadge]}>{shifts.filter((shift) => shift.status !== 'open' && !shift.usage_report_submitted).length} informe(s) faltante(s)</Text>
            </View>
          </View>
          {loading && shifts.length === 0 ? (
            <View style={styles.centered}><ActivityIndicator color={COLORS.accent} /><Text style={styles.loadingText}>Cargando turnos…</Text></View>
          ) : shifts.length === 0 ? (
            <Text style={styles.emptyText}>No hay turnos para los filtros seleccionados.</Text>
          ) : shifts.map((shift) => {
            const flagged = (shift.shift_handovers || []).filter((handover) => handover.status === 'flagged');
            // A force-closed shift has its own badge: its report will never arrive.
            const reportOutstanding = shift.status !== 'open' && !shift.usage_report_submitted && shift.end_type !== 'admin';
            return (
              <View key={shift.id} style={styles.operationRow}>
                <View style={styles.rowHeader}>
                  <View style={styles.toolbarCopy}>
                    <Text style={styles.rowTitle}>{shift.projects?.name || projectName(shift.project_id)}</Text>
                    <Text style={styles.meta}>{shift.profiles?.full_name || shift.profiles?.username || operatorName(operatorById(shift.operator_id))}</Text>
                  </View>
                  <Text style={[
                    styles.badge,
                    shift.status === 'open' ? styles.activeBadge : shift.status === 'report_pending' ? styles.dangerBadge : styles.successBadge,
                  ]}>{shiftStatusLabel(shift.status)}</Text>
                </View>
                <Text style={styles.meta}>Inicio: {formatDateTime(shift.started_at)}</Text>
                <Text style={styles.meta}>Fin: {formatDateTime(shift.ended_at)} · Duración: {formatHours(shift.started_at, shift.ended_at)}</Text>
                <View style={styles.flagSummary}>
                  {shift.end_type === 'auto' && <Text style={[styles.badge, styles.dangerBadge]}>Cierre automático</Text>}
                  {shift.end_type === 'admin' && <Text style={[styles.badge, styles.dangerBadge]}>Cerrado por el administrador</Text>}
                  {shift.end_type === 'admin' && !shift.usage_report_submitted && <Text style={[styles.badge, styles.warningBadge]}>Sin informe de uso</Text>}
                  {reportOutstanding && <Text style={[styles.badge, styles.warningBadge]}>Informe pendiente</Text>}
                  <Text style={[styles.badge, shift.handover_confirmed ? styles.successBadge : styles.neutralBadge]}>{shift.handover_confirmed ? 'Entrega confirmada' : 'Entrega sin confirmar'}</Text>
                  {shift.device_time_flag && <Text style={[styles.badge, styles.warningBadge]}>Hora del dispositivo observada</Text>}
                  {shift.reassigned_during_shift && <Text style={[styles.badge, styles.warningBadge]}>Pozo reasignado durante el turno</Text>}
                  {flagged.length > 0 && <Text style={[styles.badge, styles.dangerBadge]}>{flagged.length} diferencia(s) en entrega</Text>}
                </View>
                {flagged.map((handover) => (
                  <Text key={handover.id} style={styles.handoverAlert}>
                    {handover.project_materials?.material_name || `Material #${handover.project_material_id}`}
                    {' · '}esperado {handover.expected_quantity} {handover.project_materials?.unit || ''}
                    {' · '}observado {handover.observed_quantity ?? '—'} {handover.project_materials?.unit || ''}
                    {handover.note ? ` · ${handover.note}` : ''}
                  </Text>
                ))}
                {shift.end_type === 'admin' && shift.notes ? <Text style={styles.auditReason}>Motivo: {shift.notes}</Text> : null}
                {shift.status !== 'closed' && forceClose?.shiftId !== shift.id ? (
                  <TouchableOpacity
                    testID={`force-close-${shift.id}`}
                    style={[styles.secondaryButton, styles.forceCloseButton]}
                    onPress={() => {
                      setError(null);
                      setForceClose({ shiftId: shift.id, reason: '' });
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>Cerrar turno</Text>
                  </TouchableOpacity>
                ) : null}
                {shift.status !== 'closed' && forceClose?.shiftId === shift.id ? (
                  <View style={styles.forceCloseForm}>
                    <Text style={styles.subtitle}>El turno se cierra sin informe de uso, y no se puede deshacer. Hacelo solo si el operador no puede cerrarlo.</Text>
                    {/* The banner at the top can be a long way up this list. */}
                    {error && <Text style={styles.errorBanner} accessibilityRole="alert">{error}</Text>}
                    <Text style={styles.fieldLabel}>Motivo obligatorio</Text>
                    <TextInput
                      testID="force-close-reason"
                      style={[styles.input, styles.textArea]}
                      value={forceClose.reason}
                      onChangeText={(reason) => setForceClose({ shiftId: shift.id, reason })}
                      multiline
                      placeholderTextColor={COLORS.placeholder}
                    />
                    <TouchableOpacity testID="force-close-confirm" style={[styles.dangerButtonLarge, savingForceClose && styles.disabled]} disabled={savingForceClose} onPress={() => void saveForceClose()}>
                      <Text style={styles.primaryButtonText}>{savingForceClose ? 'Cerrando…' : 'Confirmar cierre'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryButtonLarge} onPress={() => setForceClose(null)}>
                      <Text style={styles.secondaryButtonText}>Cancelar</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
        )}

        {view === 'cumplimiento' && (
        <View style={styles.sectionOutside}>
          <Text style={styles.title}>Responsabilidad por operador</Text>
          <Text style={styles.subtitle}>Métricas calculadas desde turnos, barras, reportes y pedidos</Text>
        </View>
        )}
        {view === 'cumplimiento' && (metrics.length === 0 && !loading ? (
          <View style={styles.card}><Text style={styles.emptyText}>No hay operadores para mostrar.</Text></View>
        ) : metrics.map((metric) => (
          <View style={styles.card} key={metric.operator_id}>
            <View style={styles.rowHeader}>
              <Text style={styles.cardTitle}>{operatorName(metric.operator)}</Text>
              <Text style={[styles.badge, metric.account_active ? styles.successBadge : styles.neutralBadge]}>{metric.account_active ? 'Activo' : 'Inactivo'}</Text>
            </View>
            <Text style={styles.meta}>Pozo actual: {metric.current_project?.name || '—'}</Text>
            <Text style={styles.meta}>Turno: {metric.current_shift ? shiftStatusLabel(metric.current_shift.status) : 'Sin turno abierto'}</Text>
            <View style={styles.metricsGrid}>
              {[
                [metric.shifts_completed, 'Turnos'],
                [metric.hours_worked, 'Horas'],
                [metric.bars_registered, 'Barras'],
                [metric.average_bar_minutes, 'Min/barra'],
                [metric.material_reports_submitted, 'Informes'],
                [metric.missing_or_late_reports, 'Faltantes/tarde'],
                [metric.flagged_shifts, 'Horario a revisar'],
                [metric.active_pedidos, 'Pedidos activos'],
              ].map(([value, label]) => (
                <View key={String(label)} style={[styles.metricBox, (label === 'Faltantes/tarde' || label === 'Horario a revisar') && Number(value) > 0 && styles.metricAlert]}>
                  <Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.meta}>Última actividad: {formatDateTime(metric.last_activity)}</Text>
          </View>
        )))}

        {view === 'historial' && (
        <Modal visible={showCorrection} animationType="slide" onRequestClose={() => setShowCorrection(false)}>
        <ScrollView
      keyboardDismissMode="on-drag" style={styles.modal} contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.cardTitle}>Corrección administrativa</Text>
          <Text style={styles.subtitle}>El registro original nunca se modifica. La corrección requiere motivo y aparece marcada en el dossier. Los totales calculados (profundidad de barras posteriores, stock de materiales y horas de turno) siguen usando el valor original.</Text>
          {/* The banner in the main scroll sits behind this modal, so validation
              has to be repeated here or it fails silently. */}
          {error && <Text style={styles.errorBanner} accessibilityRole="alert">{error}</Text>}
          <Text style={styles.fieldLabel}>Pozo</Text>
          <View style={styles.pickerWrap}>
            <Picker testID="correction-project" selectedValue={correction.projectId} onValueChange={(projectId: string) => setCorrection((current) => ({ ...current, projectId, entityId: current.entityType === 'shifts' ? '' : current.entityId }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
              <Picker.Item label="Elegí el pozo" value="" />
              {projects.map((project) => <Picker.Item key={project.id} label={project.name} value={String(project.id)} />)}
            </Picker>
          </View>
          <Text style={styles.fieldLabel}>Entidad</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={correction.entityType} onValueChange={(entityType: CorrectionEntity) => setCorrection((current) => ({ ...current, entityType, entityId: '', fieldName: CORRECTION_FIELDS[entityType][0] }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
              {(Object.keys(CORRECTION_FIELDS) as CorrectionEntity[]).map((entity) => <Picker.Item key={entity} label={entityLabel(entity)} value={entity} />)}
            </Picker>
          </View>
          {correction.entityType !== 'completion_reports' && (
            <>
              <Text style={styles.fieldLabel}>{CORRECTION_REFERENCE[correction.entityType].label}</Text>
              <TextInput
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss} testID="correction-entity-id" style={styles.input} value={correction.entityId} onChangeText={(entityId) => setCorrection((current) => ({ ...current, entityId }))} placeholder={CORRECTION_REFERENCE[correction.entityType].placeholder} placeholderTextColor={COLORS.placeholder} autoCapitalize="none" autoCorrect={false} />
            </>
          )}
          <Text style={styles.fieldLabel}>Campo</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={correction.fieldName} onValueChange={(fieldName) => setCorrection((current) => ({ ...current, fieldName }))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
              {CORRECTION_FIELDS[correction.entityType].map((field) => <Picker.Item key={field} label={fieldLabel(field)} value={field} />)}
            </Picker>
          </View>
          <Text style={styles.fieldLabel}>Valor corregido</Text>
          <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} testID="correction-value" style={styles.input} value={correction.value} onChangeText={(value) => setCorrection((current) => ({ ...current, value }))} placeholder={NUMERIC_CORRECTION_FIELDS.has(correction.fieldName) ? 'Número, por ejemplo 12,5' : 'Texto, número, true/false o JSON'} placeholderTextColor={COLORS.placeholder} />
          <Text style={styles.fieldLabel}>Motivo obligatorio</Text>
          <TextInput testID="correction-reason" style={[styles.input, styles.textArea]} value={correction.reason} onChangeText={(reason) => setCorrection((current) => ({ ...current, reason }))} multiline placeholderTextColor={COLORS.placeholder} />

          {correctionLookup === 'loading' && <Text style={styles.meta} accessibilityRole="progressbar">Buscando el registro…</Text>}
          {correctionLookup === 'missing' && <Text style={styles.errorBanner} accessibilityRole="alert">{CORRECTION_REFERENCE[correction.entityType].missing}</Text>}
          {correctionLookup === 'error' && <Text style={styles.errorBanner} accessibilityRole="alert">No se pudo buscar el registro. Intentá de nuevo.</Text>}
          {correctionLookup === 'ready' && correctionRecord && correctionRecord.key === correctionKey && (() => {
            let previewValue: unknown = correction.value.trim();
            try {
              previewValue = parseCorrectedValue(correction.fieldName, correction.value);
            } catch {
              previewValue = correction.value.trim();
            }
            const preview = correctionPreview(correction.entityType, correctionRecord.record, correction.fieldName, previewValue);
            return (
              <View testID="correction-preview" style={styles.card}>
                <Text style={styles.cardTitle}>{preview.wellName} · {preview.recordLabel}</Text>
                <Text style={styles.meta}>{fieldLabel(correction.fieldName)}: {preview.currentValue} → {correction.value.trim() ? preview.correctedValue : '—'}</Text>
              </View>
            );
          })()}

          <TouchableOpacity testID="operation-save-correction" style={[styles.dangerButtonLarge, savingCorrection && styles.disabled]} disabled={savingCorrection} onPress={() => void saveCorrection()}>
            <Text style={styles.primaryButtonText}>{savingCorrection ? 'Registrando…' : 'Registrar corrección'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButtonLarge} onPress={() => setShowCorrection(false)}>
            <Text style={styles.secondaryButtonText}>Cancelar</Text>
          </TouchableOpacity>
        </ScrollView>
        </Modal>
        )}

        {view === 'historial' && (
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <View style={styles.toolbarCopy}>
              <Text style={styles.cardTitle}>Historial del proyecto</Text>
              <Text style={styles.subtitle}>{audit.length} evento(s); el registro es append-only</Text>
            </View>
            <TouchableOpacity testID="operation-open-correction" style={styles.secondaryButton} onPress={() => setShowCorrection(true)}>
              <Text style={styles.secondaryButtonText}>Corregir</Text>
            </TouchableOpacity>
          </View>
          {loading && audit.length === 0 ? (
            <View style={styles.centered}><ActivityIndicator color={COLORS.accent} /><Text style={styles.loadingText}>Cargando historial…</Text></View>
          ) : audit.length === 0 ? (
            <Text style={styles.emptyText}>No hay eventos para los filtros seleccionados.</Text>
          ) : audit.map((entry) => (
            <View style={styles.auditEntry} key={entry.id}>
              <View style={styles.auditMarker} />
              <View style={styles.auditContent}>
                <View style={styles.rowHeader}>
                  <Text style={styles.rowTitle}>{auditActionLabel(entry.action)}</Text>
                  <Text style={styles.meta}>{formatDateTime(entry.created_at)}</Text>
                </View>
                {/* The row id stays: it is how an administrator refers to one
                    exact record when asking about it. Prefixed with the raw
                    table name it read as code; prefixed with the Spanish noun
                    it reads as a reference number. */}
                <Text style={styles.meta}>{entry.project_id ? projectName(entry.project_id) : 'Sin proyecto'} · {entityLabel(entry.entity_type)} #{entry.entity_id}</Text>
                <Text style={styles.meta}>Actor: {entry.profiles?.full_name || entry.profiles?.username || 'Sistema'}</Text>
                {entry.reason && <Text style={styles.auditReason}>Motivo: {entry.reason}</Text>}
              </View>
            </View>
          ))}
        </View>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  ...adminSharedStyles,
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.lg },
  activeBadge: { backgroundColor: STATUS.activeBg, color: STATUS.active },
  auditContent: { flex: 1 },
  auditEntry: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.lg },
  auditMarker: { backgroundColor: COLORS.accent, borderRadius: RADIUS.pill, height: 10, marginTop: SPACING.xs, width: 10 },
  auditReason: { backgroundColor: COLORS.surfaceVariant, borderRadius: RADIUS.sm, color: COLORS.textSecondary, marginTop: SPACING.sm, padding: SPACING.sm },
  badge: { borderRadius: RADIUS.pill, fontSize: TYPE.micro, fontWeight: TYPE.bold, overflow: 'hidden', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  card: { backgroundColor: COLORS.card, borderColor: COLORS.border, borderRadius: RADIUS.lg, borderWidth: 1, marginBottom: SPACING.lg, padding: SPACING.lg },
  cardTitle: { color: COLORS.text, flexShrink: 1, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  content: { padding: SPACING.lg, paddingBottom: SPACING.huge5 },
  dangerBadge: { backgroundColor: COLORS.errorBg, color: COLORS.errorText },
  dangerButtonLarge: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.error, borderRadius: RADIUS.md, marginTop: SPACING.lg, padding: SPACING.md },
  disabled: { opacity: 0.6 },
  emptyText: { color: COLORS.textSecondary, fontSize: TYPE.body, marginTop: SPACING.md, textAlign: 'center' },
  errorBanner: { backgroundColor: COLORS.errorBg, borderColor: COLORS.error, borderRadius: RADIUS.md, borderWidth: 1, color: COLORS.text, marginBottom: SPACING.md, padding: SPACING.md },
  fieldLabel: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.semibold, marginBottom: SPACING.xs, marginTop: SPACING.md },
  flagSummary: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginTop: SPACING.sm },
  forceCloseButton: { alignItems: 'center', marginTop: SPACING.md },
  forceCloseForm: { marginTop: SPACING.md },
  handoverAlert: { backgroundColor: COLORS.errorBg, borderColor: COLORS.error, borderRadius: RADIUS.sm, borderWidth: 1, color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.sm, padding: SPACING.sm },
  input: { backgroundColor: COLORS.input, borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, color: COLORS.text, fontSize: TYPE.body, minHeight: 48, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  loadingText: { color: COLORS.textSecondary, marginTop: SPACING.sm },
  meta: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs },
  metricAlert: { borderColor: COLORS.warning },
  metricBox: { backgroundColor: COLORS.surfaceVariant, borderColor: COLORS.borderLight, borderRadius: RADIUS.md, borderWidth: 1, minWidth: '29%', padding: SPACING.sm },
  metricLabel: { color: COLORS.textSecondary, fontSize: TYPE.micro, marginTop: SPACING.xs },
  metricValue: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginVertical: SPACING.md },
  neutralBadge: { backgroundColor: STATUS.neutralBg, color: STATUS.neutral },
  noticeBanner: { backgroundColor: COLORS.successBg, borderColor: COLORS.success, borderRadius: RADIUS.md, borderWidth: 1, color: COLORS.text, marginBottom: SPACING.md, padding: SPACING.md },
  operationRow: { borderTopColor: COLORS.border, borderTopWidth: 1, marginTop: SPACING.lg, paddingTop: SPACING.lg },
  picker: { color: COLORS.text },
  pickerWrap: { backgroundColor: COLORS.input, borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, overflow: 'hidden' },
  primaryButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md },
  primaryButtonText: { color: COLORS.textOnPrimary, fontSize: TYPE.label, fontWeight: TYPE.bold },
  rowHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: SPACING.sm, justifyContent: 'space-between' },
  rowTitle: { color: COLORS.text, flexShrink: 1, fontSize: TYPE.body, fontWeight: TYPE.bold },
  secondaryButton: { minHeight: 48, justifyContent: 'center', borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md },
  secondaryButtonText: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.semibold },
  secondaryButtonLarge: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, marginTop: SPACING.md, padding: SPACING.md },

  // View switcher. Matches the segment idiom already used in PedidosV2Tab so
  // the control reads the same wherever it appears.
  segment: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.lg },
  segmentButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, flex: 1, paddingVertical: SPACING.md },
  segmentActive: { backgroundColor: COLORS.primary, borderColor: COLORS.accent },
  segmentText: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.semibold },
  segmentTextActive: { color: COLORS.textOnPrimary },

  modal: { backgroundColor: COLORS.background, flex: 1 },
  modalContent: { padding: SPACING.xl, paddingBottom: SPACING.huge5, paddingTop: SPACING.huge3 },
  sectionHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: SPACING.md, justifyContent: 'space-between' },
  sectionOutside: { marginBottom: SPACING.md, marginTop: SPACING.sm },
  subtitle: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs },
  successBadge: { backgroundColor: COLORS.successBg, color: COLORS.successText },
  textArea: { minHeight: 90, textAlignVertical: 'top' },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  toolbar: { alignItems: 'flex-start', flexDirection: 'row', gap: SPACING.md, justifyContent: 'space-between', marginBottom: SPACING.lg },
  toolbarCopy: { flex: 1 },
  warningBadge: { backgroundColor: COLORS.warningBg, color: COLORS.warningText },
});

export default OperacionTab;
