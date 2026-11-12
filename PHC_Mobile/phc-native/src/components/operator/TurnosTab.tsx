import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { query, queryFirst, runInTransaction } from '../../db/db';
import { loadAssignedProjects, refreshAssignedProjects, type AssignedProject } from '../../api/projectCache';
import { materialsApi } from '../../api/supabase-materials';
import { shiftsApi } from '../../api/supabase-shifts';
import { getShiftSyncState, type ShiftSyncState } from '../../sync/productV2Sync';
import { drainOutboxIncludingNew } from '../../sync/drainCoordinator';
import { startShiftOnServer } from '../../sync/startShift';
import { readShiftCloseState, type ShiftCloseState } from '../../sync/queueStatus';
import { operatorErrorText } from '../../utils/errorMessage';
import { createClientEntryId } from '../../utils/clientId';
import { parseQuantity, quantityPreview } from '../../utils/quantity';
import { queueShiftJoin } from '../../sync/shiftJoin';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { useOperatorDataRefresh } from '../../hooks/useOperatorDataRefresh';
import { mirrorProjectMaterials } from '../../db/repositories/projectMaterials';
import { ensureOperatorStub } from '../../db/repositories/operators';
import {
  confirmShiftHandoverLocally,
  markShiftPendingReport,
  mirrorUnresolvedShift,
  recordLocalShiftEnd,
  upsertShiftHandover,
} from '../../db/repositories/shifts';
import { showSheet } from '../shared/Sheet';
import { formatDisplayDateTime, storedDateOf } from '../../utils/dateFormat';


/** How long the shift screen explains a refused or force-closed shift. */
const SHIFT_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

interface LocalShift {
  id: string;
  server_id?: string | null;
  client_entry_id: string;
  project_id: number;
  operator_id: string;
  status: 'open' | 'report_pending' | 'closed';
  started_at: string;
  ended_at?: string | null;
  end_type?: 'manual' | 'auto' | 'admin' | null;
  handover_confirmed: number;
  usage_report_submitted: number;
  sync_state?: ShiftSyncState;
  last_error?: string | null;
}

interface LocalMaterial {
  id: number;
  project_id: number;
  material_name: string;
  current_quantity: number;
  initial_quantity: number;
  unit: string;
  layer: string;
  active: number;
}

interface ShiftBarSummary {
  count: number;
  depth_start: number;
  depth_end: number;
}

interface HandoverDraft {
  flagged: boolean;
  observed: string;
  note: string;
}

