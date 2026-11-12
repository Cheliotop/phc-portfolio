import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { query, queryFirst, runInTransaction } from '../../db/db';
import { createLocalDrillingBar } from '../../db/repositories/drillingBars';
import { loadAssignedProjects, refreshAssignedProjects } from '../../api/projectCache';
import { drainOutboxIncludingNew } from '../../sync/drainCoordinator';
import { readRecordSendState } from '../../sync/queueStatus';
import { cacheServerBars } from '../../sync/serverBarsCache';
import { createClientEntryId } from '../../utils/clientId';
import { formatQuantity, parseQuantity, quantityPreview, roundQuantity } from '../../utils/quantity';
import { isValidTime, calculateDuration } from '../../utils/time';
import PhotoCapture from '../shared/PhotoCapture';
import { removePhotoCopy } from '../../utils/photoStorage';
import { closedWellNotice } from './closedWellNotice';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { showSheet } from '../shared/Sheet';
import { storedDateOf } from '../../utils/dateFormat';

interface Project {
  id: string;
  name: string;
  location?: string;
  assigned_operator_id?: string;
  target_depth?: number | null;
  default_bar_length?: number | null;
  default_bar_diameter?: string | null;
  current_depth?: number | null;
  status?: string | null;
}

interface BarState {
  lastBarNumber: number;
  depthStart: number;
}

// A bar can be a rod of another length or the last partial run, but not a typo
// of metres (audit OPA-7).
const BAR_LENGTH_MIN = 0.5;
const BAR_LENGTH_MAX = 50;

const nowTime = () => new Date().toTimeString().slice(0, 5);

const SOIL_OPTIONS = ['Arena', 'Arena fina', 'Arcilla', 'Tierra', 'Grava', 'Roca', 'Mixto', 'Otro'];

