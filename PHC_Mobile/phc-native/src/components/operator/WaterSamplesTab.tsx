import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { waterSamplesApi } from '../../api/supabase-water-samples';
import {
  loadAssignedProjects,
  refreshAssignedProjects,
  type AssignedProject,
} from '../../api/projectCache';
import { query, queryFirst, runInTransaction } from '../../db/db';
import { drainOutbox, drainOutboxIncludingNew } from '../../sync/drainCoordinator';
import { operatorErrorText } from '../../utils/errorMessage';
import { createLocalWaterSample } from '../../db/repositories/waterSamples';
import type { WaterSample } from '../../types/productV2';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { createClientEntryId } from '../../utils/clientId';
import { formatDisplayDateTime } from '../../utils/dateFormat';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import PhotoCapture from '../shared/PhotoCapture';
import { showSheet } from '../shared/Sheet';

type StageChoice = '' | 'perforacion' | 'ensanche' | 'prueba_bombeo' | 'otro';

interface LocalSampleRow {
  id: string;
  server_id?: number | null;
  client_entry_id?: string | null;
  project_id: string | number;
  sample_number: number;
  depth_m?: number | null;
  stage?: string | null;
  notes?: string | null;
  bottle_photo_path?: string | null;
  taken_at: string;
  timestamp_local?: string | null;
  device_time_flag?: number | null;
  sync_status: string;
  last_error?: string | null;
  project_name?: string | null;
  local_photo_uri?: string | null;
}

interface DisplaySample {
  key: string;
  serverId?: number;
  clientEntryId?: string;
  projectId: number;
  projectName: string;
  sampleNumber: number;
  depthM?: number | null;
  stage?: string | null;
  notes?: string | null;
  takenAt: string;
  bottlePhotoPath?: string | null;
  localPhotoUri?: string | null;
  deviceTimeFlag: boolean;
  syncStatus: 'synced' | 'pending' | 'failed';
}

const SAMPLE_MAX_CACHE_PREFIX = 'phc:water-sample-max:';

const STAGE_LABELS: Record<Exclude<StageChoice, 'otro'>, string> = {
  '': 'Sin especificar',
  perforacion: 'Perforación',
  ensanche: 'Ensanche',
  prueba_bombeo: 'Prueba de bombeo',
};