interface UsageDraft {
  quantity: string;
  approximate: boolean;
  notes: string;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const timestamp = () => new Date().toISOString();

// Same ceiling as end_shift on the server, so an impossible quantity is caught
// while the operator is still looking at it, not when the closed shift syncs.
const MAX_USAGE_QUANTITY = 1_000_000;

// The reason a typed quantity cannot be saved, or null when it can. "1.500" is
// refused with the question to ask, not read as 1.5 (audit OPA-6).
const usageQuantityError = (raw: string): string | null => {
  if (raw.trim() === '') return null;
  const parsed = parseQuantity(raw);
  if (parsed.ok === false) return parsed.error;
  return parsed.value <= MAX_USAGE_QUANTITY ? null : `La cantidad no puede pasar de ${MAX_USAGE_QUANTITY}.`;
};

const parseNonNegative = (raw: string): number | null => {
  if (usageQuantityError(raw) !== null) return null;
  if (raw.trim() === '') return 0;
  const parsed = parseQuantity(raw);
  return parsed.ok === true ? parsed.value : null;
};

// Was `toLocaleString('es-PY')` with no options, which rendered the shift card
// as "Fri Jul 31 11:50:18 2026" on the device.
const formatDateTime = (value?: string | null) => formatDisplayDateTime(value);

const TurnosTab = () => {
  const [operatorId, setOperatorId] = useState('');
  const [projects, setProjects] = useState<AssignedProject[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [shift, setShift] = useState<LocalShift | null>(null);
  const [hasRefusedShift, setHasRefusedShift] = useState(false);
  const [adminCloseReason, setAdminCloseReason] = useState<string | null>(null);
  const [materials, setMaterials] = useState<LocalMaterial[]>([]);
  const [handover, setHandover] = useState<Record<number, HandoverDraft>>({});
  const [usage, setUsage] = useState<Record<number, UsageDraft>>({});
  const [shiftNotes, setShiftNotes] = useState('');
  const [bars, setBars] = useState<ShiftBarSummary>({ count: 0, depth_start: 0, depth_end: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [closeState, setCloseState] = useState<ShiftCloseState>({ kind: 'none' });
  // Which shift and well the drafts below belong to. A background refresh keeps
  // what the operator has typed (audit H1); a different shift or well starts clean.
  const draftsFor = useRef<string | null>(null);
  // The shift the banners are about, so a message about one shift doesn't stay up
  // once the screen shows another, or none.
  const shownShiftId = useRef<string | null | undefined>(undefined);

  const selectedProjectData = useMemo(
    () => projects.find((project) => String(project.id) === selectedProject),
    [projects, selectedProject],
  );

  const markExpiredShiftForReport = async (active: LocalShift, authorId: string): Promise<LocalShift> => {
    if (active.status !== 'open') return active;
    const started = new Date(active.started_at).getTime();
    if (!Number.isFinite(started) || Date.now() - started < TWELVE_HOURS_MS) return active;

    // The server reaper applies the same pure 12-hour transition, but the
    // device must retain a per-change record until it has observed that result.
    // Otherwise a later handover can make the shift look fully synced while the
    // server still reports it open (W-17).
    const endedAt = new Date(started + TWELVE_HOURS_MS).toISOString();
    const now = timestamp();
    const payload = {
      shiftId: active.id,
      projectId: active.project_id,
      operatorId: active.operator_id,
      endedAt,
    };
    await runInTransaction(async (transaction) => {
      await markShiftPendingReport(active.id, endedAt, now, transaction.execute);
      await transaction.execute(
        `INSERT INTO sync_outbox (
           id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
         )
         SELECT ?, 'shift_auto_close', ?, 'VERIFY', ?, ?, 0, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox
           WHERE entity = 'shift_auto_close' AND entity_id = ?
         )`,
        [
          createClientEntryId('outbox'), active.id, JSON.stringify(payload), authorId,
          now, now, active.id,
        ],
      );
    });
    return { ...active, status: 'report_pending', ended_at: endedAt, end_type: 'auto' };
  };

  const refreshMaterials = useCallback(async (projectId: number, shiftId: string | null, fromServer = true) => {
    if (fromServer) {
      try {
        const response = await materialsApi.getProjectMaterials(projectId);
        // This was the canonical copy of the mirror; it now lives in
        // db/repositories/projectMaterials so the other call sites cannot drift
        // away from it again.
        await mirrorProjectMaterials(response.data, timestamp());
      } catch (refreshError) {
        console.warn('[PHC] Material handover refresh unavailable:', refreshError);
      }
    }

    const rows = await query<LocalMaterial>(
      `SELECT id, project_id, material_name, current_quantity, initial_quantity,
              unit, layer, active
       FROM project_materials
       WHERE project_id = ? AND COALESCE(active, 1) = 1
       ORDER BY CASE layer WHEN 'presupuesto' THEN 0 ELSE 1 END, material_name`,
      [projectId],
    );
    setMaterials(rows);
    const key = `${shiftId ?? 'none'}:${projectId}`;
    const fresh = draftsFor.current !== key;
    draftsFor.current = key;
    // A flagged handover line keeps what the operator typed. An unflagged one
    // follows the latest balance, which is what it would show if flagged now.
    setHandover((current) => Object.fromEntries(rows.map((item) => {
      const kept = fresh ? undefined : current[item.id];
      return [item.id, kept?.flagged ? kept : { flagged: false, observed: String(item.current_quantity), note: kept?.note ?? '' }];
    })));
    setUsage((current) => Object.fromEntries(rows.map((item) => [
      item.id,
      (fresh ? undefined : current[item.id]) ?? { quantity: '', approximate: false, notes: '' },
    ])));
  }, []);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const storedOperatorId = await AsyncStorage.getItem('operatorId');
      if (!storedOperatorId) throw new Error('No hay operador autenticado. Volvé a iniciar sesión.');
      setOperatorId(storedOperatorId);

      // Show what the phone already has first, then ask the server. With an expired
      // token and no server, the server calls take most of a minute, and the screen
      // used to hold "Cargando turno…" all that time (audit B3).
      const present = async (projectList: AssignedProject[], fromServer: boolean) => {
        // The operator's own unresolved shift, or the equipo's on any of their wells,
        // preferring the selected well. Looking only at the selected (or first) well
        // missed a shift on another of the operator's wells.
        const wellIds = projectList.map((project) => Number(project.id)).filter((id) => id > 0);
        const preferredWell = Number(selectedProject || 0);
        let unresolved = await queryFirst<LocalShift>(
          `SELECT * FROM shifts
           WHERE status IN ('open', 'report_pending')
             AND (operator_id = ?${wellIds.length ? ` OR project_id IN (${wellIds.map(() => '?').join(', ')})` : ''})
           ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, started_at DESC LIMIT 1`,
          [storedOperatorId, ...wellIds, preferredWell],
        );
        // A reinstall starts with empty SQLite even when this operator already has
        // an unresolved server shift. Hydrate it before offering a second start.
        if (!unresolved && fromServer) {
          try {
            const serverShifts = (await shiftsApi.getMine({ unresolvedOnly: true }))
              .filter((candidate) => candidate.operator_id === storedOperatorId
                || wellIds.includes(Number(candidate.project_id)));
            const serverShift = serverShifts.find((candidate) => Number(candidate.project_id) === preferredWell)
              ?? serverShifts.find((candidate) => candidate.operator_id === storedOperatorId)
              ?? serverShifts[0];
            if (serverShift) {
              const now = timestamp();
              const operatorName = (await AsyncStorage.getItem('userName')) || 'Operador';
              await runInTransaction(async (transaction) => {
                await ensureOperatorStub({
                  id: storedOperatorId,
                  name: operatorName,
                  currentTime: now,
                }, transaction.execute);
                await mirrorUnresolvedShift(serverShift, now, transaction.execute);
              });
              unresolved = await queryFirst<LocalShift>(
                `SELECT * FROM shifts WHERE id = ?`,
                [serverShift.id],
              );
            }
          } catch (refreshError) {
            console.warn('[PHC] Existing server shift refresh unavailable:', refreshError);
          }
        }
        if (unresolved) {
          unresolved = await markExpiredShiftForReport(unresolved, storedOperatorId);
          unresolved = { ...unresolved, sync_state: await getShiftSyncState(unresolved.id) };
          // Crew members on the well's open shift record their join, once per
          // device and operator (sync/shiftJoin.ts). Non-crew get no row.
          // The join is not urgent: the regular drain sends it, not this load.
          await queueShiftJoin(unresolved, storedOperatorId);
        }
        if (shownShiftId.current !== undefined && shownShiftId.current !== (unresolved?.id ?? null)) {
          setMessage('');
        }
        shownShiftId.current = unresolved?.id ?? null;
        setShift(unresolved);
        setCloseState(unresolved ? await readShiftCloseState(unresolved) : { kind: 'none' });

        const refused = await queryFirst<{ count: number }>(
          `SELECT COUNT(*) AS count FROM shifts
           WHERE operator_id = ? AND status = 'rejected' AND updated_at >= ?`,
          [storedOperatorId, new Date(Date.now() - SHIFT_NOTICE_MS).toISOString()],
        );
        setHasRefusedShift(Number(refused?.count || 0) > 0);

        const latest = await queryFirst<{ end_type: string | null; notes: string | null; updated_at: string }>(
          `SELECT end_type, notes, updated_at FROM shifts
           WHERE operator_id = ? ORDER BY started_at DESC LIMIT 1`,
          [storedOperatorId],
        );
        setAdminCloseReason(
          latest?.end_type === 'admin' && Date.parse(latest.updated_at) >= Date.now() - SHIFT_NOTICE_MS
            ? latest.notes || ''
            : null,
        );

        const projectId = unresolved?.project_id
          ?? (projectList.length === 1 ? Number(projectList[0].id) : Number(selectedProject || 0));
        if (projectId) {
          setSelectedProject(String(projectId));
          await refreshMaterials(projectId, unresolved?.id ?? null, fromServer);
        } else {
          setMaterials([]);
        }

        if (unresolved) {
          const summary = await queryFirst<ShiftBarSummary>(
            `SELECT COUNT(*) AS count, COALESCE(MIN(depth_start), 0) AS depth_start,
                    COALESCE(MAX(depth_end), 0) AS depth_end
             FROM drilling_bar_entries WHERE shift_id = ?`,
            [unresolved.id],
          );
          setBars(summary || { count: 0, depth_start: 0, depth_end: 0 });
        } else {
          setBars({ count: 0, depth_start: 0, depth_end: 0 });
        }
      };

      const cached = await loadAssignedProjects(storedOperatorId, { activeOnly: true });
      setProjects(cached);
      await present(cached, false);
      setLoading(false);
      setRefreshing(false);

      const refreshed = await refreshAssignedProjects(storedOperatorId, { activeOnly: true });
      setProjects(refreshed);
      await present(refreshed, true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los turnos');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [refreshMaterials, selectedProject]);

  useOperatorDataRefresh(() => load(false));

  useEffect(() => {
    if (!shift && selectedProject) {
      refreshMaterials(Number(selectedProject), null).catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los materiales');
      });
    }
  }, [selectedProject, shift, refreshMaterials]);

  const startShift = async () => {
    if (!operatorId || !selectedProject) {
      showSheet('Falta información', 'Seleccioná un pozo asignado.');
      return;
    }
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const existing = await queryFirst<LocalShift>(
        `SELECT * FROM shifts WHERE project_id = ? AND status IN ('open', 'report_pending') LIMIT 1`,
        [Number(selectedProject)],
      );
      if (existing) throw new Error('Ya tenés un turno pendiente. Tenés que finalizar su informe antes de iniciar otro.');

      const outcome = await startShiftOnServer({
        projectId: Number(selectedProject),
        operatorId,
        operatorName: (await AsyncStorage.getItem('userName')) || 'Operador',
      });
      if (outcome.kind === 'no_connection') {
        const detail = 'Para iniciar un turno necesitás conexión con el servidor. Revisá la señal e intentá de nuevo.';
        setError(detail);
        showSheet('Sin conexión', detail);
        return;
      }
      if (outcome.kind === 'refused') {
        setError(outcome.message);
        showSheet('No se pudo iniciar', outcome.message);
        return;
      }
      setMessage(outcome.kind === 'started'
        ? 'Turno iniciado. Confirmá el traspaso de materiales.'
        : 'Ya tenías un turno sin cerrar, así que seguís con ese.');
      await load(false);
    } catch (startError) {
      const detail = startError instanceof Error ? startError.message : 'No se pudo iniciar el turno';
      setError(detail);
      showSheet('No se pudo iniciar', detail);
    } finally {
      setSaving(false);
    }
  };

  const confirmHandover = async () => {
    if (!shift) return;
    const flaggedWithoutDetails = materials.find((material) => {
      const draft = handover[material.id];
      return draft?.flagged && (
        parseNonNegative(draft.observed) === null || draft.note.trim().length < 3
      );
    });
    if (flaggedWithoutDetails) {
      showSheet('Revisá la diferencia', `Indicá la cantidad observada y una nota para ${flaggedWithoutDetails.material_name}.`);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const items = materials.map((material) => {
        const draft = handover[material.id] || { flagged: false, observed: '', note: '' };
        return {
          // Deterministic per shift and material (OPA-11): the server compares the
          // whole payload on a replay, so a second submit must send the same ids.
          client_entry_id: `handover:${shift.id}:${material.id}`,
          project_material_id: material.id,
          status: draft.flagged ? 'flagged' as const : 'confirmed' as const,
          expected_quantity: material.current_quantity,
          observed_quantity: draft.flagged ? parseNonNegative(draft.observed) ?? undefined : undefined,
          note: draft.flagged ? draft.note.trim() : undefined,
        };
      });
      const now = timestamp();

      await runInTransaction(async (transaction) => {
        for (const item of items) {
          await upsertShiftHandover({
            id: createClientEntryId('handover_local'),
            clientEntryId: item.client_entry_id,
            shiftId: shift.id,
            projectMaterialId: item.project_material_id,
            status: item.status,
            expectedQuantity: item.expected_quantity,
            observedQuantity: item.observed_quantity ?? null,
            note: item.note ?? null,
            confirmedBy: operatorId,
            now,
          }, transaction.execute);
        }
        await confirmShiftHandoverLocally(shift.id, now, transaction.execute);
        // Supersede any earlier attempt for this shift instead of stacking a
        // second queued copy. The payload is the COMPLETE set of items for the
        // shift and shift_handovers above is upserted on
        // (shift_id, project_material_id), so a newer queue entry refreshes the
        // retry-owned fields — two rows would just re-send the same handover twice.
        //
        // This also keeps the W-11(b) "rechazados" count honest: without it, an
        // operator retrying a handover the server keeps refusing would leave one
        // quarantined tombstone per tap and PozosTab would report five rejected
        // records where there is really one. The reason itself is not lost — it
        // lives on shifts.last_error and shift_handovers.last_error.
        await transaction.execute(
          `DELETE FROM sync_outbox WHERE entity = 'shift_handover' AND entity_id = ?`,
          [shift.id],
        );
        await transaction.execute(
          `INSERT INTO sync_outbox (
             id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'shift_handover', ?, 'UPSERT', ?, ?, 0, ?, ?)`,
          [
            createClientEntryId('outbox'), shift.id,
            JSON.stringify({ shiftId: shift.id, items }), operatorId, now, now,
          ],
        );
      });

      // The shared drain, not the handover step alone: it holds the lock that keeps
      // two uploads of the same row from overlapping.
      await drainOutboxIncludingNew().catch(() => undefined);
      // Saved on the phone either way. Only a refusal is worth an alarm: no signal
      // used to read as "Traspaso no confirmado", with the raw error.
      const queued = await queryFirst<{ state: string | null; last_error: string | null }>(
        `SELECT state, last_error FROM sync_outbox WHERE entity = 'shift_handover' AND entity_id = ?`,
        [shift.id],
      );
      if (!queued) {
        setMessage('Traspaso confirmado.');
      } else if (queued.state === 'quarantined') {
        const detail = operatorErrorText(queued.last_error) || 'el servidor rechazó el traspaso';
        setMessage('');
        setError(`El traspaso no se pudo confirmar: ${detail}`);
        showSheet('Traspaso no confirmado', detail);
      } else {
        setMessage('Traspaso guardado en este dispositivo. Se enviará solo cuando haya conexión.');
      }
      await load(false);
    } catch (handoverError) {
      const detail = operatorErrorText(handoverError instanceof Error ? handoverError.message : '')
        || 'No se pudo guardar el traspaso en este dispositivo.';
      setError(detail);
      showSheet('Error', detail);
    } finally {
      setSaving(false);
    }
  };

  const finishShift = async () => {
    if (!shift) return;
    const invalid = materials.find((material) => usageQuantityError(usage[material.id]?.quantity || '') !== null);
    if (invalid) {
      showSheet('Cantidad inválida', `${invalid.material_name}: ${usageQuantityError(usage[invalid.id]?.quantity || '')}`);
      return;
    }

    showSheet(
      'Finalizar turno',
      'Se cerrará el turno y este informe no podrá editarse. ¿Continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Finalizar', style: 'destructive', onPress: () => persistFinishedShift() },
      ],
    );
  };

