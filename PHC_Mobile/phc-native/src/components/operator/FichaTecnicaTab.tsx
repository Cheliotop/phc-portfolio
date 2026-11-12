import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { completionApi } from '../../api/supabase-completion';
import { productV2Api } from '../../api/supabase-product-v2';
import { queryFirst, runInTransaction } from '../../db/db';
import { insertCompletionReport } from '../../db/repositories/completionReports';
import { fichaShiftBlockers } from '../../sync/fichaShiftBlockers';
import {
} from '../../sync/productV2Sync';
import type { CompletionFinalFields, ProjectDossier } from '../../types/productV2';
import { createClientEntryId } from '../../utils/clientId';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { useFormDraft } from '../../hooks/useFormDraft';
import { drainOutboxIncludingNew } from '../../sync/drainCoordinator';
import { readRecordSendState } from '../../sync/queueStatus';
import { archiveRejectedRows, getOutboxOwner } from '../../sync/outboxOwner';
import { operatorErrorText } from '../../utils/errorMessage';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { showSheet } from '../shared/Sheet';
import { animateNextLayout } from '../../utils/motion';
import { formatDisplayDate } from '../../utils/dateFormat';


interface ClosingAssignment {
  project_id: number;
}

interface CasingRow {
  id: string;
  type: 'ciego' | 'filtro' | 'deposito' | 'otro';
  meters: string;
  diameter: string;
  notes: string;
}

const newCasingRow = (): CasingRow => ({
  id: createClientEntryId('casing'),
  type: 'ciego',
  meters: '',
  diameter: '',
  notes: '',
});

const numeric = (value: string): number | null => {
  if (!value.trim()) return null;
  const result = Number(value.replace(',', '.'));
  return Number.isFinite(result) ? result : null;
};

/**
 * Blocking messages for one step of the Ficha. Pure, so the rules can be tested
 * against the real code; the screen calls it with its current values.
 */
export const fichaStepBlockers = (
  which: FichaStep,
  {
    staticLevel, dynamicLevel, flowRate, maximumFlow, pumpDepth, explorationDepth, wideningDepth,
  }: {
    staticLevel: string; dynamicLevel: string; flowRate: string; maximumFlow: string;
    pumpDepth: string; explorationDepth: string; wideningDepth: string;
  },
): string[] => {
  // Same parser as the submission (accepts "3,5"), so a value the Ficha
  // would send is never reported here as missing.
  const needs = (value: string, label: string, positive = true) => {
    const parsed = numeric(value);
    if (parsed == null) return label;
    if (positive && parsed < 0) return label;
    return null;
  };
  if (which === 'hidraulicos') {
    const list = [
      needs(staticLevel, 'Nivel estático'),
      needs(dynamicLevel, 'Nivel dinámico'),
      needs(flowRate, 'Caudal bombeado'),
      needs(maximumFlow, 'Caudal máximo'),
      needs(pumpDepth, 'Profundidad de bomba'),
    ].filter((entry): entry is string => entry !== null);
    // Caught here rather than at submit: the pair is only meaningful together.
    // Parsed with numeric(), like the checks above: Number("3,5") is NaN, and a
    // NaN comparison is false, so a decimal comma used to skip these checks.
    const staticParsed = numeric(staticLevel);
    const dynamicParsed = numeric(dynamicLevel);
    const flowParsed = numeric(flowRate);
    const maximumParsed = numeric(maximumFlow);
    if (list.length === 0 && staticParsed != null && dynamicParsed != null && dynamicParsed <= staticParsed) {
      list.push('El nivel dinámico debe ser mayor que el estático');
    }
    if (list.length === 0 && maximumParsed != null && flowParsed != null && maximumParsed < flowParsed) {
      list.push('El caudal máximo no puede ser menor que el bombeado');
    }
    return list;
  }
  if (which === 'entubado') {
    return [
      needs(explorationDepth, 'Profundidad de exploración'),
      needs(wideningDepth, 'Profundidad de ensanche'),
    ].filter((entry): entry is string => entry !== null);
  }
  return [];
};

/**
 * Who the signature is for: the signed-in operator, by full name and login. The
 * signature field is prefilled with the name, and the screen says whose account
 * will be recorded, so a signature typed for someone else is visible to them.
 */
export const signerLabelFor = ({ name, username }: { name: string; username: string }): string => {
  if (name && username) return `${name} (usuario ${username})`;
  if (name) return name;
  if (username) return `usuario ${username}`;
  return 'operador';
};

/**
 * Warning, never a block (OPB-13). The exploration depth should sit within one
 * bar length of the last compiled bar's end: a typo such as 85 for 58 is worth
 * a second look, but the operator may be right, so submission is not refused.
 * `barLength` is the well's nominal bar length when known, otherwise the last
 * bar's own length; with neither, there is nothing to compare against.
 */
export const explorationDepthWarning = (
  explorationDepth: string,
  lastBar: { start: number | null; end: number | null } | null,
  barLength: number | null | undefined,
): string | null => {
  const exploration = numeric(explorationDepth);
  if (exploration == null || !lastBar || lastBar.end == null) return null;
  const ownLength = lastBar.start != null ? lastBar.end - lastBar.start : null;
  const length = barLength != null && barLength > 0 ? barLength : ownLength;
  if (length == null || !(length > 0)) return null;
  if (Math.abs(exploration - lastBar.end) <= length) return null;
  return `La profundidad de exploración (${exploration} m) difiere más de un tramo de perforación `
    + `de la última barra (${lastBar.end} m). Revisala antes de enviar.`;
};

const textValue = (value: unknown): string => value == null ? '' : String(value);

const booleanValue = (value: unknown): boolean => value === true || value === 1 || value === 'true';

const SHIFT_STATUS: Record<string, string> = {
  open: 'abierto', report_pending: 'informe pendiente', closed: 'cerrado', rejected: 'rechazado',
};
const END_TYPE: Record<string, string> = {
  manual: 'cerrado por el operador', auto: 'cierre automático', admin: 'cerrado por el administrador',
};

const FICHA_STATUS: Record<string, string> = {
  submitted: 'enviada, pendiente de firma',
  returned: 'devuelta para corregir',
  approved: 'firmada',
};

const casingRowsFrom = (value: unknown): CasingRow[] => {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [newCasingRow()];
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) return [newCasingRow()];
  return parsed.map((row: any) => ({
    id: createClientEntryId('casing'),
    type: ['ciego', 'filtro', 'deposito', 'otro'].includes(row?.type) ? row.type : 'otro',
    meters: textValue(row?.meters),
    diameter: textValue(row?.diameter),
    notes: textValue(row?.notes),
  }));
};

const projectNameFrom = (preview?: ProjectDossier | null) => {
  const project = preview?.project as any;
  return project?.well_name || project?.name || (project?.id ? `Pozo #${project.id}` : 'Ficha técnica');
};

const ReadonlyRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <View style={styles.readonlyRow}>
    <Text style={styles.readonlyLabel}>{label}</Text>
    <Text style={styles.readonlyValue}>{value ?? '—'}</Text>
  </View>
);

/**
 * The Ficha used to present everything at once: the compiled read-only
 * evidence, the hydraulic figures, the depths and casing table, and the
 * signature — 26 fields in a single scroll, filled at a well, in daylight,
 * often wearing gloves. Validation existed but only ran on submit, so a
 * mistake made in the second field was reported after the twenty-sixth.
 *
 * The sections below were already separate cards; they are simply shown one at
 * a time now, and each one has to be valid before the next appears. The point
 * is not fewer fields, it is that a wrong entry cannot be carried forward.
 */
/**
 * Everything the operator types. The signature is deliberately excluded: it is
 * never saved in or restored from a draft. Who saved the draft is kept, so the
 * next operator on the well can see whose work they are continuing (OPB-15).
 */
interface FichaDraft {
  staticLevel: string;
  dynamicLevel: string;
  flowRate: string;
  maximumFlow: string;
  pumpDepth: string;
  specificOverrideEnabled: boolean;
  specificOverride: string;
  explorationDepth: string;
  wideningDepth: string;
  casingAboveGround: string;
  centralizers: string;
  bottomPlug: string;
  bentonite: string;
  gravel: string;
  compressorHours: string;
  pumpHours: string;
  waterQuality: string;
  notes: string;
  casingRows: CasingRow[];
  savedById?: string;
  savedByName?: string;
}

type FichaStep = 'evidencia' | 'hidraulicos' | 'entubado' | 'firma';

const FICHA_STEPS: { key: FichaStep; label: string; hint: string }[] = [
  { key: 'evidencia', label: 'Revisar', hint: 'Confirmá que la evidencia de campo coincide con el pozo' },
  { key: 'hidraulicos', label: 'Hidráulicos', hint: 'Niveles y caudales medidos al finalizar' },
  { key: 'entubado', label: 'Entubado', hint: 'Profundidades y tramos de entubado' },
  { key: 'firma', label: 'Firmar', hint: 'Conformidad del operador' },
];