const normalizeNumber = (raw: string): number | null => {
  const value = raw.trim().replace(',', '.');
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

// The release build runs on JavaScriptCore without full ICU, which ignores the
// locale and returns English. formatDisplayDateTime needs no locale data.
const formatDateTime = (value: string): string => {
  const formatted = formatDisplayDateTime(value);
  return formatted === '—' ? 'Fecha no disponible' : formatted;
};

const statusPresentation = (status: DisplaySample['syncStatus']) => {
  if (status === 'synced') {
    return { label: 'Sincronizada', color: COLORS.successText, background: COLORS.successBg };
  }
  if (status === 'failed') {
    return { label: 'Guardada · reintento pendiente', color: COLORS.warningText, background: COLORS.warningBg };
  }
  return { label: 'Guardada en este dispositivo', color: COLORS.primaryText, background: 'rgba(78,134,216,0.16)' };
};

const WaterSamplesTab = () => {
  const [operatorId, setOperatorId] = useState('');
  const [projects, setProjects] = useState<AssignedProject[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [samples, setSamples] = useState<DisplaySample[]>([]);
  const [maxByProject, setMaxByProject] = useState<Record<string, number>>({});
  const [depth, setDepth] = useState('');
  const [stageChoice, setStageChoice] = useState<StageChoice>('');
  const [customStage, setCustomStage] = useState('');
  const [notes, setNotes] = useState('');
  const [bottlePhotoUri, setBottlePhotoUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);

  const loadLocalSamples = useCallback(async (
    userId: string,
    activeProjects: AssignedProject[],
  ): Promise<LocalSampleRow[]> => {
    if (!activeProjects.length) {
      return [];
    }
    const placeholders = activeProjects.map(() => '?').join(', ');
    return query<LocalSampleRow>(
      `SELECT ws.*,
              p.name AS project_name,
              (SELECT pa.local_uri
                 FROM project_attachments pa
                WHERE pa.water_sample_id = ws.id
                  AND pa.local_uri IS NOT NULL
                ORDER BY pa.created_at DESC
                LIMIT 1) AS local_photo_uri
         FROM water_samples ws
         JOIN projects p ON p.id = ws.project_id
        WHERE ws.operator_id = ?
          AND ws.project_id IN (${placeholders})
        ORDER BY ws.taken_at DESC, ws.sample_number DESC`,
      [userId, ...activeProjects.map((project) => project.id)],
    );
  }, []);

  const readCachedMaxima = useCallback(async (activeProjects: AssignedProject[]) => {
    const pairs = await AsyncStorage.multiGet(
      activeProjects.map((project) => `${SAMPLE_MAX_CACHE_PREFIX}${project.id}`),
    );
    const result: Record<string, number> = {};
    pairs.forEach(([key, raw]) => {
      const projectId = key.slice(SAMPLE_MAX_CACHE_PREFIX.length);
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed > 0) {
        result[projectId] = parsed;
      }
    });
    return result;
  }, []);

  /** Merge the phone's samples with the server's, if it answered, and show them. */
  const present = useCallback(async (
    userId: string,
    activeProjects: AssignedProject[],
    remoteRows: WaterSample[],
    remoteAvailable: boolean,
  ) => {
    const localRows = await loadLocalSamples(userId, activeProjects);
    const allowedProjects = new Map(
      activeProjects.map((project) => [Number(project.id), project.name]),
    );

    const remoteDisplay: DisplaySample[] = remoteRows.map((sample) => {
      const related = sample as WaterSample & {
        projects?: { name?: string | null } | null;
      };
      return {
        key: `server_${sample.id}`,
        serverId: sample.id,
        clientEntryId: sample.client_entry_id ?? undefined,
        projectId: Number(sample.project_id),
        projectName: related.projects?.name || allowedProjects.get(Number(sample.project_id)) || `Pozo #${sample.project_id}`,
        sampleNumber: Number(sample.sample_number),
        depthM: sample.depth_m,
        stage: sample.stage,
        notes: sample.notes,
        takenAt: sample.taken_at,
        bottlePhotoPath: sample.bottle_photo_path,
        deviceTimeFlag: Boolean(sample.device_time_flag),
        syncStatus: 'synced',
      };
    });

    const remoteServerIds = new Set(remoteDisplay.map((sample) => sample.serverId));
    const remoteClientIds = new Set(
      remoteDisplay.map((sample) => sample.clientEntryId).filter(Boolean),
    );
    const localDisplay: DisplaySample[] = localRows
      .filter((sample) => {
        if (!remoteAvailable) {
          return true;
        }
        if (sample.server_id && remoteServerIds.has(Number(sample.server_id))) {
          return false;
        }
        if (sample.client_entry_id && remoteClientIds.has(sample.client_entry_id)) {
          return false;
        }
        return true;
      })
      .map((sample) => ({
        key: `local_${sample.id}`,
        serverId: sample.server_id ? Number(sample.server_id) : undefined,
        clientEntryId: sample.client_entry_id ?? undefined,
        projectId: Number(sample.project_id),
        projectName: sample.project_name || allowedProjects.get(Number(sample.project_id)) || `Pozo #${sample.project_id}`,
        sampleNumber: Number(sample.sample_number),
        depthM: sample.depth_m,
        stage: sample.stage,
        notes: sample.notes,
        takenAt: sample.taken_at,
        bottlePhotoPath: sample.bottle_photo_path,
        localPhotoUri: sample.local_photo_uri,
        deviceTimeFlag: Boolean(sample.device_time_flag),
        syncStatus: sample.sync_status === 'synced'
          ? 'synced'
          : sample.sync_status === 'failed'
            ? 'failed'
            : 'pending',
      }));

    const merged = [...remoteDisplay, ...localDisplay]
      .sort((left, right) => right.takenAt.localeCompare(left.takenAt));
    setSamples(merged);

    const cachedMaxima = await readCachedMaxima(activeProjects);
    const nextMaxima = { ...cachedMaxima };
    [...localRows.map((sample) => ({ projectId: sample.project_id, number: sample.sample_number })),
      ...remoteRows.map((sample) => ({ projectId: sample.project_id, number: sample.sample_number }))]
      .forEach(({ projectId, number }) => {
        const key = String(projectId);
        nextMaxima[key] = Math.max(nextMaxima[key] || 0, Number(number) || 0);
      });
    setMaxByProject(nextMaxima);
    const maximumEntries: [string, string][] = Object.entries(nextMaxima).map(([projectId, value]) => [
        `${SAMPLE_MAX_CACHE_PREFIX}${projectId}`,
        String(value),
      ]);
    if (maximumEntries.length) {
      await AsyncStorage.multiSet(maximumEntries);
    }
  }, [loadLocalSamples, readCachedMaxima]);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }
    setError('');

    try {
      const userId = await AsyncStorage.getItem('operatorId');
      if (!userId) {
        throw new Error('No hay un operador autenticado. Volvé a iniciar sesión.');
      }
      setOperatorId(userId);

      const applyProjects = (activeProjects: AssignedProject[]) => {
        setProjects(activeProjects);
        setSelectedProject((current) => {
          if (activeProjects.some((project) => String(project.id) === current)) {
            return current;
          }
          return activeProjects.length === 1 ? String(activeProjects[0].id) : '';
        });
      };

      // The phone's wells and samples go on screen first; the server refresh
      // below can take 30 seconds or more with no internet (code read O7). A
      // phone with no wells yet keeps waiting on the server.
      const localProjects = await loadAssignedProjects(userId, { activeOnly: true });
      if (localProjects.length) {
        applyProjects(localProjects);
        await present(userId, localProjects, [], false);
        setLoading(false);
      }

      const activeProjects = await refreshAssignedProjects(userId, { activeOnly: true });
      applyProjects(activeProjects);

      const allowedProjects = new Map(
        activeProjects.map((project) => [Number(project.id), project.name]),
      );
      let remoteRows: WaterSample[] = [];
      let remoteAvailable = false;
      if (activeProjects.length) {
        try {
          const response = await waterSamplesApi.getAll();
          remoteRows = response.filter((sample) => allowedProjects.has(Number(sample.project_id)));
          remoteAvailable = true;
        } catch (remoteError) {
          console.warn('[PHC] Water samples refresh unavailable; using device records:', remoteError);
        }
      }
      await present(userId, activeProjects, remoteRows, remoteAvailable);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar las muestras.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [present]);


  useOperatorDataRefresh(() => load(false));

  const selectedProjectRecord = useMemo(
    () => projects.find((project) => String(project.id) === selectedProject),
    [projects, selectedProject],
  );

  const previewSampleNumber = selectedProject
    ? (maxByProject[selectedProject] || 0) + 1
    : null;

  const resetForm = () => {
    setDepth('');
    setStageChoice('');
    setCustomStage('');
    setNotes('');
    setBottlePhotoUri(null);
  };

  const saveSample = async () => {
    if (savingRef.current) {
      return;
    }
    if (!operatorId) {
      showSheet('Sesión requerida', 'Volvé a iniciar sesión antes de registrar una muestra.');
      return;
    }
    if (!selectedProjectRecord) {
      showSheet('Falta el pozo', 'Seleccioná uno de tus pozos activos.');
      return;
    }

    const parsedDepth = normalizeNumber(depth);
    if (parsedDepth !== null && (!Number.isFinite(parsedDepth) || parsedDepth < 0)) {
      showSheet('Profundidad inválida', 'Ingresá una profundidad positiva o dejá el campo vacío.');
      return;
    }
    if (parsedDepth !== null && parsedDepth > 10000) {
      showSheet('Revisá la profundidad', 'La profundidad no puede superar 10.000 metros.');
      return;
    }

    const stage = stageChoice === 'otro'
      ? customStage.trim()
      : stageChoice
        ? STAGE_LABELS[stageChoice]
        : '';
    if (stageChoice === 'otro' && stage.length < 2) {
      showSheet('Falta la etapa', 'Escribí la etapa o seleccioná una opción de la lista.');
      return;
    }
    if (stage.length > 100) {
      showSheet('Etapa demasiado larga', 'Usá hasta 100 caracteres para la etapa.');
      return;
    }
    const trimmedNotes = notes.trim();
    if (trimmedNotes.length > 1000) {
      showSheet('Notas demasiado largas', 'Usá hasta 1.000 caracteres para las notas.');
      return;
    }

    savingRef.current = true;
    setSaving(true);
    const localId = createClientEntryId('water_sample_local');
    const clientEntryId = createClientEntryId('water_sample');
    const attachmentId = createClientEntryId('water_sample_photo');
    const outboxId = createClientEntryId('outbox_water_sample');
    const takenAt = new Date().toISOString();
    const projectId = Number(selectedProjectRecord.id);
    let assignedNumber = 0;

    try {
      await runInTransaction(async (transaction) => {
        const current = await transaction.queryFirst<{ maximum: number | null }>(
          'SELECT MAX(sample_number) AS maximum FROM water_samples WHERE project_id = ?',
          [projectId],
        );
        assignedNumber = Math.max(
          Number(current?.maximum || 0),
          Number(maxByProject[String(projectId)] || 0),
        ) + 1;

        await createLocalWaterSample({
          id: localId,
          clientEntryId,
          projectId,
          sampleNumber: assignedNumber,
          depthM: parsedDepth,
          stage: stage || null,
          operatorId,
          notes: trimmedNotes || null,
          takenAt,
        }, transaction.execute);

        if (bottlePhotoUri) {
          const filename = bottlePhotoUri.split('?')[0].split('/').pop() || `${attachmentId}.jpg`;
          // The local attachment row preserves the captured file alongside its
          // parent sample. Server-side, bottle photos intentionally remain on
          // water_samples.bottle_photo_path (generic project attachments are
          // reserved for admin-uploaded lab analyses and other documents).
          await transaction.execute(
            `INSERT INTO project_attachments (
               id, client_entry_id, project_id, water_sample_id, kind,
               storage_path, local_uri, filename, mime_type, notes,
               uploaded_by, uploaded_at, sync_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'otro', NULL, ?, ?, 'image/jpeg', ?, ?, ?, 'pending', ?, ?)`,
            [
              attachmentId,
              `${clientEntryId}-bottle`,
              projectId,
              localId,
              bottlePhotoUri,
              filename,
              'Foto de botella asociada a la muestra de agua',
              operatorId,
              takenAt,
              takenAt,
              takenAt,
            ],
          );
        }

        await transaction.execute(
          `INSERT INTO sync_outbox (
             id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'water_sample', ?, 'create', ?, ?, 0, ?, ?)`,
          [
            outboxId,
            localId,
            JSON.stringify({
              clientEntryId,
              projectId,
              takenAt,
              depthM: parsedDepth ?? undefined,
              stage: stage || undefined,
              notes: trimmedNotes || undefined,
              bottlePhotoLocalUri: bottlePhotoUri || undefined,
              timestampLocal: takenAt,
              // The device number is only a useful offline label. Omitting
              // sampleNumber lets the RPC assign the next canonical number
              // under its project lock, avoiding collisions across devices.
            }),
            operatorId,
            takenAt,
            takenAt,
          ],
        );
      });

      await AsyncStorage.setItem(
        `${SAMPLE_MAX_CACHE_PREFIX}${projectId}`,
        String(assignedNumber),
      );
      setMaxByProject((current) => ({
        ...current,
        [String(projectId)]: Math.max(current[String(projectId)] || 0, assignedNumber),
      }));
      resetForm();

      // The shared drain, under its lock, rather than the sample step alone.
      await drainOutboxIncludingNew().catch((syncError) => {
        console.warn('[PHC] Water sample saved locally; immediate sync unavailable:', syncError);
      });
      // Judge this sample by its own queue row. The step's totals covered every
      // waiting sample, so with no signal the operator always read "no se pudo
      // subir", and a newer sample was blamed for an older one (code read O10).
      const queued = await queryFirst<{ state: string | null; last_error: string | null }>(
        `SELECT state, last_error FROM sync_outbox WHERE entity = 'water_sample' AND entity_id = ?`,
        [localId],
      );
      const savedRow = await query<{ sample_number: number }>(
        'SELECT sample_number FROM water_samples WHERE id = ? LIMIT 1',
        [localId],
      );
      const confirmedNumber = Number(savedRow[0]?.sample_number || assignedNumber);
      await load(false);

      if (!queued) {
        showSheet('Muestra registrada', `La muestra #${confirmedNumber} quedó sincronizada.`);
      } else if (queued.state === 'quarantined') {
        // Refused by the server, not offline: name the real reason instead of
        // promising a sync that will not happen.
        const detail = operatorErrorText(queued.last_error) || 'el servidor rechazó la muestra';
        showSheet(
          'Muestra guardada, sin subir',
          `La muestra #${confirmedNumber} quedó guardada en este dispositivo, pero el servidor no la aceptó: ${detail.replace(/\.$/, '')}. Pasa a revisión del administrador.`,
        );
      } else {
        showSheet(
          'Muestra guardada',
          `La muestra #${confirmedNumber} quedó guardada en este dispositivo y se envía sola cuando haya conexión.`,
        );
      }
    } catch (saveError) {
      console.error('[PHC] Could not save water sample:', saveError);
      showSheet(
        'No se pudo guardar',
        saveError instanceof Error ? saveError.message : 'Intentá de nuevo.',
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Cargando muestras de agua…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      keyboardDismissMode="on-drag"
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={(
        <RefreshControl
          refreshing={refreshing}
          tintColor={COLORS.accent}
          onRefresh={() => {
            setRefreshing(true);
            drainOutbox()
              .catch((syncError) => console.warn('[PHC] Water sample retry unavailable:', syncError))
              .finally(() => load(false));
          }}
        />
      )}
    >
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.title}>Muestras de agua</Text>
          <Text style={styles.subtitle}>Registro de campo por pozo</Text>
        </View>
        <View style={styles.freeBadge}>
          <Text style={styles.freeBadgeText}>LIBRE</Text>
        </View>
      </View>

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Registro libre, sin recordatorios</Text>
        <Text style={styles.infoText}>
          Registrá una muestra cuando corresponda en campo. La etapa es opcional y este registro no bloquea el cierre del pozo.
        </Text>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.inlineButton} onPress={() => load()}>
            <Text style={styles.inlineButtonText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!projects.length ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Sin pozos activos asignados</Text>
          <Text style={styles.emptyText}>
            Cuando el administrador te asigne un pozo activo, podrás registrar sus muestras aquí.
          </Text>
        </View>
      ) : (
        <View style={styles.formCard}>
          <Text style={styles.sectionTitle}>Nueva muestra</Text>

          <Text style={styles.label}>Pozo activo *</Text>
          <View style={styles.pickerWrapper}>
            <Picker
              selectedValue={selectedProject}
              onValueChange={(value) => setSelectedProject(String(value))}
              style={styles.picker}
              dropdownIconColor={COLORS.text}
            >
              <Picker.Item label="Seleccionar pozo…" value="" />
              {projects.map((project) => (
                <Picker.Item
                  key={project.id}
                  label={project.location ? `${project.name} · ${project.location}` : project.name}
                  value={String(project.id)}
                />
              ))}
            </Picker>
          </View>

          {previewSampleNumber ? (
            <Text style={styles.sequenceHint}>
              Próximo número local: #{previewSampleNumber}. El servidor confirmará la secuencia al sincronizar.
            </Text>
          ) : null}

          <Text style={styles.label}>Profundidad (m, opcional)</Text>
          <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
            style={styles.input}
            value={depth}
            onChangeText={setDepth}
            keyboardType="decimal-pad"
            placeholder="Ej.: 85,5"
            placeholderTextColor={COLORS.placeholder}
            maxLength={10}
          />

          <Text style={styles.label}>Etapa (opcional)</Text>
          <View style={styles.pickerWrapper}>
            <Picker
              selectedValue={stageChoice}
              onValueChange={(value) => setStageChoice(value as StageChoice)}
              style={styles.picker}
              dropdownIconColor={COLORS.text}
            >
              <Picker.Item label="Sin especificar" value="" />
              <Picker.Item label="Perforación" value="perforacion" />
              <Picker.Item label="Ensanche" value="ensanche" />
              <Picker.Item label="Prueba de bombeo" value="prueba_bombeo" />
              <Picker.Item label="Otra etapa…" value="otro" />
            </Picker>
          </View>
          {stageChoice === 'otro' ? (
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
              style={styles.input}
              value={customStage}
              onChangeText={setCustomStage}
              placeholder="Describí la etapa"
              placeholderTextColor={COLORS.placeholder}
              maxLength={100}
            />
          ) : null}

          <Text style={styles.label}>Notas (opcional)</Text>
          <TextInput
            style={[styles.input, styles.notesInput]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Aspecto, color, punto de toma u otra observación"
            placeholderTextColor={COLORS.placeholder}
            multiline
            textAlignVertical="top"
            maxLength={1000}
          />
          <Text style={styles.characterCount}>{notes.length}/1000</Text>

          <Text style={styles.label}>Foto de la botella (opcional)</Text>
          <PhotoCapture
            photos={bottlePhotoUri ? [bottlePhotoUri] : []}
            maxPhotos={1}
            onPhotoTaken={setBottlePhotoUri}
            onPhotoRemoved={() => setBottlePhotoUri(null)}
          />
          {bottlePhotoUri ? (
            <TouchableOpacity style={styles.removePhotoButton} onPress={() => setBottlePhotoUri(null)}>
              <Text style={styles.removePhotoText}>Quitar foto</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            style={[styles.primaryButton, saving && styles.disabledButton]}
            onPress={saveSample}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={COLORS.textOnPrimary} />
            ) : (
              <Text style={styles.primaryButtonText}>Guardar muestra</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.offlineHint}>
            Funciona sin conexión. La muestra y su foto quedan guardadas juntas antes de intentar sincronizar.
          </Text>
        </View>
      )}

      <View style={styles.listHeader}>
        <Text style={styles.sectionTitle}>Muestras registradas</Text>
        <Text style={styles.countText}>{samples.length}</Text>
      </View>

      {!samples.length ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Todavía no hay muestras</Text>
          <Text style={styles.emptyText}>Los registros del dispositivo y del servidor aparecerán aquí.</Text>
        </View>
      ) : samples.map((sample) => {
        const status = statusPresentation(sample.syncStatus);
        return (
          <View key={sample.key} style={styles.sampleCard}>
            <View style={styles.sampleTopRow}>
              <View style={styles.sampleHeading}>
                <Text style={styles.sampleNumber}>Muestra #{sample.sampleNumber}</Text>
                <Text style={styles.projectName}>{sample.projectName}</Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: status.background }]}>
                <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
              </View>
            </View>

            <Text style={styles.sampleDate}>{formatDateTime(sample.takenAt)}</Text>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Profundidad</Text>
              <Text style={styles.metadataValue}>
                {sample.depthM === null || sample.depthM === undefined ? 'No indicada' : `${sample.depthM} m`}
              </Text>
            </View>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Etapa</Text>
              <Text style={styles.metadataValue}>{sample.stage || 'No indicada'}</Text>
            </View>
            {sample.notes ? <Text style={styles.sampleNotes}>{sample.notes}</Text> : null}
            {sample.localPhotoUri || sample.bottlePhotoPath ? (
              <Text style={styles.photoAttached}>Foto de botella adjunta</Text>
            ) : null}
            {sample.deviceTimeFlag ? (
              <Text style={styles.deviceTimeWarning}>Hora del dispositivo marcada para revisión</Text>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  content: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxxl,
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.body,
    marginTop: SPACING.md,
  },
  headingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.lg,
  },
  headingCopy: {
    flex: 1,
  },
  title: {
    color: COLORS.text,
    fontSize: TYPE.title,
    fontWeight: TYPE.bold,
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    marginTop: SPACING.xs,
  },
  freeBadge: {
    backgroundColor: COLORS.successBg,
    borderColor: COLORS.success,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    marginLeft: SPACING.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  freeBadgeText: {
    color: COLORS.successText,
    fontSize: TYPE.micro,
    fontWeight: TYPE.bold,
    letterSpacing: 0.8,
  },
  infoCard: {
    backgroundColor: 'rgba(78,134,216,0.12)',
    borderColor: COLORS.accent,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    marginBottom: SPACING.lg,
    padding: SPACING.lg,
  },
  infoTitle: {
    color: COLORS.text,
    fontSize: TYPE.body,
    fontWeight: TYPE.semibold,
    marginBottom: SPACING.xs,
  },
  infoText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    lineHeight: 20,
  },
  errorCard: {
    alignItems: 'center',
    backgroundColor: COLORS.errorBg,
    borderColor: COLORS.error,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    marginBottom: SPACING.lg,
    padding: SPACING.lg,
  },
  errorText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  inlineButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  inlineButtonText: {
    color: COLORS.textOnPrimary,
    fontSize: TYPE.label,
    fontWeight: TYPE.semibold,
  },
  formCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    marginBottom: SPACING.xl,
    padding: SPACING.lg,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: TYPE.h2,
    fontWeight: TYPE.bold,
  },
  label: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: TYPE.semibold,
    marginBottom: SPACING.sm,
    marginTop: SPACING.lg,
  },
  pickerWrapper: {
    backgroundColor: COLORS.input,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  picker: {
    color: COLORS.text,
  },
  sequenceHint: {
    color: COLORS.textSecondary,
    fontSize: TYPE.caption,
    lineHeight: 18,
    marginTop: SPACING.sm,
  },
  input: {
    backgroundColor: COLORS.input,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    color: COLORS.text,
    fontSize: TYPE.body,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  notesInput: {
    minHeight: 96,
  },
  characterCount: {
    color: COLORS.textMuted,
    fontSize: TYPE.caption,
    marginTop: SPACING.xs,
    textAlign: 'right',
  },
  removePhotoButton: { minHeight: 48, justifyContent: 'center',
    alignSelf: 'flex-start',
    borderColor: COLORS.warning,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    marginBottom: SPACING.md,
    marginTop: -SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  removePhotoText: {
    color: COLORS.warningText,
    fontSize: TYPE.label,
    fontWeight: TYPE.semibold,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    marginTop: SPACING.md,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  disabledButton: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: COLORS.textOnPrimary,
    fontSize: TYPE.body,
    fontWeight: TYPE.bold,
  },
  offlineHint: {
    color: COLORS.textSecondary,
    fontSize: TYPE.caption,
    lineHeight: 18,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  listHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  countText: {
    backgroundColor: COLORS.cardElevated,
    borderRadius: RADIUS.pill,
    color: COLORS.text,
    fontSize: TYPE.caption,
    fontWeight: TYPE.bold,
    minWidth: 28,
    overflow: 'hidden',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    textAlign: 'center',
  },
  emptyCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    marginBottom: SPACING.lg,
    padding: SPACING.xl,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: TYPE.body,
    fontWeight: TYPE.semibold,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    lineHeight: 20,
    textAlign: 'center',
  },
  sampleCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    marginBottom: SPACING.md,
    padding: SPACING.lg,
  },
  sampleTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sampleHeading: {
    flex: 1,
    marginRight: SPACING.sm,
  },
  sampleNumber: {
    color: COLORS.text,
    fontSize: TYPE.body,
    fontWeight: TYPE.bold,
  },
  projectName: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    marginTop: SPACING.xs,
  },
  statusBadge: {
    borderRadius: RADIUS.pill,
    maxWidth: '48%',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  statusText: {
    fontSize: TYPE.micro,
    fontWeight: TYPE.semibold,
    textAlign: 'center',
  },
  sampleDate: {
    color: COLORS.textMuted,
    fontSize: TYPE.caption,
    marginBottom: SPACING.md,
    marginTop: SPACING.sm,
  },
  metadataRow: {
    borderTopColor: COLORS.borderLight,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
  },
  metadataLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
  },
  metadataValue: {
    color: COLORS.text,
    flex: 1,
    fontSize: TYPE.label,
    fontWeight: TYPE.medium,
    marginLeft: SPACING.md,
    textAlign: 'right',
  },
  sampleNotes: {
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    lineHeight: 20,
    marginTop: SPACING.sm,
    padding: SPACING.md,
  },
  photoAttached: {
    color: COLORS.primaryText,
    fontSize: TYPE.caption,
    fontWeight: TYPE.semibold,
    marginTop: SPACING.md,
  },
  deviceTimeWarning: {
    color: COLORS.warningText,
    fontSize: TYPE.caption,
    marginTop: SPACING.sm,
  },
});

export default WaterSamplesTab;