  const persistFinishedShift = async () => {
    if (!shift || shift.usage_report_submitted) return;
    setSaving(true);
    setError('');
    try {
      // The report goes once. A second copy would reduce the balance again on the
      // phone and be refused by the server, and a corrected quantity in it would be
      // lost (audit B4).
      const alreadyQueued = await queryFirst<{ found: number }>(
        `SELECT 1 AS found FROM sync_outbox WHERE entity = 'shift_end' AND entity_id = ?`,
        [shift.id],
      );
      if (alreadyQueued) {
        await load(false);
        return;
      }
      const now = timestamp();
      const usageItems = materials.map((material) => ({
        client_entry_id: createClientEntryId('shift_usage'),
        project_material_id: material.id,
        quantity_used: parseNonNegative(usage[material.id]?.quantity || '') ?? 0,
        approximate: Boolean(usage[material.id]?.approximate),
        notes: usage[material.id]?.notes.trim() || undefined,
        date: storedDateOf(now),
      }));
      const endType = shift.status === 'report_pending' ? 'auto' as const : 'manual' as const;
      const endedAt = shift.status === 'report_pending' && shift.ended_at ? shift.ended_at : now;
      const payload = {
        shiftId: shift.id,
        usage: usageItems,
        notes: shiftNotes.trim() || undefined,
        deviceEndedAt: now,
        endType,
      };

      await runInTransaction(async (transaction) => {
        for (let index = 0; index < materials.length; index += 1) {
          const material = materials[index];
          const item = usageItems[index];
          if (item.quantity_used <= 0) continue;
          const anomaly = item.quantity_used > material.current_quantity ? 1 : 0;
          await transaction.execute(
            `INSERT INTO material_consumption (
               client_entry_id, project_id, operator_id, shift_id,
               project_material_id, material_name, quantity_used, unit, date,
               notes, approximate, anomaly_flag, sync_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
              item.client_entry_id, shift.project_id, operatorId, shift.id,
              material.id, material.material_name, item.quantity_used, material.unit,
              item.date, item.notes ?? null, item.approximate ? 1 : 0, anomaly, now, now,
            ],
          );
          await transaction.execute(
            `UPDATE project_materials
             SET current_quantity = current_quantity - ?, updated_at = ? WHERE id = ?`,
            [item.quantity_used, now, material.id],
          );
        }
        // Do NOT flip status to 'closed' here. The remote end_shift RPC is the
        // authoritative call (it can reject, e.g. error 55000 when the
        // handover isn't confirmed yet) and syncPendingShiftEnds() already
        // sets status = 'closed' itself once that call actually succeeds. If
        // we set it here unconditionally and the remote call then fails, the
        // shift silently vanishes from every "unresolved shift" query in the
        // app (load() only selects status IN ('open','report_pending')) even
        // though the server still considers it open — an unrecoverable
        // local/remote split with no way for the operator to fix it.
        await recordLocalShiftEnd({
          shiftId: shift.id,
          endedAt,
          deviceEndedAt: now,
          endType,
          notes: shiftNotes.trim() || null,
          updatedAt: now,
        }, transaction.execute);
        await transaction.execute(
          `INSERT INTO sync_outbox (
             id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
           ) VALUES (?, 'shift_end', ?, 'UPDATE', ?, ?, 0, ?, ?)`,
          [createClientEntryId('outbox'), shift.id, JSON.stringify(payload), operatorId, now, now],
        );
      });

      // The shared drain sends the shift's bars first, which the close waits for.
      await drainOutboxIncludingNew().catch(() => undefined);
      // Saved on the phone either way. Only a refusal from the server is a problem
      // the operator needs to hear about now; no signal is the normal case offline.
      const close = await readShiftCloseState(shift);
      if (close.kind === 'refused') {
        const detail = `El servidor no aceptó el cierre: ${close.reason.replace(/\.$/, '')}. Pasó a revisión del administrador.`;
        setError(detail);
        showSheet('Cierre no aceptado', detail);
      } else if (close.kind === 'queued') {
        setMessage(close.barsWaiting > 0
          ? 'Informe guardado. Se enviará cuando terminen de subir las barras de este turno.'
          : 'Informe guardado en este dispositivo. Se enviará solo cuando haya conexión.');
      } else {
        setMessage('Turno finalizado e informe enviado.');
      }
      setShiftNotes('');
      await load(false);
    } catch (finishError) {
      // Only a local failure gets here: nothing was saved, so the form stays.
      const detail = operatorErrorText(finishError instanceof Error ? finishError.message : '')
        || 'No se pudo guardar el informe en este dispositivo.';
      setError(detail);
      showSheet('No se pudo guardar el informe', detail);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.muted}>Cargando turno…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
        setRefreshing(true);
        load(false);
      }} tintColor={COLORS.accent} />}
    >
      <Text style={styles.title}>Turno de trabajo</Text>
      <Text style={styles.subtitle}>El progreso y el consumo quedan vinculados a un turno verificable.</Text>

      {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
      {message ? <View style={styles.successBanner}><Text style={styles.successText}>{message}</Text></View> : null}

      {!shift ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Iniciar turno</Text>
          {hasRefusedShift ? (
            <Text style={styles.warningText}>
              El servidor rechazó un turno que iniciaste sin conexión. Lo que cargaste pasó a revisión del administrador.
            </Text>
          ) : null}
          {adminCloseReason !== null ? (
            <Text style={styles.warningText}>
              El administrador cerró tu último turno. Motivo: {adminCloseReason}
            </Text>
          ) : null}
          {projects.length === 0 ? (
            <Text style={styles.muted}>No tenés un pozo activo asignado.</Text>
          ) : projects.length === 1 ? (
            <View style={styles.projectSummary}>
              <Text style={styles.eyebrow}>POZO ASIGNADO</Text>
              <Text style={styles.projectName}>{projects[0].name}</Text>
              {projects[0].location ? <Text style={styles.muted}>{projects[0].location}</Text> : null}
            </View>
          ) : (
            <View style={styles.pickerWrap}>
              <Picker
                selectedValue={selectedProject}
                onValueChange={(value) => setSelectedProject(String(value))}
                style={styles.picker}
                dropdownIconColor={COLORS.textSecondary}
              >
                <Picker.Item label="Seleccioná un pozo…" value="" />
                {projects.map((project) => (
                  <Picker.Item key={project.id} label={project.name} value={String(project.id)} />
                ))}
              </Picker>
            </View>
          )}
          <TouchableOpacity
            style={[styles.primaryButton, (!selectedProject || saving) && styles.disabled]}
            disabled={!selectedProject || saving}
            onPress={startShift}
          >
            <Text style={styles.primaryButtonText}>{saving ? 'Iniciando…' : 'Iniciar turno'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={[styles.card, shift.status === 'report_pending' && styles.warningCard]}>
            <View style={styles.spaceBetween}>
              <View style={styles.flex}>
                <Text style={styles.eyebrow}>
                  {shift.usage_report_submitted ? 'CIERRE EN ESPERA' : shift.status === 'report_pending' ? 'INFORME PENDIENTE' : 'TURNO ACTIVO'}
                </Text>
                <Text style={styles.cardTitle}>{selectedProjectData?.name || `Pozo #${shift.project_id}`}</Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusPillText}>{shift.sync_state === 'synced' ? 'Sincronizado' : 'Pendiente'}</Text>
              </View>
            </View>
            <Text style={styles.muted}>Inicio: {formatDateTime(shift.started_at)}</Text>
            {shift.status === 'report_pending' && !shift.usage_report_submitted ? (
              <Text style={styles.warningText}>
                El turno superó 12 horas y se cerró automáticamente. Completá el informe de uso para poder iniciar otro.
              </Text>
            ) : null}
            {shift.last_error && closeState.kind !== 'refused' ? (
              <Text style={styles.errorText}>{operatorErrorText(shift.last_error)}</Text>
            ) : null}
          </View>

          {!shift.handover_confirmed ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Confirmar traspaso</Text>
              <Text style={styles.muted}>
                Si todo coincide, confirmá directamente. Marcá solo las diferencias.
              </Text>
              {materials.map((material) => {
                const draft = handover[material.id] || { flagged: false, observed: '', note: '' };
                return (
                  <View key={material.id} style={styles.lineItem}>
                    <View style={styles.spaceBetween}>
                      <View style={styles.flex}>
                        <Text style={styles.itemName}>{material.material_name}</Text>
                        <Text style={styles.muted}>{material.current_quantity} {material.unit} esperados · {material.layer}</Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.exceptionButton, draft.flagged && styles.exceptionButtonActive]}
                        onPress={() => setHandover((current) => ({
                          ...current,
                          [material.id]: { ...draft, flagged: !draft.flagged },
                        }))}
                      >
                        <Text style={styles.exceptionText}>{draft.flagged ? 'Diferencia' : 'Coincide'}</Text>
                      </TouchableOpacity>
                    </View>
                    {draft.flagged ? (
                      <>
                        <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                          style={styles.input}
                          value={draft.observed}
                          onChangeText={(observed) => setHandover((current) => ({
                            ...current, [material.id]: { ...draft, observed },
                          }))}
                          keyboardType="decimal-pad"
                          placeholder="Cantidad observada"
                          placeholderTextColor={COLORS.placeholder}
                        />
                        {quantityPreview(draft.observed) ? (
                          <Text style={styles.muted}>{quantityPreview(draft.observed)}</Text>
                        ) : null}
                        <TextInput
                          style={[styles.input, styles.noteInput]}
                          value={draft.note}
                          onChangeText={(note) => setHandover((current) => ({
                            ...current, [material.id]: { ...draft, note },
                          }))}
                          placeholder="Describí la diferencia"
                          placeholderTextColor={COLORS.placeholder}
                          multiline
                        />
                      </>
                    ) : null}
                  </View>
                );
              })}
              <TouchableOpacity style={[styles.primaryButton, saving && styles.disabled]} disabled={saving} onPress={confirmHandover}>
                <Text style={styles.primaryButtonText}>{saving ? 'Guardando…' : 'Confirmar traspaso'}</Text>
              </TouchableOpacity>
            </View>
          ) : shift.usage_report_submitted ? (
            <View style={[styles.card, closeState.kind === 'refused' && styles.warningCard]}>
              {closeState.kind === 'refused' ? (
                <>
                  <Text style={styles.cardTitle}>Cierre no aceptado</Text>
                  <Text style={styles.warningText}>
                    El servidor no aceptó el cierre de este turno: {closeState.reason.replace(/\.$/, '')}.
                  </Text>
                  <Text style={styles.muted}>
                    Pasó a revisión del administrador, que puede cerrar el turno desde su panel. No hace falta cargar el informe de nuevo.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.cardTitle}>Informe final guardado</Text>
                  <Text style={styles.muted}>
                    Tu informe quedó guardado en este dispositivo y se envía solo cuando hay conexión. No hace falta cargarlo de nuevo.
                  </Text>
                  {closeState.kind === 'queued' && closeState.barsWaiting > 0 ? (
                    <Text style={styles.muted}>
                      Primero {closeState.barsWaiting === 1 ? 'tiene que subir 1 barra' : `tienen que subir ${closeState.barsWaiting} barras`} de este turno.
                    </Text>
                  ) : null}
                  <Text style={styles.muted}>Vas a poder iniciar otro turno cuando el servidor reciba el cierre.</Text>
                </>
              )}
              <View style={styles.summaryStrip}>
                <Text style={styles.summaryText}>{bars.count} barras</Text>
                <Text style={styles.summaryText}>{bars.depth_start.toFixed(2)} → {bars.depth_end.toFixed(2)} m</Text>
              </View>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Informe para finalizar</Text>
              <Text style={styles.muted}>
                Informá cada material. Un campo vacío equivale a cero; las cantidades pueden ser exactas o aproximadas.
              </Text>

              <View style={styles.summaryStrip}>
                <Text style={styles.summaryText}>{bars.count} barras</Text>
                <Text style={styles.summaryText}>{bars.depth_start.toFixed(2)} → {bars.depth_end.toFixed(2)} m</Text>
              </View>

              {materials.map((material) => {
                const draft = usage[material.id] || { quantity: '', approximate: false, notes: '' };
                const numeric = parseNonNegative(draft.quantity) ?? 0;
                const anomaly = numeric > material.current_quantity;
                return (
                  <View key={material.id} style={styles.lineItem}>
                    <Text style={styles.itemName}>{material.material_name}</Text>
                    <Text style={styles.muted}>Disponible estimado: {material.current_quantity} {material.unit}</Text>
                    <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                      style={[styles.input, anomaly && styles.inputWarning]}
                      value={draft.quantity}
                      onChangeText={(quantity) => setUsage((current) => ({
                        ...current, [material.id]: { ...draft, quantity },
                      }))}
                      keyboardType="decimal-pad"
                      placeholder={`0 ${material.unit}`}
                      placeholderTextColor={COLORS.placeholder}
                    />
                    {quantityPreview(draft.quantity) ? (
                      <Text style={styles.muted}>{quantityPreview(draft.quantity)}</Text>
                    ) : null}
                    {anomaly ? (
                      <Text style={styles.warningText}>Supera el saldo. Se guardará como anomalía para revisión, sin perder el dato.</Text>
                    ) : null}
                    <TouchableOpacity
                      style={[styles.modeButton, draft.approximate && styles.modeButtonActive]}
                      onPress={() => setUsage((current) => ({
                        ...current, [material.id]: { ...draft, approximate: !draft.approximate },
                      }))}
                    >
                      <Text style={styles.modeText}>{draft.approximate ? 'Cantidad aproximada' : 'Cantidad exacta'}</Text>
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.input, styles.noteInput]}
                      value={draft.notes}
                      onChangeText={(notes) => setUsage((current) => ({
                        ...current, [material.id]: { ...draft, notes },
                      }))}
                      placeholder="Nota opcional"
                      placeholderTextColor={COLORS.placeholder}
                      multiline
                    />
                  </View>
                );
              })}

              <TextInput
                style={[styles.input, styles.noteInput, styles.shiftNotes]}
                value={shiftNotes}
                onChangeText={setShiftNotes}
                placeholder="Observaciones generales del turno"
                placeholderTextColor={COLORS.placeholder}
                multiline
              />
              <TouchableOpacity style={[styles.dangerButton, saving && styles.disabled]} disabled={saving} onPress={finishShift}>
                <Text style={styles.primaryButtonText}>{saving ? 'Finalizando…' : 'Finalizar turno e informe'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.xl, paddingBottom: SPACING.huge4 },
  centered: { justifyContent: 'center', alignItems: 'center', gap: SPACING.md },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  subtitle: { color: COLORS.textSecondary, fontSize: TYPE.label, marginTop: SPACING.xs, marginBottom: SPACING.xl },
  card: { backgroundColor: COLORS.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.border, padding: SPACING.lg, marginBottom: SPACING.lg },
  warningCard: { borderColor: COLORS.warning },
  cardTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold, marginBottom: SPACING.sm },
  eyebrow: { color: COLORS.primaryText, fontSize: TYPE.micro, fontWeight: TYPE.bold, letterSpacing: 1, marginBottom: SPACING.xs },
  muted: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18 },
  projectSummary: { marginVertical: SPACING.md },
  projectName: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.semibold },
  pickerWrap: { backgroundColor: COLORS.input, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, marginVertical: SPACING.md },
  picker: { color: COLORS.text },
  primaryButton: { minHeight: 48, justifyContent: 'center', backgroundColor: COLORS.primary, padding: SPACING.md, borderRadius: RADIUS.md, alignItems: 'center', marginTop: SPACING.lg },
  dangerButton: { minHeight: 48, justifyContent: 'center', backgroundColor: COLORS.danger, padding: SPACING.md, borderRadius: RADIUS.md, alignItems: 'center', marginTop: SPACING.lg },
  primaryButtonText: { color: COLORS.textOnPrimary, fontSize: TYPE.label, fontWeight: TYPE.bold },
  disabled: { opacity: 0.45 },
  errorBanner: { backgroundColor: COLORS.errorBg, borderWidth: 1, borderColor: COLORS.error, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.md },
  errorText: { color: COLORS.errorText, fontSize: TYPE.caption, lineHeight: 18 },
  successBanner: { backgroundColor: COLORS.successBg, borderWidth: 1, borderColor: COLORS.success, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.md },
  successText: { color: COLORS.successText, fontSize: TYPE.caption },
  warningText: { color: COLORS.warningText, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.sm },
  spaceBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  flex: { flex: 1 },
  statusPill: { backgroundColor: COLORS.backgroundDark, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs, borderRadius: RADIUS.pill },
  statusPillText: { color: COLORS.textSecondary, fontSize: TYPE.micro },
  lineItem: { borderTopWidth: 1, borderTopColor: COLORS.borderLight, marginTop: SPACING.md, paddingTop: SPACING.md },
  itemName: { color: COLORS.text, fontSize: TYPE.label, fontWeight: TYPE.semibold, marginBottom: SPACING.xs },
  exceptionButton: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: COLORS.success, backgroundColor: COLORS.successBg, borderRadius: RADIUS.pill, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  exceptionButtonActive: { borderColor: COLORS.warning, backgroundColor: COLORS.warningBg },
  exceptionText: { color: COLORS.text, fontSize: TYPE.micro, fontWeight: TYPE.bold },
  input: { backgroundColor: COLORS.input, color: COLORS.text, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.sm },
  inputWarning: { borderColor: COLORS.warning },
  noteInput: { minHeight: 56, textAlignVertical: 'top' },
  modeButton: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.pill, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, marginTop: SPACING.sm },
  modeButtonActive: { borderColor: COLORS.accent, backgroundColor: 'rgba(78,134,216,0.16)' },
  modeText: { color: COLORS.textSecondary, fontSize: TYPE.caption },
  summaryStrip: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: COLORS.backgroundDark, borderRadius: RADIUS.md, padding: SPACING.md, marginTop: SPACING.md },
  summaryText: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  shiftNotes: { marginTop: SPACING.lg },
});

export default TurnosTab;