const FichaTecnicaTab = () => {
  const [operatorId, setOperatorId] = useState('');
  const [assignments, setAssignments] = useState<ClosingAssignment[]>([]);
  const [previews, setPreviews] = useState<Record<number, ProjectDossier>>({});
  const [selectedProject, setSelectedProject] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<FichaStep>('evidencia');
  const [message, setMessage] = useState('');
  const [submittedLocally, setSubmittedLocally] = useState(false);
  const [resubmissionPending, setResubmissionPending] = useState(false);
  // A Ficha the server refused for good (code read O1). It no longer counts as sent:
  // the form opens again with its values and the reason, and sending replaces it.
  const [refusedFicha, setRefusedFicha] = useState<{ id: string; reason: string; fields: any } | null>(null);
  // The same for a returned Ficha's correction the server refused for good: the
  // form opens again with the corrected values and the reason (code read S5).
  const [refusedResubmit, setRefusedResubmit] = useState<{ id: string; reason: string; fields: any } | null>(null);
  // The well whose queue rows have been read. The draft is read only after that,
  // because a refusal changes the server version, and the draft hook drops a draft
  // written against any other version.
  const [queueReadFor, setQueueReadFor] = useState(0);
  // Bumped after each send, so a refusal that comes back at once shows.
  const [queueRevision, setQueueRevision] = useState(0);
  // The server version the fields were last filled for. Until it matches, the
  // fields are not shown, so nothing typed can be overwritten by the fill.
  const [formReadyFor, setFormReadyFor] = useState('');

  const [staticLevel, setStaticLevel] = useState('');
  const [dynamicLevel, setDynamicLevel] = useState('');
  const [flowRate, setFlowRate] = useState('');
  const [maximumFlow, setMaximumFlow] = useState('');
  const [pumpDepth, setPumpDepth] = useState('');
  const [specificOverrideEnabled, setSpecificOverrideEnabled] = useState(false);
  const [specificOverride, setSpecificOverride] = useState('');
  const [explorationDepth, setExplorationDepth] = useState('');
  const [wideningDepth, setWideningDepth] = useState('');
  const [casingAboveGround, setCasingAboveGround] = useState('');
  const [centralizers, setCentralizers] = useState('');
  const [bottomPlug, setBottomPlug] = useState('');
  const [bentonite, setBentonite] = useState('');
  const [gravel, setGravel] = useState('');
  const [compressorHours, setCompressorHours] = useState('');
  const [pumpHours, setPumpHours] = useState('');
  const [waterQuality, setWaterQuality] = useState('');
  const [notes, setNotes] = useState('');
  const [signature, setSignature] = useState('');
  // The signed-in operator, whose name prefills the signature and is recorded with a draft.
  const [signer, setSigner] = useState({ id: '', name: '', username: '' });
  // Set when a draft was restored: the saver's name, or '' when it was not recorded.
  const [restoredDraftFrom, setRestoredDraftFrom] = useState<string | null>(null);
  const [casingRows, setCasingRows] = useState<CasingRow[]>([newCasingRow()]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDiscrepancy, setShowDiscrepancy] = useState(false);
  const [discrepancySection, setDiscrepancySection] = useState('perforacion');
  const [discrepancyDescription, setDiscrepancyDescription] = useState('');
  const formSource = useRef('');
  const sendingDiscrepancy = useRef(false);
  const skipDraftSave = useRef(false);

  const preview = selectedProject ? previews[selectedProject] : undefined;
  const existingCompletion = preview?.completion as any;
  const isReturned = existingCompletion?.status === 'returned';
  const openDiscrepancies = (preview?.discrepancies || []).filter((row: any) => row.status === 'open');

  // Identity of the server state being edited. Also the draft's scope, so a
  // draft written before administration returned the Ficha again is discarded
  // rather than hiding discrepancies the operator has not seen.
  const serverVersion = useMemo(() => (
    isReturned
      ? `${selectedProject}:${existingCompletion.id}:${existingCompletion.returned_at || 'returned'}${refusedResubmit ? `:${refusedResubmit.id}` : ''}`
      : `${selectedProject}:${existingCompletion?.id || 'new'}:${existingCompletion?.status || 'draft'}:${refusedFicha?.id || ''}`
  ), [selectedProject, existingCompletion, isReturned, refusedFicha, refusedResubmit]);

  const draft = useFormDraft<FichaDraft>(
    `ficha:${selectedProject}`,
    Boolean(selectedProject) && queueReadFor === selectedProject,
    serverVersion,
  );

  const effectiveValue = (entityType: string, row: any, field: string) => {
    const correction = [...(preview?.corrections || [])]
      .filter((item: any) => String(item.entity_type) === entityType
        && String(item.entity_id) === String(row.id)
        && String(item.field_name) === field)
      .sort((left: any, right: any) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0] as any;
    return {
      value: correction ? correction.corrected_value : row[field],
      corrected: Boolean(correction),
    };
  };

  const calculatedSpecific = useMemo(() => {
    const staticValue = numeric(staticLevel);
    const dynamicValue = numeric(dynamicLevel);
    const flowValue = numeric(flowRate);
    if (staticValue == null || dynamicValue == null || flowValue == null || dynamicValue <= staticValue) return null;
    return flowValue / (dynamicValue - staticValue);
  }, [staticLevel, dynamicLevel, flowRate]);

  const overrideMismatch = useMemo(() => {
    const override = numeric(specificOverride);
    if (!specificOverrideEnabled || override == null || calculatedSpecific == null) return false;
    return Math.abs(override - calculatedSpecific) > Math.max(Math.abs(calculatedSpecific) * 0.1, 0.01);
  }, [specificOverrideEnabled, specificOverride, calculatedSpecific]);

  const casingMeters = useMemo(
    () => casingRows.reduce((sum, row) => sum + Math.max(0, numeric(row.meters) || 0), 0),
    [casingRows],
  );

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }
    setError('');
    try {
      const userId = await AsyncStorage.getItem('operatorId');
      if (!userId) throw new Error('No hay operador autenticado.');
      setOperatorId(userId);
      const [signerName, signerLogin] = await Promise.all([
        AsyncStorage.getItem('userName'),
        AsyncStorage.getItem('userLoginName'),
      ]);
      setSigner({ id: userId, name: (signerName || '').trim(), username: (signerLogin || '').trim() });
      const assignmentKey = `phc_closing_assignments_${userId}`;
      const previewKeyOf = (projectId: number) => `phc_ficha_preview_${userId}_${projectId}`;

      // The phone's last copy goes on screen first; the server can take 30 seconds
      // or more with no internet (code read O7). Only when every well has a stored
      // preview: a missing one would show a blank Ficha for a moment, and the draft
      // hook drops a draft written against any other version.
      try {
        const cachedRows = JSON.parse((await AsyncStorage.getItem(assignmentKey)) || '[]') as ClosingAssignment[];
        if (cachedRows.length) {
          const cachedPreviews: Record<number, ProjectDossier> = {};
          for (const row of cachedRows) {
            const cached = await AsyncStorage.getItem(previewKeyOf(row.project_id));
            if (cached) cachedPreviews[row.project_id] = JSON.parse(cached) as ProjectDossier;
          }
          if (cachedRows.every((row) => cachedPreviews[row.project_id])) {
            setAssignments(cachedRows);
            setPreviews(cachedPreviews);
            setSelectedProject((current) => (
              cachedRows.some((row) => row.project_id === current) ? current : cachedRows[0].project_id
            ));
            setLoading(false);
          }
        }
      } catch {
        // An unreadable copy: wait for the server as before.
      }

      let rows: ClosingAssignment[] = [];
      try {
        rows = (await productV2Api.getClosingAssignments()) as ClosingAssignment[];
        await AsyncStorage.setItem(assignmentKey, JSON.stringify(rows.map((row) => ({ project_id: row.project_id }))));
      } catch (assignmentError) {
        const cached = await AsyncStorage.getItem(assignmentKey);
        if (cached) rows = JSON.parse(cached) as ClosingAssignment[];
        else throw assignmentError;
      }
      setAssignments(rows);
      if (!rows.length) {
        setSelectedProject(0);
        setPreviews({});
        return;
      }

      const loaded: Record<number, ProjectDossier> = {};
      for (const row of rows) {
        const previewKey = previewKeyOf(row.project_id);
        try {
          loaded[row.project_id] = await completionApi.getPreview(row.project_id);
          await AsyncStorage.setItem(previewKey, JSON.stringify(loaded[row.project_id]));
        } catch (previewError) {
          const cached = await AsyncStorage.getItem(previewKey);
          if (cached) loaded[row.project_id] = JSON.parse(cached) as ProjectDossier;
          else console.warn('[PHC] Ficha preview unavailable:', previewError);
        }
      }
      setPreviews(loaded);
      setSelectedProject((current) => rows.some((row) => row.project_id === current) ? current : rows[0].project_id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar la Ficha');
    } finally {
      setLoading(false);
    }
  }, []);

  useOperatorDataRefresh(() => load(false));

  useEffect(() => {
    let active = true;
    setQueueReadFor(0);
    if (!selectedProject) {
      setSubmittedLocally(false);
      setResubmissionPending(false);
      setRefusedFicha(null);
      setRefusedResubmit(null);
      return () => { active = false; };
    }
    const reportId = Number(existingCompletion?.id);
    const refusedFrom = (row: { id: string; last_error: string | null; payload_json: string }) => {
      let payload: any = {};
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        // Unreadable: the form opens blank, with the reason.
      }
      return {
        id: row.id,
        reason: operatorErrorText(row.last_error) || 'sin motivo informado',
        fields: { ...(payload.finalFields || {}), completion_notes: payload.completionNotes },
      };
    };
    const refusedFichaRead = queryFirst<{ id: string; last_error: string | null; payload_json: string }>(
      `SELECT c.id, o.last_error, o.payload_json
       FROM completion_reports_local c
       JOIN sync_outbox o ON o.entity = 'completion_v2' AND o.entity_id = c.id AND o.state = 'quarantined'
       WHERE c.project_id = ?
       ORDER BY c.created_at DESC LIMIT 1`,
      [selectedProject],
    ).then((refused) => {
      if (!active) return;
      setRefusedFicha(refused ? refusedFrom(refused) : null);
    }).catch(() => undefined);
    const refusedResubmitRead = (Number.isFinite(reportId)
      ? queryFirst<{ id: string; last_error: string | null; payload_json: string }>(
        `SELECT id, last_error, payload_json FROM sync_outbox
         WHERE entity = 'completion_v2_resubmit' AND entity_id = ? AND state = 'quarantined'
         ORDER BY created_at DESC LIMIT 1`,
        [String(reportId)],
      )
      : Promise.resolve(null)
    ).then((refused) => {
      if (!active) return;
      setRefusedResubmit(refused ? refusedFrom(refused) : null);
    }).catch(() => undefined);
    const countsRead = Promise.all([
      queryFirst<{ count: number }>(
        `SELECT COUNT(*) AS count FROM completion_reports_local c
         WHERE c.project_id = ?
           AND NOT EXISTS (SELECT 1 FROM sync_outbox o
                           WHERE o.entity = 'completion_v2' AND o.entity_id = c.id AND o.state = 'quarantined')`,
        [selectedProject],
      ),
      Number.isFinite(reportId)
        ? queryFirst<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sync_outbox
           WHERE entity = 'completion_v2_resubmit' AND entity_id = ?
             AND COALESCE(state, 'pending') <> 'quarantined'`,
          [String(reportId)],
        )
        : Promise.resolve(undefined),
    ]).then(([localRow, queuedRow]) => {
      if (!active) return;
      setSubmittedLocally(Number(localRow?.count || 0) > 0);
      setResubmissionPending(Number(queuedRow?.count || 0) > 0);
    }).catch(() => undefined);
    Promise.allSettled([refusedFichaRead, refusedResubmitRead, countsRead]).then(() => {
      if (active) setQueueReadFor(selectedProject);
    });
    return () => { active = false; };
  }, [selectedProject, existingCompletion?.id, queueRevision]);

  useEffect(() => {
    if (!selectedProject || queueReadFor !== selectedProject) return;
    // Wait for the stored draft to be read; otherwise the server values land
    // first and the draft arrives too late to take precedence.
    if (draft.loading) return;
    const source = serverVersion;
    if (formSource.current === source) return;
    formSource.current = source;
    // The values set below reach state on the next render; saving this render's
    // values would write the blank form over the stored draft.
    skipDraftSave.current = true;

    const completion = isReturned
      ? (refusedResubmit?.fields ?? existingCompletion)
      : (refusedFicha?.fields ?? {});
    const prefilled = isReturned || Boolean(refusedFicha);
    setStaticLevel(textValue(completion.static_level));
    setDynamicLevel(textValue(completion.dynamic_level));
    setFlowRate(textValue(completion.flow_rate));
    setMaximumFlow(textValue(completion.maximum_flow_rate));
    setPumpDepth(textValue(completion.pump_depth_m));
    const hasOverride = prefilled && booleanValue(completion.specific_flow_overridden);
    setSpecificOverrideEnabled(hasOverride);
    setSpecificOverride(hasOverride ? textValue(completion.specific_flow_rate) : '');
    setExplorationDepth(textValue(completion.exploration_depth_m));
    setWideningDepth(textValue(completion.widening_depth_m));
    setCasingAboveGround(textValue(completion.casing_above_ground_m));
    setCentralizers(textValue(completion.centralizer_count));
    setBottomPlug(textValue(completion.bottom_plug_details));
    setBentonite(textValue(completion.bentonite_quantity));
    setGravel(textValue(completion.gravel_quantity));
    setCompressorHours(textValue(completion.compressor_hours));
    setPumpHours(textValue(completion.pump_hours));
    setWaterQuality(textValue(completion.water_quality));
    setNotes(textValue(completion.completion_notes));
    setCasingRows(prefilled ? casingRowsFrom(completion.casing_layout) : [newCasingRow()]);
    // The signature is never carried over from an earlier submission, nor from a
    // draft. It starts as the signed-in operator's own name, which they confirm
    // by sending; a returned Ficha must be reconfirmed the same way.
    setSignature(signer.name || signer.username);

    // The draft only survives `useFormDraft` when it was written against this
    // exact server version, so reaching here means it is the operator's own
    // newer work on the state now on screen, and it wins. A draft written
    // before administration returned the Ficha again was already discarded.
    const saved = draft.initial;
    setRestoredDraftFrom(saved ? (saved.savedByName || '') : null);
    if (saved) {
      setStaticLevel(saved.staticLevel);
      setDynamicLevel(saved.dynamicLevel);
      setFlowRate(saved.flowRate);
      setMaximumFlow(saved.maximumFlow);
      setPumpDepth(saved.pumpDepth);
      setSpecificOverrideEnabled(saved.specificOverrideEnabled);
      setSpecificOverride(saved.specificOverride);
      setExplorationDepth(saved.explorationDepth);
      setWideningDepth(saved.wideningDepth);
      setCasingAboveGround(saved.casingAboveGround);
      setCentralizers(saved.centralizers);
      setBottomPlug(saved.bottomPlug);
      setBentonite(saved.bentonite);
      setGravel(saved.gravel);
      setCompressorHours(saved.compressorHours);
      setPumpHours(saved.pumpHours);
      setWaterQuality(saved.waterQuality);
      setNotes(saved.notes);
      if (saved.casingRows?.length) setCasingRows(saved.casingRows);
      // Signature is deliberately never restored from a draft, for the same
      // reason it is never reused from a returned report: conformity has to be
      // given deliberately, at the moment of sending.
    }
    setFormReadyFor(source);
  }, [selectedProject, existingCompletion, isReturned, refusedFicha, refusedResubmit, queueReadFor,
    draft.loading, draft.initial, serverVersion, signer.name, signer.username]);

  // Keep what the operator types. The draft was restored and cleared, but nothing
  // ever saved it, so Android killing the app halfway through 26 fields lost them
  // all (code read O2). Saved only once the form shows this server state, and only
  // while the form is open for editing.
  const formEditable = isReturned ? !resubmissionPending : !(existingCompletion || submittedLocally);
  useEffect(() => {
    if (draft.loading || formSource.current !== serverVersion || !formEditable) return;
    if (skipDraftSave.current) {
      skipDraftSave.current = false;
      return;
    }
    draft.save({
      staticLevel, dynamicLevel, flowRate, maximumFlow, pumpDepth, specificOverrideEnabled,
      specificOverride, explorationDepth, wideningDepth, casingAboveGround,
      centralizers, bottomPlug, bentonite, gravel, compressorHours, pumpHours, waterQuality,
      notes, casingRows, savedById: signer.id, savedByName: signer.name || signer.username,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticLevel, dynamicLevel, flowRate, maximumFlow, pumpDepth, specificOverrideEnabled,
    specificOverride, explorationDepth, wideningDepth, casingAboveGround,
    centralizers, bottomPlug, bentonite, gravel, compressorHours, pumpHours, waterQuality,
    notes, casingRows]);

  const updateCasing = (id: string, patch: Partial<CasingRow>) => {
    setCasingRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const validate = (): CompletionFinalFields | null => {
    const required = {
      static_level: numeric(staticLevel),
      dynamic_level: numeric(dynamicLevel),
      flow_rate: numeric(flowRate),
      maximum_flow_rate: numeric(maximumFlow),
      pump_depth_m: numeric(pumpDepth),
      exploration_depth_m: numeric(explorationDepth),
      widening_depth_m: numeric(wideningDepth),
    };
    // Name the offending fields. The ficha has ~20 numeric inputs spread over
    // several screens of scrolling; "completa todos los datos hidráulicos" told
    // the operator nothing about which one was missing and left them hunting.
    const REQUIRED_LABELS: Record<keyof typeof required, string> = {
      static_level: 'Nivel estático (m)',
      dynamic_level: 'Nivel dinámico (m)',
      flow_rate: 'Caudal bombeado (L/h)',
      maximum_flow_rate: 'Caudal máximo (L/h)',
      pump_depth_m: 'Profundidad de bomba (m)',
      exploration_depth_m: 'Profundidad de exploración (m)',
      widening_depth_m: 'Profundidad de ensanche (m)',
    };
    const missing = (Object.keys(required) as (keyof typeof required)[])
      .filter((key) => required[key] == null || (required[key] as number) < 0)
      .map((key) => REQUIRED_LABELS[key]);
    if (missing.length > 0) {
      showSheet(
        'Campos obligatorios',
        `Completá estos campos con valores válidos:\n\n• ${missing.join('\n• ')}`,
      );
      return null;
    }
    if ((required.dynamic_level as number) <= (required.static_level as number) || (required.flow_rate as number) <= 0) {
      showSheet('Datos hidráulicos inválidos', 'El nivel dinámico debe superar al estático y el caudal debe ser mayor que cero.');
      return null;
    }
    if ((required.maximum_flow_rate as number) < (required.flow_rate as number)
      || (required.pump_depth_m as number) <= 0
      || (required.exploration_depth_m as number) <= 0
      || (required.widening_depth_m as number) <= 0
      || (required.pump_depth_m as number) > (required.exploration_depth_m as number)
      || (required.widening_depth_m as number) > (required.exploration_depth_m as number)) {
      showSheet('Datos finales inválidos', 'El caudal máximo debe cubrir el bombeado y las profundidades deben ser positivas y no superar la exploración.');
      return null;
    }
    if (specificOverrideEnabled && (numeric(specificOverride) == null || (numeric(specificOverride) as number) <= 0)) {
      showSheet('Caudal específico', 'Ingresá un valor de reemplazo válido.');
      return null;
    }
    const layout = casingRows.map((row, index) => ({
      order: index + 1,
      type: row.type,
      meters: numeric(row.meters) ?? -1,
      diameter: row.diameter.trim() || undefined,
      notes: row.notes.trim() || undefined,
    }));
    if (!layout.length || layout.some((row) => row.meters <= 0)) {
      showSheet('Esquema de entubado', 'Agregá al menos un tramo con metros mayores que cero.');
      return null;
    }
    // The total is the sum of the tramos, shown read-only: a typed total could
    // disagree with them, and the server used to store the sum silently (OPB-13).
    const finalCasingTotal = casingMeters;
    const aboveGround = numeric(casingAboveGround);
    const centralizerValue = numeric(centralizers);
    const bentoniteValue = numeric(bentonite);
    const gravelValue = numeric(gravel);
    if (finalCasingTotal <= 0
      || aboveGround == null || aboveGround < 0
      || centralizerValue == null || centralizerValue < 0 || !Number.isInteger(centralizerValue)
      || bentoniteValue == null || bentoniteValue < 0
      || gravelValue == null || gravelValue < 0
      || !bottomPlug.trim()) {
      showSheet('Entubado incompleto', 'Completá metros sobre terreno, centralizadores, tapón de fondo, bentonita y grava.');
      return null;
    }
    if (finalCasingTotal > (required.exploration_depth_m as number) + aboveGround) {
      showSheet('Entubado fuera de rango', 'El entubado total no puede superar la exploración más el tramo sobre terreno.');
      return null;
    }
    if (signature.trim().length < 2) {
      showSheet('Firma requerida', 'Escribí el nombre y aclaración del operador responsable.');
      return null;
    }

    const sumBy = (type: CasingRow['type']) => layout.filter((row) => row.type === type).reduce((sum, row) => sum + row.meters, 0);
    return {
      static_level: required.static_level as number,
      dynamic_level: required.dynamic_level as number,
      flow_rate: required.flow_rate as number,
      specific_flow_rate: specificOverrideEnabled ? numeric(specificOverride) ?? undefined : undefined,
      maximum_flow_rate: required.maximum_flow_rate as number,
      pump_depth_m: required.pump_depth_m as number,
      exploration_depth_m: required.exploration_depth_m as number,
      widening_depth_m: required.widening_depth_m as number,
      casing_total_m: finalCasingTotal,
      casing_above_ground_m: aboveGround,
      blind_casing_m: sumBy('ciego'),
      filter_casing_m: sumBy('filtro'),
      sediment_trap_m: sumBy('deposito'),
      centralizer_count: centralizerValue,
      bottom_plug_details: bottomPlug.trim(),
      bentonite_quantity: bentoniteValue,
      gravel_quantity: gravelValue,
      casing_layout: layout,
      compressor_hours: numeric(compressorHours) ?? undefined,
      pump_hours: numeric(pumpHours) ?? undefined,
      water_quality: waterQuality.trim() || undefined,
      installed_meters: casingMeters,
      perforated_meters: required.widening_depth_m as number,
    };
  };

  const review = async () => {
    if (!selectedProject || resubmissionPending
      || (!isReturned && (existingCompletion || submittedLocally))) return;
    if (isReturned && openDiscrepancies.length > 0) {
      showSheet(
        'Discrepancias pendientes',
        'Administración debe resolver todas las discrepancias abiertas antes de que puedas reconfirmar la Ficha.',
      );
      return;
    }
    // The server refuses the Ficha while ANY shift on the well is unresolved, so
    // the phone checks every operator's shifts here, not only this operator's.
    // Another operator's row is checked with the server first (audit H5).
    const { blockers, confirmed } = await fichaShiftBlockers(selectedProject, operatorId);
    if (blockers.length > 0) {
      const others = blockers.filter((blocker) => blocker.operator_id !== operatorId);
      if (others.length > 0) {
        const names = others.map((blocker) => blocker.name?.trim() || 'otro operador').join(', ');
        showSheet(
          'Turno sin cerrar',
          `Turno de ${names} sin cerrar. Pedile que lo finalice y reporte antes de enviar la Ficha.`
            + (confirmed ? '' : ' Sin conexión no se pudo confirmar con el servidor: si ya se cerró, se actualiza cuando vuelva la señal.'),
        );
      } else {
        showSheet('Turnos pendientes', 'Todos los turnos deben estar finalizados y reportados antes de enviar la Ficha.');
      }
      return;
    }
    if (validate()) setShowConfirm(true);
  };

  const resubmit = async (finalFields: CompletionFinalFields) => {
    const reportId = Number(existingCompletion?.id);
    if (!Number.isFinite(reportId) || !selectedProject) {
      throw new Error('No se encontró la Ficha devuelta para reenviar.');
    }
    if (openDiscrepancies.length > 0) {
      throw new Error('Administración debe resolver las discrepancias abiertas antes del reenvío.');
    }

    const now = new Date().toISOString();
    const clientEntryId = createClientEntryId('completion_v2_resubmit');
    const payload = {
      reportId,
      projectId: selectedProject,
      clientEntryId,
      finalFields,
      operatorSignature: signature.trim(),
      completionNotes: notes.trim() || undefined,
    };

    const owner = refusedResubmit ? await getOutboxOwner() : null;
    await runInTransaction(async (transaction) => {
      if (refusedResubmit) {
        // The refused correction goes to the admin review list as it was, then
        // this one replaces it on the phone.
        if (owner) await archiveRejectedRows(owner, transaction.execute);
        await transaction.execute(
          `DELETE FROM sync_outbox
           WHERE entity = 'completion_v2_resubmit' AND entity_id = ? AND state = 'quarantined'`,
          [String(reportId)],
        );
      }
      const duplicate = await transaction.queryFirst<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sync_outbox
         WHERE entity = 'completion_v2_resubmit' AND entity_id = ?`,
        [String(reportId)],
      );
      if (Number(duplicate?.count || 0) > 0) {
        throw new Error('La Ficha corregida ya está pendiente de sincronización.');
      }

      await transaction.execute(
        `UPDATE completion_reports_local
         SET server_id = ?, operator_id = ?, format_version = 2,
             static_level = ?, dynamic_level = ?, flow_rate = ?, specific_flow_rate = ?,
             maximum_flow_rate = ?, pump_depth_m = ?, specific_flow_overridden = ?,
             hydraulic_mismatch = ?, exploration_depth_m = ?, widening_depth_m = ?,
             casing_total_m = ?, casing_above_ground_m = ?, blind_casing_m = ?,
             filter_casing_m = ?, sediment_trap_m = ?, centralizer_count = ?,
             bottom_plug_details = ?, bentonite_quantity = ?, gravel_quantity = ?,
             casing_layout = ?, compressor_hours = ?, pump_hours = ?, water_quality = ?,
             installed_meters = ?, perforated_meters = ?, completion_notes = ?,
             operator_signature = ?, status = 'submitted', sync_status = 'pending',
             last_error = NULL, submitted_at = ?, updated_at = ?
         WHERE project_id = ?`,
        [
          reportId, operatorId,
          finalFields.static_level, finalFields.dynamic_level, finalFields.flow_rate,
          finalFields.specific_flow_rate ?? calculatedSpecific,
          finalFields.maximum_flow_rate, finalFields.pump_depth_m,
          specificOverrideEnabled ? 1 : 0, overrideMismatch ? 1 : 0,
          finalFields.exploration_depth_m, finalFields.widening_depth_m,
          finalFields.casing_total_m ?? null, finalFields.casing_above_ground_m ?? null,
          finalFields.blind_casing_m ?? null, finalFields.filter_casing_m ?? null,
          finalFields.sediment_trap_m ?? null, finalFields.centralizer_count ?? null,
          finalFields.bottom_plug_details ?? null, finalFields.bentonite_quantity ?? null,
          finalFields.gravel_quantity ?? null, JSON.stringify(finalFields.casing_layout),
          finalFields.compressor_hours ?? null, finalFields.pump_hours ?? null,
          finalFields.water_quality ?? null, finalFields.installed_meters ?? null,
          finalFields.perforated_meters ?? null, notes.trim() || null,
          signature.trim(), now, now, selectedProject,
        ],
      );
      await transaction.execute(
        `INSERT INTO sync_outbox (
           id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
         ) VALUES (?, 'completion_v2_resubmit', ?, 'UPDATE', ?, ?, 0, ?, ?)`,
        [createClientEntryId('outbox'), String(reportId), JSON.stringify(payload), operatorId, now, now],
      );
    });

    // The shared drain, under its lock and in its order, rather than the step
    // alone (code read S5). Then judge this correction by its own queue row.
    await drainOutboxIncludingNew().catch(() => undefined);
    const sent = await readRecordSendState('completion_v2_resubmit', String(reportId));
    setResubmissionPending(sent.kind === 'waiting');
    setQueueRevision((current) => current + 1);
    setMessage(sent.kind === 'waiting'
      ? 'Ficha corregida guardada en este dispositivo; se reenviará automáticamente.'
      : sent.kind === 'refused'
        ? 'El servidor no aceptó la corrección. Revisá el motivo arriba y enviala de nuevo.'
        : 'Ficha corregida y reconfirmada para una nueva revisión administrativa.');
    if (sent.kind === 'sent') await load();
  };

  const submit = async () => {
    const finalFields = validate();
    if (!finalFields || !selectedProject) return;
    setShowConfirm(false);
    setSaving(true);
    setError('');
    try {
      if (isReturned) {
        await resubmit(finalFields);
        return;
      }
      const now = new Date().toISOString();
      const clientEntryId = createClientEntryId('completion_v2');
      const payload = {
        projectId: selectedProject,
        clientEntryId,
        finalFields,
        operatorSignature: signature.trim(),
        completionNotes: notes.trim() || undefined,
      };
      const owner = refusedFicha ? await getOutboxOwner() : null;
      await runInTransaction(async (transaction) => {
        if (refusedFicha) {
          // The refused copy goes to the admin review list as it was, then this one
          // replaces it on the phone.
          if (owner) await archiveRejectedRows(owner, transaction.execute);
          await transaction.execute(
            `DELETE FROM sync_outbox WHERE entity = 'completion_v2' AND entity_id = ? AND state = 'quarantined'`,
            [refusedFicha.id],
          );
          await transaction.execute('DELETE FROM completion_reports_local WHERE id = ?', [refusedFicha.id]);
        }
        const duplicate = await transaction.queryFirst<{ count: number }>(
          `SELECT COUNT(*) AS count FROM completion_reports_local WHERE project_id = ?`,
          [selectedProject],
        );
        if (Number(duplicate?.count || 0) > 0) throw new Error('Este pozo ya tiene una Ficha local.');
        await insertCompletionReport(
          {
            id: clientEntryId,
            client_entry_id: clientEntryId,
            project_id: selectedProject,
            operator_id: operatorId,
            static_level: finalFields.static_level,
            dynamic_level: finalFields.dynamic_level,
            flow_rate: finalFields.flow_rate,
            specific_flow_rate: finalFields.specific_flow_rate ?? calculatedSpecific,
            maximum_flow_rate: finalFields.maximum_flow_rate,
            pump_depth_m: finalFields.pump_depth_m,
            specific_flow_overridden: specificOverrideEnabled ? 1 : 0,
            hydraulic_mismatch: overrideMismatch ? 1 : 0,
            exploration_depth_m: finalFields.exploration_depth_m,
            widening_depth_m: finalFields.widening_depth_m,
            casing_total_m: finalFields.casing_total_m ?? null,
            casing_above_ground_m: finalFields.casing_above_ground_m ?? null,
            blind_casing_m: finalFields.blind_casing_m ?? null,
            filter_casing_m: finalFields.filter_casing_m ?? null,
            sediment_trap_m: finalFields.sediment_trap_m ?? null,
            centralizer_count: finalFields.centralizer_count ?? null,
            bottom_plug_details: finalFields.bottom_plug_details ?? null,
            bentonite_quantity: finalFields.bentonite_quantity ?? null,
            gravel_quantity: finalFields.gravel_quantity ?? null,
            casing_layout: JSON.stringify(finalFields.casing_layout),
            compressor_hours: finalFields.compressor_hours ?? null,
            pump_hours: finalFields.pump_hours ?? null,
            water_quality: finalFields.water_quality ?? null,
            installed_meters: finalFields.installed_meters ?? null,
            perforated_meters: finalFields.perforated_meters ?? null,
            completion_notes: notes.trim() || null,
            operator_signature: signature.trim(),
            submitted_at: now,
            created_at: now,
            updated_at: now,
          },
          transaction.execute,
        );
        await transaction.execute(
          `INSERT INTO sync_outbox (
           id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'completion_v2', ?, 'INSERT', ?, ?, 0, ?, ?)`,
          [createClientEntryId('outbox'), clientEntryId, JSON.stringify(payload), operatorId, now, now],
        );
      });

      await drainOutboxIncludingNew().catch(() => undefined);
      const sent = await readRecordSendState('completion_v2', clientEntryId);
      // Cleared only after the report is safely written locally — the insert
      // above is inside a transaction, so reaching here means it is committed
      // and the draft has done its job. Clearing any earlier would lose the
      // operator's work if the write failed.
      await draft.clear();
      setRestoredDraftFrom(null);
      setRefusedFicha(null);
      setSubmittedLocally(sent.kind !== 'refused');
      setQueueRevision((current) => current + 1);
      setMessage(sent.kind === 'sent'
        ? 'Ficha enviada para revisión y firma administrativa.'
        : sent.kind === 'refused'
          ? 'El servidor no aceptó la Ficha. Revisá el motivo arriba y enviala de nuevo.'
          : 'Ficha guardada en este dispositivo; se enviará automáticamente.');
      await load();
    } catch (submitError) {
      const detail = submitError instanceof Error ? submitError.message : 'No se pudo guardar la Ficha';
      setError(detail);
      showSheet('Error al enviar', detail);
    } finally {
      setSaving(false);
    }
  };

  const reportDiscrepancy = async () => {
    // A second tap while the first is on its way queued a second discrepancy with a
    // new id, so the admin got duplicates (code read O6).
    if (sendingDiscrepancy.current) return;
    if (!selectedProject || discrepancyDescription.trim().length < 3) {
      showSheet('Falta descripción', 'Describí la diferencia encontrada.');
      return;
    }
    sendingDiscrepancy.current = true;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const id = createClientEntryId('discrepancy');
      const payload = {
        projectId: selectedProject,
        section: discrepancySection,
        description: discrepancyDescription.trim(),
        completionReportId: existingCompletion?.id,
      };
      await runInTransaction(async (transaction) => {
        await transaction.execute(
          `INSERT INTO sync_outbox (
             id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'completion_discrepancy', ?, 'INSERT', ?, ?, 0, ?, ?)`,
          [createClientEntryId('outbox'), id, JSON.stringify(payload), operatorId, now, now],
        );
      });
      await drainOutboxIncludingNew().catch(() => undefined);
      const sent = await readRecordSendState('completion_discrepancy', id);
      setShowDiscrepancy(false);
      setDiscrepancyDescription('');
      setMessage(sent.kind === 'sent'
        ? 'Discrepancia enviada a administración.'
        : sent.kind === 'refused'
          ? `El servidor no aceptó la discrepancia (${sent.reason}). Pasa a revisión del administrador.`
          : 'Discrepancia guardada para sincronizar.');
      if (sent.kind === 'sent') await load();
    } catch (reportError) {
      showSheet('Error', reportError instanceof Error ? reportError.message : 'No se pudo reportar');
    } finally {
      sendingDiscrepancy.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return <View style={[styles.container, styles.centered]}><ActivityIndicator color={COLORS.accent} /><Text style={styles.muted}>Compilando Ficha…</Text></View>;
  }

  if (!assignments.length) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.emptyTitle}>Sin cierres asignados</Text>
        <Text style={styles.muted}>Cuando administración te asigne una Ficha, aparecerá aquí.</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }

  const stepIndex = FICHA_STEPS.findIndex((entry) => entry.key === step);
  const currentStep = FICHA_STEPS[stepIndex];

  /**
   * What this step still needs, in the operator's words. Returning a list
   * rather than a boolean means the button can say why it is disabled instead
   * of just looking broken.
   */
  const missingForStep = (which: FichaStep): string[] => fichaStepBlockers(which, {
    staticLevel, dynamicLevel, flowRate, maximumFlow, pumpDepth, explorationDepth, wideningDepth,
  });

  const blocking = missingForStep(step);
  // OPB-13: the last compiled bar's end, as corrected, and the well's bar length.
  const depthOf = (value: unknown): number | null => (
    value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
  );
  const lastCompiledBar = (preview?.bars || []).reduce((best: any, row: any) => (
    !best || Number(row.bar_number) > Number(best.bar_number) ? row : best
  ), null as any);
  const depthWarning = explorationDepthWarning(
    explorationDepth,
    lastCompiledBar ? {
      start: depthOf(effectiveValue('drilling_bars', lastCompiledBar, 'depth_start').value),
      end: depthOf(effectiveValue('drilling_bars', lastCompiledBar, 'depth_end').value),
    } : null,
    depthOf((preview?.project as any)?.default_bar_length),
  );
  const goNext = () => {
    if (blocking.length > 0) {
      setError(`Falta completar:\n\n• ${blocking.join('\n• ')}`);
      return;
    }
    setError('');
    const next = FICHA_STEPS[stepIndex + 1];
    // Animate the swap so the step reads as a move through a sequence rather
    // than the screen being replaced under the operator.
    if (next) { animateNextLayout(); setStep(next.key); }
  };
  const goBack = () => {
    setError('');
    const previous = FICHA_STEPS[stepIndex - 1];
    if (previous) { animateNextLayout(); setStep(previous.key); }
  };

  return (
    <View style={styles.screen}>
    <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Ficha técnica</Text>
      <Text style={styles.subtitle}>{currentStep.hint}</Text>

      <View style={styles.stepper} accessibilityRole="progressbar">
        {FICHA_STEPS.map((entry, index) => (
          <View key={entry.key} style={styles.stepperItem}>
            <View style={[
              styles.stepperDot,
              index === stepIndex && styles.stepperDotCurrent,
              index < stepIndex && styles.stepperDotDone,
            ]}>
              <Text style={styles.stepperDotText}>{index < stepIndex ? '✓' : String(index + 1)}</Text>
            </View>
            <Text style={[styles.stepperLabel, index === stepIndex && styles.stepperLabelCurrent]}>{entry.label}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.stepCounter}>Paso {stepIndex + 1} de {FICHA_STEPS.length}</Text>
      {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
      {message ? <View style={styles.successBanner}><Text style={styles.successText}>{message}</Text></View> : null}
      {restoredDraftFrom !== null ? (
        <Text style={styles.muted}>
          {restoredDraftFrom ? `Borrador guardado por ${restoredDraftFrom}` : 'Borrador guardado en este pozo'}
        </Text>
      ) : null}

      {isReturned ? (
        <View style={[styles.card, styles.returnedCard]}>
          <Text style={styles.cardTitle}>Ficha devuelta para corrección</Text>
          <Text style={styles.returnReason}>{existingCompletion.return_reason || 'Administración solicitó una corrección.'}</Text>
          <Text style={styles.muted}>Revisá los campos precargados y firmá de nuevo para reconfirmar. La firma anterior no se reutiliza.</Text>
          {openDiscrepancies.map((row: any) => (
            <Text key={row.id} style={styles.warningText}>• {row.section}: {row.description}</Text>
          ))}
          {openDiscrepancies.length > 0 ? (
            <Text style={styles.warningText}>El reenvío permanecerá bloqueado hasta que administración resuelva estas discrepancias.</Text>
          ) : null}
        </View>
      ) : null}

      {assignments.length > 1 ? (
        <View style={styles.pickerWrap}><Picker selectedValue={selectedProject} onValueChange={(value) => setSelectedProject(Number(value))} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>{assignments.map((assignment) => <Picker.Item key={assignment.project_id} label={projectNameFrom(previews[assignment.project_id])} value={assignment.project_id} />)}</Picker></View>
      ) : null}

      <View style={[styles.card, step !== 'evidencia' && styles.stepHidden]}>
        <Text style={styles.cardTitle}>{projectNameFrom(preview)}</Text>
        <Text style={styles.muted}>Los registros de campo son solo lectura. Si algo no coincide, reportalo; no se sobrescribe la evidencia.</Text>
        <View style={styles.metricsRow}>
          <View style={styles.metric}><Text style={styles.metricValue}>{preview?.bars?.length || 0}</Text><Text style={styles.metricLabel}>Barras</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{preview?.shifts?.length || 0}</Text><Text style={styles.metricLabel}>Turnos</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{preview?.samples?.length || 0}</Text><Text style={styles.metricLabel}>Muestras</Text></View>
        </View>
        {/* This only reloads the compiled preview. It was labelled "Actualizar
            Ficha", which in Spanish reads as filing/submitting the ficha — the
            very thing the operator is on this screen to do — while the real
            submit ("Revisar y enviar Ficha") sits far below, out of sight. */}
        <TouchableOpacity style={styles.secondaryButton} onPress={() => load()}><Text style={styles.buttonText}>Actualizar vista</Text></TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowDiscrepancy(true)}><Text style={styles.buttonText}>Reportar discrepancia</Text></TouchableOpacity>
      </View>

      <View style={[styles.card, step !== 'evidencia' && styles.stepHidden]}>
        <Text style={styles.cardTitle}>Perforación compilada</Text>
        {(preview?.bars || []).length ? (preview?.bars || []).map((row: any) => {
          const start = effectiveValue('drilling_bars', row, 'depth_start');
          const end = effectiveValue('drilling_bars', row, 'depth_end');
          const soil = effectiveValue('drilling_bars', row, 'soil_type');
          const corrected = start.corrected || end.corrected || soil.corrected;
          return <ReadonlyRow key={row.id} label={`Barra #${row.bar_number}${corrected ? ' · corregida' : ''}`} value={`${Number(start.value).toFixed(2)} → ${Number(end.value).toFixed(2)} m · ${soil.value || 'sin suelo'}`} />;
        }) : <Text style={styles.muted}>Sin barras registradas.</Text>}
      </View>

      <View style={[styles.card, step !== 'evidencia' && styles.stepHidden]}>
        <Text style={styles.cardTitle}>Turnos y materiales</Text>
        {(preview?.shifts || []).map((row: any) => {
          const start = effectiveValue('shifts', row, 'started_at');
          const endType = effectiveValue('shifts', row, 'end_type');
          return <ReadonlyRow key={row.id} label={`${formatDisplayDate(String(start.value))}${start.corrected || endType.corrected ? ' · corregido' : ''}`} value={`${SHIFT_STATUS[row.status] || row.status} · ${END_TYPE[String(endType.value || 'manual')] || endType.value} · ${row.usage_report_submitted ? 'informe completo' : 'informe pendiente'}`} />;
        })}
        {(preview?.materials || []).map((row: any) => <ReadonlyRow key={row.id} label={row.material_name} value={`${row.initial_quantity} → ${row.current_quantity} ${row.unit} · ${row.layer}`} />)}
      </View>

      <View style={[styles.card, step !== 'evidencia' && styles.stepHidden]}>
        <Text style={styles.cardTitle}>Muestras, pedidos y correcciones</Text>
        {(preview?.samples || []).map((row: any) => {
          const depth = effectiveValue('water_samples', row, 'depth_m');
          const stage = effectiveValue('water_samples', row, 'stage');
          return <ReadonlyRow key={row.id} label={`Muestra #${row.sample_number}${depth.corrected || stage.corrected ? ' · corregida' : ''}`} value={`${depth.value ?? '—'} m · ${stage.value || 'sin etapa'}`} />;
        })}
        {(preview?.company_pedidos || []).map((row: any) => <ReadonlyRow key={row.id} label={row.pedido_number || `Pedido #${row.id}`} value={`${row.status} · ${(row.items || []).length} ítems`} />)}
        <ReadonlyRow label="Correcciones administrativas" value={preview?.corrections?.length || 0} />
        <ReadonlyRow label="Discrepancias abiertas" value={(preview?.discrepancies || []).filter((row: any) => row.status === 'open').length} />
      </View>

      {(isReturned && resubmissionPending) || (!isReturned && (existingCompletion || submittedLocally)) ? (
        <View style={[styles.card, styles.submittedCard]}>
          <Text style={styles.cardTitle}>{isReturned ? 'Reenvío guardado' : 'Ficha enviada'}</Text>
          <Text style={styles.muted}>{isReturned
            ? 'La corrección y la nueva firma están pendientes de sincronización. Se conservará el mismo identificador en cada reintento.'
            : `${existingCompletion ? `Estado: ${FICHA_STATUS[existingCompletion.status] || existingCompletion.status}` : 'Pendiente de sincronización.'} Los campos finales ya no se pueden editar.`}</Text>
        </View>
      ) : formReadyFor !== serverVersion ? (
        <View style={styles.card}><ActivityIndicator color={COLORS.accent} /></View>
      ) : (
        <>
          {refusedResubmit && isReturned ? (
            <View style={[styles.card, styles.refusedCard]}>
              <Text style={styles.cardTitle}>El servidor no aceptó la corrección</Text>
              <Text style={styles.muted}>Motivo: {refusedResubmit.reason}</Text>
              <Text style={styles.muted}>Tus datos siguen abajo. Revisalos y enviala de nuevo.</Text>
            </View>
          ) : null}
          {refusedFicha && !isReturned ? (
            <View style={[styles.card, styles.refusedCard]}>
              <Text style={styles.cardTitle}>El servidor no aceptó la Ficha</Text>
              <Text style={styles.muted}>Motivo: {refusedFicha.reason}</Text>
              <Text style={styles.muted}>Tus datos siguen abajo. Revisalos y enviala de nuevo.</Text>
            </View>
          ) : null}
          <View style={[styles.card, step !== 'hidraulicos' && styles.stepHidden]}>
            <Text style={styles.cardTitle}>Datos hidráulicos finales</Text>
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={staticLevel} onChangeText={setStaticLevel} placeholder="Nivel estático (m) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={dynamicLevel} onChangeText={setDynamicLevel} placeholder="Nivel dinámico (m) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={flowRate} onChangeText={setFlowRate} placeholder="Caudal bombeado (L/h) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <ReadonlyRow label="Caudal específico calculado" value={calculatedSpecific == null ? 'Completá niveles y caudal' : `${calculatedSpecific.toFixed(3)} L/h/m`} />
            <View style={styles.switchRow}><Text style={styles.switchLabel}>Reemplazar cálculo</Text><Switch value={specificOverrideEnabled} onValueChange={setSpecificOverrideEnabled} trackColor={{ false: COLORS.border, true: COLORS.accent }} /></View>
            {specificOverrideEnabled ? <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={[styles.input, overrideMismatch && styles.warningInput]} value={specificOverride} onChangeText={setSpecificOverride} placeholder="Caudal específico informado" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" /> : null}
            {overrideMismatch ? <Text style={styles.warningText}>El valor difiere más de 10% del cálculo; quedará marcado para revisión.</Text> : null}
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={maximumFlow} onChangeText={setMaximumFlow} placeholder="Caudal máximo (L/h) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={pumpDepth} onChangeText={setPumpDepth} placeholder="Profundidad de bomba (m) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={compressorHours} onChangeText={setCompressorHours} placeholder="Horas de compresor" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={pumpHours} onChangeText={setPumpHours} placeholder="Horas de bomba" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={waterQuality} onChangeText={setWaterQuality} placeholder="Calidad de agua" placeholderTextColor={COLORS.placeholder} />
          </View>

          <View style={[styles.card, step !== 'entubado' && styles.stepHidden]}>
            <Text style={styles.cardTitle}>Profundidades y entubado</Text>
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={explorationDepth} onChangeText={setExplorationDepth} placeholder="Profundidad de exploración (m) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            {depthWarning ? <Text style={styles.warningText}>{depthWarning}</Text> : null}
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={wideningDepth} onChangeText={setWideningDepth} placeholder="Profundidad de ensanche (m) *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            {casingRows.map((row, index) => (
              <View key={row.id} style={styles.casingCard}>
                <View style={styles.rowBetween}><Text style={styles.itemTitle}>Tramo {index + 1}</Text>{casingRows.length > 1 ? <TouchableOpacity onPress={() => setCasingRows((current) => current.filter((item) => item.id !== row.id))}><Text style={styles.removeText}>Quitar</Text></TouchableOpacity> : null}</View>
                <View style={styles.pickerWrap}><Picker selectedValue={row.type} onValueChange={(type) => updateCasing(row.id, { type })} style={styles.picker} dropdownIconColor={COLORS.textSecondary}><Picker.Item label="Tubería ciega" value="ciego" /><Picker.Item label="Filtro" value="filtro" /><Picker.Item label="Depósito de sedimentos" value="deposito" /><Picker.Item label="Otro" value="otro" /></Picker></View>
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={row.meters} onChangeText={(meters) => updateCasing(row.id, { meters })} placeholder="Metros *" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={row.diameter} onChangeText={(diameter) => updateCasing(row.id, { diameter })} placeholder="Diámetro" placeholderTextColor={COLORS.placeholder} />
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={row.notes} onChangeText={(rowNotes) => updateCasing(row.id, { notes: rowNotes })} placeholder="Nota" placeholderTextColor={COLORS.placeholder} />
              </View>
            ))}
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setCasingRows((current) => [...current, newCasingRow()])}><Text style={styles.buttonText}>+ Agregar tramo</Text></TouchableOpacity>
            <ReadonlyRow label="Total entubado (suma de tramos)" value={`${casingMeters.toFixed(2)} m`} />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={casingAboveGround} onChangeText={setCasingAboveGround} placeholder="Entubado sobre nivel de suelo (m)" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={centralizers} onChangeText={setCentralizers} placeholder="Cantidad de centralizadores" placeholderTextColor={COLORS.placeholder} keyboardType="number-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={bottomPlug} onChangeText={setBottomPlug} placeholder="Detalle de tapón de fondo" placeholderTextColor={COLORS.placeholder} />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={bentonite} onChangeText={setBentonite} placeholder="Bentonita" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={gravel} onChangeText={setGravel} placeholder="Grava" placeholderTextColor={COLORS.placeholder} keyboardType="decimal-pad" />
          </View>

          <View style={[styles.card, step !== 'firma' && styles.stepHidden]}>
            <Text style={styles.cardTitle}>Conformidad del operador</Text>
            <TextInput style={[styles.input, styles.textArea]} value={notes} onChangeText={setNotes} placeholder="Notas finales" placeholderTextColor={COLORS.placeholder} multiline />
            {isReturned ? <Text style={styles.warningText}>La reconfirmación requiere una firma nueva.</Text> : null}
            <Text style={styles.muted}>{`Firmás como ${signerLabelFor(signer)}`}</Text>
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={signature} onChangeText={setSignature} placeholder={isReturned ? 'Nueva firma y aclaración *' : 'Nombre y aclaración *'} placeholderTextColor={COLORS.placeholder} />
            <TouchableOpacity style={[styles.primaryButton, (saving || (isReturned && openDiscrepancies.length > 0)) && styles.disabled]} disabled={saving || (isReturned && openDiscrepancies.length > 0)} onPress={review}><Text style={styles.buttonText}>{isReturned ? 'Revisar y reconfirmar Ficha' : 'Revisar y enviar Ficha'}</Text></TouchableOpacity>
          </View>
        </>
      )}

      <Modal visible={showConfirm} transparent animationType="slide" onRequestClose={() => setShowConfirm(false)}>
        <View style={styles.overlay}><View style={styles.modalCard}><Text style={styles.cardTitle}>{isReturned ? 'Reconfirmar Ficha corregida' : 'Confirmar Ficha'}</Text><Text style={styles.muted}>{isReturned ? 'La nueva firma reemplazará la conformidad anterior y la Ficha volverá a revisión administrativa.' : 'Se enviará una sola Ficha para este pozo. La evidencia compilada permanecerá inmutable.'}</Text><ReadonlyRow label="Pozo" value={projectNameFrom(preview)} /><ReadonlyRow label="Caudal específico" value={`${(specificOverrideEnabled ? numeric(specificOverride) : calculatedSpecific)?.toFixed(3)} L/h/m`} /><ReadonlyRow label="Tramos" value={`${casingRows.length} · ${casingMeters.toFixed(2)} m`} /><View style={styles.modalActions}><TouchableOpacity style={styles.secondaryButton} onPress={() => setShowConfirm(false)}><Text style={styles.buttonText}>Volver</Text></TouchableOpacity><TouchableOpacity style={styles.primaryButton} onPress={submit}><Text style={styles.buttonText}>{isReturned ? 'Confirmar reenvío' : 'Confirmar envío'}</Text></TouchableOpacity></View></View></View>
      </Modal>

      <Modal visible={showDiscrepancy} transparent animationType="fade" onRequestClose={() => setShowDiscrepancy(false)}>
        <View style={styles.overlay}><View style={styles.modalCard}><Text style={styles.cardTitle}>Reportar discrepancia</Text><View style={styles.pickerWrap}><Picker selectedValue={discrepancySection} onValueChange={setDiscrepancySection} style={styles.picker} dropdownIconColor={COLORS.textSecondary}><Picker.Item label="Perforación" value="perforacion" /><Picker.Item label="Turnos" value="turnos" /><Picker.Item label="Materiales" value="materiales" /><Picker.Item label="Muestras" value="muestras" /><Picker.Item label="Pedidos" value="pedidos" /><Picker.Item label="Otro" value="otro" /></Picker></View><TextInput style={[styles.input, styles.textArea]} value={discrepancyDescription} onChangeText={setDiscrepancyDescription} multiline placeholder="Describí qué no coincide" placeholderTextColor={COLORS.placeholder} /><View style={styles.modalActions}><TouchableOpacity style={styles.secondaryButton} onPress={() => setShowDiscrepancy(false)}><Text style={styles.buttonText}>Cancelar</Text></TouchableOpacity><TouchableOpacity style={[styles.primaryButton, saving && styles.disabled]} disabled={saving} onPress={reportDiscrepancy}><Text style={styles.buttonText}>{saving ? 'Enviando…' : 'Enviar'}</Text></TouchableOpacity></View></View></View>
      </Modal>

      </ScrollView>

      {/* Pinned rather than scrolled with the content. Siguiente is pressed on
          every step, and a control that scrolls away is a control the operator
          has to go looking for with one hand. This also puts it in the bottom
          third, which is the only part of a phone a thumb reaches comfortably.

          The last step keeps its own submit button, so navigation stops at
          Entubado -> Firmar and does not duplicate the send action. */}
      {step !== 'firma' ? (
        <>
          {blocking.length > 0 ? (
            <Text style={styles.stepBlocked}>Falta: {blocking.join(' · ')}</Text>
          ) : null}
          <View style={styles.stepNav}>
            {stepIndex > 0 ? (
              <TouchableOpacity testID="ficha-step-back" style={styles.stepNavButton} onPress={goBack}>
                <Text style={styles.stepNavText}>Atrás</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              testID="ficha-step-next"
              accessibilityState={{ disabled: blocking.length > 0 }}
              style={[styles.stepNavButton, styles.stepNavPrimary, blocking.length > 0 && styles.disabled]}
              onPress={goNext}
            >
              <Text style={[styles.stepNavText, styles.stepNavTextPrimary]}>Siguiente</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <View style={styles.stepNav}>
          <TouchableOpacity testID="ficha-step-back" style={styles.stepNavButton} onPress={goBack}>
            <Text style={styles.stepNavText}>Atrás</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.xl, paddingBottom: SPACING.huge4 },
  centered: { justifyContent: 'center', alignItems: 'center', padding: SPACING.xl, gap: SPACING.md },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  subtitle: { color: COLORS.textSecondary, fontSize: TYPE.label, marginTop: SPACING.xs, marginBottom: SPACING.xl },
  emptyTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  muted: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18 },
  card: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, padding: SPACING.lg, marginBottom: SPACING.lg },

  // Steps hide rather than unmount so that values typed on an earlier step
  // survive going back and forth, and so returning to a step is instant.
  stepHidden: { display: 'none' },

  stepper: { flexDirection: 'row', gap: SPACING.xs, marginBottom: SPACING.sm },
  stepperItem: { alignItems: 'center', flex: 1, gap: SPACING.xs },
  stepperDot: {
    alignItems: 'center', backgroundColor: COLORS.input, borderColor: COLORS.border,
    borderRadius: RADIUS.pill, borderWidth: 1, height: 32, justifyContent: 'center', width: 32,
  },
  stepperDotCurrent: { backgroundColor: COLORS.primary, borderColor: COLORS.accent },
  stepperDotDone: { backgroundColor: COLORS.successBg, borderColor: COLORS.successText },
  stepperDotText: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.bold },
  stepperLabel: { color: COLORS.textMuted, fontSize: TYPE.micro, fontWeight: TYPE.semibold, textAlign: 'center' },
  stepperLabelCurrent: { color: COLORS.text },
  stepCounter: { color: COLORS.textMuted, fontSize: TYPE.caption, marginBottom: SPACING.lg, textAlign: 'center' },

  screen: { backgroundColor: COLORS.background, flex: 1 },
  stepNav: {
    backgroundColor: COLORS.background, borderTopColor: COLORS.border, borderTopWidth: 1,
    flexDirection: 'row', gap: SPACING.md, paddingBottom: SPACING.xxl,
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.md,
  },
  stepNavButton: {
    alignItems: 'center', borderColor: COLORS.border, borderRadius: RADIUS.md,
    borderWidth: 1, flex: 1, padding: SPACING.lg,
  },
  stepNavPrimary: { backgroundColor: COLORS.primary, borderColor: COLORS.accent },
  stepNavText: { color: COLORS.textSecondary, fontSize: TYPE.bodyLg, fontWeight: TYPE.bold },
  stepNavTextPrimary: { color: COLORS.textOnPrimary },
  stepBlocked: {
    backgroundColor: COLORS.background, color: COLORS.warningText, fontSize: TYPE.caption,
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, textAlign: 'center',
  },
  submittedCard: { borderColor: COLORS.success },
  returnedCard: { borderColor: COLORS.warning },
  returnReason: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.bold, marginBottom: SPACING.sm },
  cardTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold, marginBottom: SPACING.sm },
  metricsRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  metric: { flex: 1, backgroundColor: COLORS.backgroundDark, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center' },
  metricValue: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  metricLabel: { color: COLORS.textSecondary, fontSize: TYPE.micro },
  readonlyRow: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.md, borderTopWidth: 1, borderTopColor: COLORS.borderLight, paddingVertical: SPACING.sm },
  readonlyLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, flex: 1 },
  readonlyValue: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.semibold, flex: 1, textAlign: 'right' },
  pickerWrap: { backgroundColor: COLORS.input, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, overflow: 'hidden', marginBottom: SPACING.md },
  picker: { color: COLORS.text },
  input: { backgroundColor: COLORS.input, color: COLORS.text, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.sm },
  textArea: { minHeight: 82, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: SPACING.sm },
  switchLabel: { color: COLORS.text, fontSize: TYPE.label },
  warningInput: { borderColor: COLORS.warning },
  warningText: { color: COLORS.warningText, fontSize: TYPE.caption, marginTop: SPACING.sm },
  casingCard: { backgroundColor: COLORS.backgroundDark, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  itemTitle: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.bold },
  removeText: { color: COLORS.errorText, fontSize: TYPE.caption, fontWeight: TYPE.bold },
  primaryButton: { minHeight: 48, justifyContent: 'center', flex: 1, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  secondaryButton: { minHeight: 48, justifyContent: 'center', flex: 1, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  buttonText: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.bold, textAlign: 'center' },
  disabled: { opacity: 0.45 },
  refusedCard: { borderColor: COLORS.error, borderWidth: 1 },
  errorBanner: { backgroundColor: COLORS.errorBg, borderWidth: 1, borderColor: COLORS.error, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.md },
  errorText: { color: COLORS.errorText, fontSize: TYPE.caption },
  successBanner: { backgroundColor: COLORS.successBg, borderWidth: 1, borderColor: COLORS.success, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.md },
  successText: { color: COLORS.successText, fontSize: TYPE.caption },
  overlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.72)', padding: SPACING.xl },
  modalCard: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, padding: SPACING.lg },
  modalActions: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.md },
});

export default FichaTecnicaTab;