const ProgresoTab = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [barState, setBarState] = useState<BarState>({
    lastBarNumber: 0,
    depthStart: 0,
  });
  const [lengthText, setLengthText] = useState('');
  const [diameter, setDiameter] = useState('');
  const [soilType, setSoilType] = useState('');
  const [soilChip, setSoilChip] = useState<string>('');
  // Empty until the operator starts this bar (first edit of the form), so a tab
  // opened at 07:05 does not stamp a bar that starts at 09:40 (audit OPA-8).
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [waterLevel, setWaterLevel] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [lastError, setLastError] = useState<string | null>(null);

  const selectedProjectData = useMemo(
    () => projects.find((project) => String(project.id) === String(selectedProject)),
    [projects, selectedProject],
  );

  const nextBarNumber = barState.lastBarNumber + 1;
  const defaultBarLength = Number(selectedProjectData?.default_bar_length || 3);
  const parsedLength = parseQuantity(lengthText);
  const plannedDepthEnd = parsedLength.ok === true ? roundQuantity(barState.depthStart + parsedLength.value) : null;

  // The operator has started filling this bar: a blank start time gets the
  // moment of the first edit. A time that is already there is kept.
  const touchForm = () => setStartTime((current) => current || nowTime());

  // Pass 3: assigned projects only (was leaking unassigned wells). Auto-select
  // when the operator has exactly one; keep an explicit selector only when they
  // have more than one assigned project.
  const applyAssignedProjects = useCallback((assigned: Project[]) => {
    setProjects(assigned);
    if (assigned.length === 1) {
      setSelectedProject((current) => current || String(assigned[0].id));
    } else if (assigned.length === 0) {
      setSelectedProject('');
    } else {
      setSelectedProject((current) =>
        assigned.some((p) => String(p.id) === String(current)) ? current : '',
      );
    }
  }, []);

  const loadProjects = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }
    setLastError(null);

    try {
      const operatorId = await AsyncStorage.getItem('operatorId');
      if (!operatorId) {
        setProjects([]);
        setLastError('No hay operador autenticado. Volvé a iniciar sesión.');
        return;
      }

      applyAssignedProjects((await loadAssignedProjects(operatorId, { activeOnly: true })) as Project[]);
      // The phone's own list goes on screen first; the server refresh below can
      // take 30 seconds or more on a link with no internet (code read O7).
      setLoading(false);
      const refreshed = await refreshAssignedProjects(operatorId, { activeOnly: true });
      applyAssignedProjects(refreshed as Project[]);
    } catch (error: any) {
      setLastError(error instanceof Error ? error.message : 'Error al cargar proyectos');
    } finally {
      setLoading(false);
    }
  }, [applyAssignedProjects]);

  const diameterDefaultedFor = useRef<string | null>(null);
  const lengthDefaultedFor = useRef<string | null>(null);
  // The latest save, so a background upload only updates the banner while that
  // save is still the last one on screen.
  const latestSave = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const showBarState = useCallback(async (projectId: string) => {
    const rows = await query<{ last_bar_number: number; current_depth: number }>(
      `SELECT
         COALESCE(MAX(bar_number), 0) as last_bar_number,
         COALESCE(MAX(depth_end), 0) as current_depth
       FROM drilling_bar_entries
       WHERE project_id = ?`,
      [projectId],
    );

    const fallbackRows = await query<{ current_depth: number }>(
      `SELECT COALESCE(MAX(depth_end), 0) as current_depth
       FROM progress_logs_dashboard
       WHERE project_id = ?`,
      [projectId],
    );

    const currentDepth = Number(rows[0]?.current_depth || fallbackRows[0]?.current_depth || 0);
    const lastBarNumber = Number(rows[0]?.last_bar_number || 0);
    const project = projects.find((item) => String(item.id) === String(projectId));
    const length = Number(project?.default_bar_length || 3);

    setBarState({
      lastBarNumber,
      depthStart: currentDepth,
    });
    // The well's default fills the length once per well, like the diameter below,
    // so a background refresh does not put the default back over a typed length.
    if (project && lengthDefaultedFor.current !== String(projectId)) {
      lengthDefaultedFor.current = String(projectId);
      setLengthText(formatQuantity(length));
    }
    // The well's default fills the field once per well. Every refresh rebuilds the
    // project list and reruns this, which used to put the default back over a
    // diameter the operator had typed, so the bar saved with the wrong one (code
    // read O4).
    if (project && diameterDefaultedFor.current !== String(projectId)) {
      diameterDefaultedFor.current = String(projectId);
      setDiameter(project.default_bar_diameter || '');
    }
  }, [projects]);

  const loadBarState = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }

    // Local numbers first, then again once the server's bars are mirrored, so the
    // form doesn't wait on the network (code read O7).
    await showBarState(projectId);
    await cacheServerBars(projectId);
    await showBarState(projectId);
  }, [showBarState]);


  useOperatorDataRefresh(() => loadProjects(false));

  useEffect(() => {
    if (selectedProject) {
      loadBarState(selectedProject).catch((error) => {
        setLastError(error instanceof Error ? error.message : 'Error al cargar barras');
      });
    }
  }, [selectedProject, loadBarState]);

  const selectSoil = (option: string) => {
    touchForm();
    setSoilChip(option);
    setSoilType(option === 'Otro' ? '' : option);
  };

  // After each saved bar the start time is "now" again, and the length goes back
  // to the well's default.
  const clearForm = () => {
    setSoilType('');
    setSoilChip('');
    setStartTime(nowTime());
    setEndTime('');
    setWaterLevel('');
    setNotes('');
    setPhotos([]);
    setLengthText(formatQuantity(defaultBarLength));
    setSyncMessage('');
  };

  const validateForm = () => {
    if (!selectedProject?.trim()) {
      showSheet('Error', 'Seleccioná un pozo asignado');
      return false;
    }

    if (!lengthText.trim()) {
      showSheet('Error', 'Ingresá la longitud de la barra');
      return false;
    }
    const length = parseQuantity(lengthText);
    if (length.ok === false) {
      showSheet('Longitud de barra', length.error);
      return false;
    }
    if (length.value < BAR_LENGTH_MIN || length.value > BAR_LENGTH_MAX) {
      showSheet('Longitud de barra', `La longitud debe estar entre ${formatQuantity(BAR_LENGTH_MIN)} y ${BAR_LENGTH_MAX} m.`);
      return false;
    }

    if (!startTime.trim()) {
      showSheet('Error', 'Ingresá la hora de inicio de la barra (o tocá "Ahora")');
      return false;
    }

    if (!soilType?.trim()) {
      showSheet('Error', 'Seleccioná o describí el tipo de suelo encontrado');
      return false;
    }

    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      showSheet('Error', 'Ingresá horas válidas en formato HH:MM (00:00–23:59)');
      return false;
    }

    const duration = calculateDuration(startTime, endTime);
    if (!duration) {
      showSheet('Error', 'La hora de término no puede ser igual a la de inicio');
      return false;
    }
    // Crossing midnight is real (23:50 to 00:10), but a bar never takes longer than a
    // shift. Reversed times (10:05 to 10:00) used to save as 1435 minutes (code read O5).
    if (duration > 12 * 60) {
      showSheet('Revisá las horas', `La hora de término (${endTime}) es anterior a la de inicio (${startTime}).`);
      return false;
    }

    // Checked here rather than left to the server: a bar saved offline with a
    // value the server refuses would only be rejected hours later, at sync.
    if (waterLevel.trim()) {
      const level = parseQuantity(waterLevel);
      if (level.ok === false) {
        showSheet('Error', `Nivel de agua: ${level.error}`);
        return false;
      }
    }

    return true;
  };

  const handleSaveProgress = async () => {
    if (!validateForm()) {
      return;
    }

    setSaving(true);
    setLastError(null);

    try {
      const operatorId = await AsyncStorage.getItem('operatorId');
      if (!operatorId) {
        throw new Error('No hay operador autenticado');
      }

      const id = createClientEntryId('bar');
      const timestamp = new Date().toISOString();
      const duration = calculateDuration(startTime, endTime);
      const length = parseQuantity(lengthText);
      if (length.ok === false) throw new Error(length.error);
      const waterParsed = waterLevel.trim() ? parseQuantity(waterLevel) : null;
      if (waterParsed?.ok === false) throw new Error(waterParsed.error);
      const barLength = length.value;
      const depthEnd = roundQuantity(barState.depthStart + barLength);
      const waterValue = waterParsed?.ok === true ? waterParsed.value : null;
      const activeShift = await queryFirst<{
        id: string;
        server_id?: string | null;
        project_id: number;
        status: string;
        handover_confirmed: number;
        usage_report_submitted: number;
        last_error?: string | null;
      }>(
        `SELECT id, server_id, project_id, status, handover_confirmed, usage_report_submitted, last_error
         FROM shifts
         WHERE project_id = ? AND status IN ('open', 'report_pending')
         ORDER BY started_at DESC LIMIT 1`,
        [Number(selectedProject)],
      );

      if (!activeShift) {
        throw new Error('Tenés que iniciar un turno antes de registrar progreso.');
      }
      if (String(activeShift.project_id) !== String(selectedProject)) {
        throw new Error('El turno activo pertenece a otro pozo. Finalizalo antes de cambiar de pozo.');
      }
      if (activeShift.status !== 'open') {
        throw new Error('Este turno requiere su informe final. No admite barras nuevas.');
      }
      // The close is queued but not yet on the server, so the status is still open.
      // A bar recorded now would fall outside the report the operator already sent
      // (code read O3).
      if (activeShift.usage_report_submitted) {
        throw new Error('Ya finalizaste este turno. No admite barras nuevas.');
      }
      if (!activeShift.handover_confirmed) {
        throw new Error('Confirmá el traspaso de materiales en la pestaña Turnos antes de registrar progreso.');
      }
      if (!activeShift.server_id
          && activeShift.last_error?.startsWith('Hay otro turno sin resolver en el servidor')) {
        throw new Error(activeShift.last_error || 'El turno tiene un conflicto de sincronización.');
      }

      const payload = {
        client_entry_id: id,
        project_id: Number(selectedProject),
        shift_id: activeShift.server_id || activeShift.id,
        bar_number: nextBarNumber,
        depth_start: barState.depthStart,
        depth_end: depthEnd,
        length: barLength,
        diameter: diameter || selectedProjectData?.default_bar_diameter || null,
        soil_type: soilType.trim(),
        start_time: startTime,
        end_time: endTime,
        duration_minutes: duration,
        water_level: waterValue,
        notes: notes.trim() || null,
        photo_paths: photos,
        timestamp_local: timestamp,
      };

      await runInTransaction(async (transaction) => {
        await createLocalDrillingBar({
          id,
          projectId: selectedProject,
          operatorId,
          shiftId: activeShift.id,
          barNumber: nextBarNumber,
          depthStart: barState.depthStart,
          depthEnd,
          length: barLength,
          diameter: payload.diameter,
          soilType: payload.soil_type,
          startTime,
          endTime,
          durationMinutes: duration,
          waterLevel: payload.water_level,
          notes: payload.notes,
          photoPaths: JSON.stringify(photos),
          timestampLocal: timestamp,
        }, transaction.execute);

        await transaction.execute(
          `INSERT INTO progress_logs_dashboard (
            project_id, operator_id, date, depth_start, depth_end, bars_added,
            bar_type, drilling_method, soil_type, water_level, notes,
            photo_paths, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, 'Rotary', ?, ?, ?, ?, ?, ?)`,
          [
            selectedProject, operatorId, storedDateOf(timestamp), barState.depthStart,
            depthEnd, `${formatQuantity(barLength)} metros`, payload.soil_type,
            payload.water_level, payload.notes, JSON.stringify(photos), timestamp, timestamp,
          ],
        );

        await transaction.execute(
          `INSERT INTO sync_outbox (
             id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'drilling_bar', ?, 'UPSERT', ?, ?, 0, ?, ?)`,
          [createClientEntryId('outbox'), id, JSON.stringify(payload), operatorId, timestamp, timestamp],
        );
      });

      // Saved on the phone, so the form is free now. The upload runs in the
      // background: offline, or on Wi-Fi with no internet, each request can wait 15
      // seconds before failing, and the operator was held on "Guardando..." for the
      // whole drain on every bar. The banner says what happened once it is known.
      await showBarState(selectedProject);
      clearForm();
      const successMessage = 'Barra guardada en este dispositivo. Se envía sola; el aviso de arriba dice cuándo llega.';
      setSyncMessage('Barra guardada en este dispositivo. Enviando…');
      const save = latestSave.current + 1;
      latestSave.current = save;
      // The shared drain, under its lock and in its order, rather than the bar step
      // alone (code read S5). Then this bar is judged by its own queue row.
      void drainOutboxIncludingNew()
        .catch(() => undefined)
        .then(() => readRecordSendState('drilling_bar', id))
        .then((sent) => {
          if (!mounted.current || latestSave.current !== save) return;
          setSyncMessage(sent.kind === 'sent'
            ? 'Barra guardada y sincronizada con el servidor.'
            : sent.kind === 'refused'
              ? 'Barra guardada en este dispositivo, pero el servidor no la aceptó. Pasa a revisión del administrador.'
              : 'Barra guardada en este dispositivo. Se envía sola cuando haya conexión.');
        })
        .catch(() => undefined);
      // The confirmation banner above renders at the top of the form while
      // the save button that was just pressed lives at the bottom, and a
      // scroll-to-top here proved unreliable (fights the focused input's own
      // "keep me visible" behavior on Android once clearForm() re-renders).
      // A successful save must never look identical to nothing happening —
      // that's exactly what drove real operators to re-submit and create
      // duplicate drilling_bar_entries — so an Alert (same mechanism the
      // error path below already uses reliably) is the real confirmation;
      // the banner is just a secondary, longer-lived reminder for anyone who
      // does scroll up.
      showSheet('Progreso guardado', successMessage);
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      showSheet('Error al guardar progreso', message);
    } finally {
      setSaving(false);
    }
  };

  const handlePhotoTaken = (uri: string) => {
    touchForm();
    setPhotos((current) => [...current, uri]);
  };

  // The photo was never saved with a bar, so its kept copy can go too (OPA-9).
  const handlePhotoRemoved = (uri: string) => {
    setPhotos((current) => current.filter((item) => item !== uri));
    void removePhotoCopy(uri).catch(() => undefined);
  };

  // "Limpiar formulario" asks first, because it also drops the bar's photos (OPA-9).
  const confirmClearForm = () => {
    const photoCount = photos.length;
    showSheet(
      'Limpiar formulario',
      photoCount > 0
        ? `Se borran los datos de esta barra y ${photoCount === 1 ? 'su foto' : `sus ${photoCount} fotos`}. ¿Seguro?`
        : 'Se borran los datos de esta barra. ¿Seguro?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sí, limpiar',
          style: 'destructive',
          onPress: () => {
            photos.forEach((uri) => { void removePhotoCopy(uri).catch(() => undefined); });
            clearForm();
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando progreso...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Registro de Progreso</Text>
        <Text style={styles.subtitle}>Registrá una sola barra física por vez.</Text>

        {lastError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{lastError}</Text>
            <TouchableOpacity style={styles.retryTouch} onPress={() => loadProjects()}>
              <Text style={styles.errorBannerRetry}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}

        {syncMessage ? (
          <View style={styles.successBanner}>
            <Text style={styles.successBannerText}>{syncMessage}</Text>
          </View>
        ) : null}

        {projects.length === 0 ? (
          <View style={styles.assignedCard}>
            <Text style={styles.assignedLabel}>POZO ASIGNADO</Text>
            <Text style={styles.assignedEmpty}>
              No tenés un pozo asignado. Hablá con el administrador.
            </Text>
          </View>
        ) : projects.length === 1 ? (
          <View style={styles.assignedCard}>
            <Text style={styles.assignedLabel}>POZO ASIGNADO</Text>
            <Text style={styles.assignedName}>
              {selectedProjectData?.name || projects[0].name}
              {selectedProjectData?.location ? ` · ${selectedProjectData.location}` : ''}
            </Text>
          </View>
        ) : (
          <View style={styles.formGroup}>
            <Text style={styles.label}>Pozo asignado *</Text>
            <View style={styles.pickerContainer}>
              <Picker
                selectedValue={selectedProject}
                style={styles.picker}
                onValueChange={(value) => setSelectedProject(String(value))}
                dropdownIconColor={COLORS.textSecondary}
              >
                <Picker.Item label="Seleccioná un pozo…" value="" />
                {projects.map((project) => (
                  <Picker.Item
                    key={String(project.id)}
                    label={`${project.name}${project.location ? ` - ${project.location}` : ''}`}
                    value={String(project.id)}
                  />
                ))}
              </Picker>
            </View>
          </View>
        )}

        {projects.length > 0 && closedWellNotice(selectedProjectData?.status) ? (
          <View style={styles.completedNotice}>
            <Text style={styles.completedNoticeTitle}>{closedWellNotice(selectedProjectData?.status)?.title}</Text>
            <Text style={styles.completedNoticeText}>
              {closedWellNotice(selectedProjectData?.status)?.text}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.summaryCard}>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Siguiente barra</Text>
                <Text style={styles.summaryValue}>#{nextBarNumber}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Profundidad inicial (m)</Text>
                <Text style={styles.summaryValue}>{barState.depthStart.toFixed(2)} m</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Profundidad final automática</Text>
                <Text style={styles.summaryValue}>{plannedDepthEnd === null ? '—' : `${plannedDepthEnd.toFixed(2)} m`}</Text>
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Longitud de esta barra (m) *</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                style={styles.input}
                value={lengthText}
                onChangeText={(value) => { touchForm(); setLengthText(value); }}
                placeholder={formatQuantity(defaultBarLength)}
                placeholderTextColor={COLORS.placeholder}
                keyboardType="decimal-pad"
              />
              {quantityPreview(lengthText) ? <Text style={styles.hint}>{quantityPreview(lengthText)}</Text> : null}
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Diámetro</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                style={styles.input}
                value={diameter}
                onChangeText={(value) => { touchForm(); setDiameter(value); }}
                placeholder="Ej: 6 pulgadas"
                placeholderTextColor={COLORS.placeholder}
              />
            </View>

            <View style={styles.row}>
              <View style={styles.halfWidth}>
                <Text style={styles.label}>Inicio *</Text>
                <View style={styles.timeRow}>
                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                    style={[styles.input, styles.timeInput]}
                    value={startTime}
                    onChangeText={setStartTime}
                    placeholder="HH:MM"
                    placeholderTextColor={COLORS.placeholder}
                  />
                  <TouchableOpacity style={styles.nowButton} onPress={() => setStartTime(nowTime())}>
                    <Text style={styles.nowButtonText}>Ahora</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.halfWidth}>
                <Text style={styles.label}>Término *</Text>
                <View style={styles.timeRow}>
                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                    style={[styles.input, styles.timeInput]}
                    value={endTime}
                    onChangeText={setEndTime}
                    placeholder="HH:MM"
                    placeholderTextColor={COLORS.placeholder}
                  />
                  <TouchableOpacity style={styles.nowButton} onPress={() => setEndTime(nowTime())}>
                    <Text style={styles.nowButtonText}>Ahora</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Tipo de Suelo Encontrado *</Text>
              <View style={styles.chipRow}>
                {SOIL_OPTIONS.map((option) => {
                  const active = soilChip === option;
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => selectSoil(option)}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{option}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {soilChip === 'Otro' || (soilChip === '' && soilType !== '') ? (
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                  style={[styles.input, { marginTop: SPACING.md }]}
                  value={soilType}
                  onChangeText={(value) => { touchForm(); setSoilType(value); }}
                  placeholder="Describí el tipo de suelo"
                  placeholderTextColor={COLORS.placeholder}
                />
              ) : null}
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Nivel de Agua (m) - Opcional</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                style={styles.input}
                value={waterLevel}
                onChangeText={(value) => { touchForm(); setWaterLevel(value); }}
                placeholder="Profundidad del agua"
                placeholderTextColor={COLORS.placeholder}
                keyboardType="numeric"
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Notas Adicionales</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={notes}
                onChangeText={(value) => { touchForm(); setNotes(value); }}
                placeholder="Observaciones, problemas encontrados, etc."
                placeholderTextColor={COLORS.placeholder}
                multiline
                numberOfLines={3}
              />
            </View>

            <PhotoCapture onPhotoTaken={handlePhotoTaken} onPhotoRemoved={handlePhotoRemoved} photos={photos} maxPhotos={5} />

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.saveButton, saving && styles.saveButtonDisabled]}
                onPress={handleSaveProgress}
                disabled={saving}
              >
                <Text style={styles.saveButtonText}>
                  {saving ? 'Guardando...' : 'Guardar Progreso'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.cancelButton} onPress={confirmClearForm}>
                <Text style={styles.cancelButtonText}>Limpiar Formulario</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        <View style={styles.spacer} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
    padding: SPACING.xl,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  title: {
    fontSize: TYPE.h1,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xxl,
  },
  formGroup: {
    marginBottom: SPACING.xl,
  },
  label: {
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
  input: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    fontSize: TYPE.bodyLg,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  textArea: {
    height: 88,
    textAlignVertical: 'top',
  },
  pickerContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  assignedCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.accent,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.xl,
  },
  assignedLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.micro,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: SPACING.xs,
  },
  assignedName: { color: COLORS.text, fontSize: TYPE.bodyLg, fontWeight: '700' },
  assignedEmpty: { color: COLORS.textSecondary, fontSize: TYPE.label, lineHeight: 20 },
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
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: { minHeight: 48, justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.input,
  },
  chipActive: { backgroundColor: 'rgba(78,134,216,0.16)', borderColor: COLORS.accent },
  chipText: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: '600' },
  chipTextActive: { color: COLORS.primaryText },
  picker: {
    color: COLORS.text,
    height: 52,
  },
  summaryCard: {
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  summaryLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    flex: 1,
    marginRight: SPACING.md,
  },
  summaryValue: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.xl,
  },
  halfWidth: {
    width: '48%',
  },
  timeRow: {
    gap: SPACING.sm,
  },
  timeInput: {
    paddingHorizontal: SPACING.md,
  },
  nowButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  nowButtonText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
  buttonContainer: {
    marginTop: SPACING.xl,
  },
  saveButton: {
    backgroundColor: COLORS.success,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  saveButtonDisabled: {
    backgroundColor: COLORS.neutral,
  },
  saveButtonText: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  cancelButton: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cancelButtonText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.textSecondary,
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
  errorBannerText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    flex: 1,
  },
  hint: { color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.sm },
  retryTouch: { minHeight: 48, justifyContent: 'center' },
  errorBannerRetry: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
    textDecorationLine: 'underline',
  },
  successBanner: {
    backgroundColor: COLORS.successBg,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.lg,
  },
  successBannerText: {
    color: COLORS.text,
    fontSize: TYPE.label,
  },
  spacer: {
    height: 40,
  },
});

export default ProgresoTab;
