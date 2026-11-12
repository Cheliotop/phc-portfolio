import { useEffect, useState } from 'react';
import { projectsApi } from '../api/supabase-projects';
import { friendlyApiError } from '../api/supabase-api-errors';
import { productProjectsApi } from '../api/supabase-product-projects';
import { shiftsApi } from '../api/supabase-shifts';
import type { AuditEntry, OperatorAccountabilityMetrics, OperatorDirectoryEntry, Shift, ShiftStatus } from '../types/productV2';
import { formatCorrectionPreview } from '../domain/correctionPreview';
import { defaultMetricsPeriod, type MetricsPeriod } from '../domain/metricsPeriod';
import {
  correctionFields,
  correctionPlaceholder,
  fieldKind,
  parseCorrectionValue,
  type CorrectionEntity,
} from '../domain/correctionValue';
import { asuncionLocalInput, validateForceCloseEnd } from '../domain/forceClose';

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

const EMPTY_FILTERS: OperationFilters = {
  projectId: '',
  operatorId: '',
  shiftStatus: '',
  entityType: '',
  action: '',
};

// How many shifts and audit events each "Cargar más" adds (audit WEB-7).
const PAGE_SIZE = 150;

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

const CORRECTION_ENTITIES: CorrectionEntity[] = ['drilling_bars', 'shifts', 'material_consumption', 'water_samples', 'completion_reports'];

// How the admin names the record inside the chosen well (audit WEB-1: the web
// never shows database ids, so bars and samples go by the number on screen).
const CORRECTION_REFERENCE: Record<CorrectionEntity, { label: string; placeholder: string; missing: string }> = {
  drilling_bars: { label: 'N.º de barra', placeholder: 'Ej: 7', missing: 'Ese pozo no tiene una barra con ese número.' },
  water_samples: { label: 'N.º de muestra', placeholder: 'Ej: 3', missing: 'Ese pozo no tiene una muestra con ese número.' },
  shifts: { label: 'Turno', placeholder: 'Usá «Corregir» en la lista de turnos', missing: 'Ese turno no es de este pozo. Usá «Corregir» en la lista de turnos.' },
  material_consumption: { label: 'ID del consumo', placeholder: 'Ej: 42', missing: 'Ese pozo no tiene un consumo con ese ID.' },
  completion_reports: { label: 'Ficha del pozo', placeholder: '', missing: 'Ese pozo todavía no tiene Ficha.' },
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  // Paraguay time, whatever zone the admin's computer is set to (audit WEB-15).
  return parsed.toLocaleString('es-PY', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Asuncion',
  });
};

const formatHours = (start: string, end?: string | null) => {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '—';
  return `${Math.round(((endMs - startMs) / 36e5) * 10) / 10} h`;
};

const operatorName = (operator?: OperatorDirectoryEntry) =>
  operator?.full_name || operator?.username || 'Operador';

const shiftStatusLabel = (status: ShiftStatus) => {
  if (status === 'open') return 'Abierto';
  if (status === 'report_pending') return 'Informe pendiente';
  return 'Cerrado';
};

const shiftStatusTone = (status: ShiftStatus) => {
  if (status === 'open') return 'badge-active';
  if (status === 'report_pending') return 'badge-danger';
  return 'badge-success';
};

const humanize = (value: string) => value.replaceAll('.', ' · ').replaceAll('_', ' ');

// Table and column names reached the admin in English ("drilling bars", "depth end")
// (code read W11). Anything not listed falls back to humanize().
const LABELS: Record<string, string> = {
  projects: 'Proyectos', project_closing_assignments: 'Responsables de cierre', shifts: 'Turnos',
  catalog_materials: 'Materiales del catálogo', catalog_variants: 'Variantes del catálogo',
  project_materials: 'Materiales del pozo', material_reconciliations: 'Reconciliaciones',
  pedidos: 'Pedidos', pedido_items: 'Ítems de pedido', completion_reports: 'Fichas',
  completion_discrepancies: 'Discrepancias de Ficha', water_samples: 'Muestras de agua',
  project_attachments: 'Adjuntos', photos: 'Fotos', drilling_bars: 'Barras',
  material_consumption: 'Consumo de materiales',
  depth_start: 'Profundidad inicial', depth_end: 'Profundidad final', length: 'Longitud',
  diameter: 'Diámetro', soil_type: 'Tipo de suelo', start_time: 'Hora de inicio',
  end_time: 'Hora de fin', duration_minutes: 'Duración (min)', water_level: 'Nivel de agua',
  notes: 'Notas', started_at: 'Inicio', ended_at: 'Fin', end_type: 'Tipo de cierre',
  quantity_used: 'Cantidad usada', unit: 'Unidad', date: 'Fecha', approximate: 'Aproximado',
  sample_number: 'Número de muestra', depth_m: 'Profundidad (m)', stage: 'Etapa', taken_at: 'Tomada',
  static_level: 'Nivel estático', dynamic_level: 'Nivel dinámico', flow_rate: 'Caudal bombeado',
  specific_flow_rate: 'Caudal específico', maximum_flow_rate: 'Caudal máximo',
  pump_depth_m: 'Profundidad de bomba (m)', exploration_depth_m: 'Profundidad de exploración (m)',
  widening_depth_m: 'Profundidad de ensanche (m)', casing_total_m: 'Entubado total (m)',
  casing_layout: 'Esquema de entubado', water_quality: 'Calidad del agua', completion_notes: 'Notas finales',
  casing_above_ground_m: 'Entubado sobre el suelo (m)', blind_casing_m: 'Entubado ciego (m)',
  filter_casing_m: 'Entubado filtro (m)', sediment_trap_m: 'Trampa de sedimentos (m)',
  centralizer_count: 'Cantidad de centradores', bottom_plug_details: 'Tapón de fondo',
  bentonite_quantity: 'Bentonita', gravel_quantity: 'Grava',
  compressor_hours: 'Horas de compresor', pump_hours: 'Horas de bomba',
};
const label = (value: string) => LABELS[value] || humanize(value);
const auditActionLabel = (action: string) =>
  action === 'shift.force_closed' ? 'Turno cerrado por el administrador' : humanize(action);

const EMPTY_FLAGS = { autoClosed: 0, reportMissing: 0 };

export const Operacion = () => {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [operators, setOperators] = useState<OperatorDirectoryEntry[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [shiftsTotal, setShiftsTotal] = useState(0);
  const [shiftFlags, setShiftFlags] = useState(EMPTY_FLAGS);
  const [shiftLimit, setShiftLimit] = useState(PAGE_SIZE);
  const [metrics, setMetrics] = useState<OperatorAccountabilityMetrics[]>([]);
  const [metricsFailed, setMetricsFailed] = useState<string[]>([]);
  const [shiftParticipants, setShiftParticipants] = useState<Record<string, string[]>>({});
  const [metricsPeriod, setMetricsPeriod] = useState<MetricsPeriod>(() => defaultMetricsPeriod());
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLimit, setAuditLimit] = useState(PAGE_SIZE);
  const [draftFilters, setDraftFilters] = useState<OperationFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<OperationFilters>(EMPTY_FILTERS);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // entityId is what the admin types: a bar or sample number, a consumption id or,
  // filled by a shift's "Corregir", the shift's id. The lookup turns it into the
  // record inside the chosen well, and the save uses that record's own id (WEB-1).
  const [correction, setCorrection] = useState<{ projectId: string; entityType: CorrectionEntity; entityId: string; fieldName: string; value: string; reason: string }>({ projectId: '', entityType: 'drilling_bars', entityId: '', fieldName: 'depth_end', value: '', reason: '' });
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [correctionRecord, setCorrectionRecord] = useState<{ key: string; record: Record<string, unknown> } | null>(null);
  const [correctionLookup, setCorrectionLookup] = useState<'idle' | 'loading' | 'missing' | 'error' | 'ready'>('idle');
  const [forceClose, setForceClose] = useState<{ shiftId: string; reason: string; endedAt: string } | null>(null);
  const [savingForceClose, setSavingForceClose] = useState(false);

  const saveForceClose = async () => {
    if (!forceClose) return;
    if (forceClose.reason.trim().length < 3) {
      setError('Indicá el motivo del cierre.');
      return;
    }
    const shift = shifts.find((row) => row.id === forceClose.shiftId);
    if (!shift) {
      setError('No se encontró el turno. Actualizá la lista e intentá de nuevo.');
      return;
    }
    const end = validateForceCloseEnd(shift.started_at, forceClose.endedAt);
    if (!end.ok) {
      setError(end.error);
      return;
    }
    setSavingForceClose(true);
    setError(null);
    setNotice(null);
    try {
      await shiftsApi.forceClose(forceClose.shiftId, forceClose.reason.trim(), end.endedAtIso);
      setNotice('Turno cerrado. El motivo y la hora de fin quedaron en el historial.');
      setForceClose(null);
      setReloadToken((value) => value + 1);
    } catch (closeError) {
      setError(friendlyApiError(closeError, 'No se pudo cerrar el turno.').message);
    } finally {
      setSavingForceClose(false);
    }
  };

  const correctionKey = `${correction.projectId}:${correction.entityType}:${correction.entityType === 'completion_reports' ? '' : correction.entityId.trim()}`;

  // The value as the server will receive it, or the reason it cannot be sent (WEB-8).
  const typedValue = parseCorrectionValue(correction.entityType, correction.fieldName, correction.value);

  const startShiftCorrection = (shift: Shift) => {
    setError(null);
    setNotice(null);
    setCorrection((current) => ({
      ...current, projectId: String(shift.project_id), entityType: 'shifts', entityId: shift.id,
      fieldName: correctionFields('shifts')[0], value: '',
    }));
    document.getElementById('correction-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const saveCorrection = async () => {
    if (!correctionRecord || correctionRecord.key !== correctionKey || correctionLookup !== 'ready' || !correction.fieldName || correction.reason.trim().length < 3 || !correction.value.trim()) {
      setError('Pozo, registro, campo, valor corregido y motivo son obligatorios.');
      return;
    }
    if (!typedValue.ok) {
      setError(typedValue.error);
      return;
    }
    setSavingCorrection(true);
    setError(null);
    setNotice(null);
    try {
      const preview = formatCorrectionPreview(correction.entityType, correctionRecord.record, correction.fieldName, typedValue.display);
      await productProjectsApi.recordCorrection({
        entityType: correction.entityType,
        entityId: String(correctionRecord.record.id),
        fieldName: correction.fieldName,
        correctedValue: typedValue.value,
        reason: correction.reason,
      });
      setNotice(`Corrección guardada: ${preview.wellName} · ${preview.recordLabel}. El valor original permanece intacto y el dossier mostrará ambos.`);
      setCorrection((current) => ({ ...current, entityId: '', value: '', reason: '' }));
      setReloadToken((value) => value + 1);
    } catch (correctionError) {
      setError(friendlyApiError(correctionError, 'No se pudo registrar la corrección.').message);
    } finally {
      setSavingCorrection(false);
    }
  };

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
    void productProjectsApi.getCorrectionRecord(correction.entityType, Number(correction.projectId), reference).then((record) => {
      if (cancelled) return;
      if (!record) {
        setCorrectionLookup('missing');
        return;
      }
      setCorrectionRecord({ key, record });
      setCorrectionLookup('ready');
    }).catch(() => {
      if (!cancelled) setCorrectionLookup('error');
    });
    return () => { cancelled = true; };
  }, [correctionKey, correction.entityType, correction.projectId, correction.entityId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [projectRows, operatorRows] = await Promise.all([
          projectsApi.getAll({ orderBy: 'created_at', orderDir: 'desc' }) as Promise<ProjectOption[]>,
          shiftsApi.getOperatorDirectory(),
        ]);
        const selectedOperators = appliedFilters.operatorId
          ? operatorRows.filter((operator) => operator.id === appliedFilters.operatorId)
          : operatorRows;
        const shiftFilters = {
          projectId: appliedFilters.projectId ? Number(appliedFilters.projectId) : undefined,
          operatorId: appliedFilters.operatorId || undefined,
          status: appliedFilters.shiftStatus || undefined,
        };
        const [shiftPage, flags, metricResult, auditPage] = await Promise.all([
          shiftsApi.getPage({ ...shiftFilters, limit: shiftLimit }),
          shiftsApi.countFlags(shiftFilters),
          shiftsApi.getAllOperatorMetrics(selectedOperators, metricsPeriod),
          productProjectsApi.getAudit({
            projectId: appliedFilters.projectId ? Number(appliedFilters.projectId) : undefined,
            actorId: appliedFilters.operatorId || undefined,
            entityType: appliedFilters.entityType || undefined,
            action: appliedFilters.action || undefined,
            limit: auditLimit,
          }),
        ]);
        const participantRows = await shiftsApi.getShiftParticipants(shiftPage.rows.map((shift) => shift.id));
        if (cancelled) return;
        setProjects(projectRows);
        setOperators(operatorRows);
        setShifts(shiftPage.rows);
        setShiftsTotal(shiftPage.total);
        setShiftFlags(flags);
        setShiftParticipants(participantRows);
        setMetrics(metricResult.metrics);
        setMetricsFailed(metricResult.failed.map((operator) => operatorName(operator)));
        setAudit(auditPage.rows);
        setAuditTotal(auditPage.total);
      } catch (loadError) {
        if (!cancelled) setError(friendlyApiError(loadError, 'No se pudo cargar la operación.').message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [appliedFilters, metricsPeriod, reloadToken, shiftLimit, auditLimit]);

  const applyFilters = (next: OperationFilters) => {
    setShiftLimit(PAGE_SIZE);
    setAuditLimit(PAGE_SIZE);
    setAppliedFilters(next);
  };

  const projectName = (projectId: number) => projects.find((project) => project.id === projectId)?.name || `Proyecto #${projectId}`;
  const operatorById = (operatorId: string) => operators.find((operator) => operator.id === operatorId);
  const forceCloseShift = forceClose ? shifts.find((row) => row.id === forceClose.shiftId) : undefined;

  return (
    <div>
      <div className="card-header management-toolbar">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Operación</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>Turnos, cumplimiento por operador e historial auditable</p>
        </div>
        <button className="btn-secondary" disabled={loading} onClick={() => setReloadToken((value) => value + 1)}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}
      {notice && <div className="success-message" role="status">{notice}</div>}

      <div className="card operation-filters">
        <div className="responsive-form-grid">
          <div>
            <label className="field-label" htmlFor="metrics-from">Desde</label>
            <input id="metrics-from" className="field-input" type="date" value={metricsPeriod.from} max={metricsPeriod.to}
              onChange={(event) => setMetricsPeriod((period) => ({ ...period, from: event.target.value }))} />
          </div>
          <div>
            <label className="field-label" htmlFor="metrics-to">Hasta</label>
            <input id="metrics-to" className="field-input" type="date" value={metricsPeriod.to} min={metricsPeriod.from} max={defaultMetricsPeriod().to}
              onChange={(event) => setMetricsPeriod((period) => ({ ...period, to: event.target.value }))} />
          </div>
          <div>
            <label className="field-label" htmlFor="operation-project">Proyecto</label>
            <select id="operation-project" className="field-input" value={draftFilters.projectId} onChange={(event) => setDraftFilters({ ...draftFilters, projectId: event.target.value })}>
              <option value="">Todos los proyectos</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="operation-operator">Operador</label>
            <select id="operation-operator" className="field-input" value={draftFilters.operatorId} onChange={(event) => setDraftFilters({ ...draftFilters, operatorId: event.target.value })}>
              <option value="">Todos los operadores</option>
              {operators.map((operator) => <option key={operator.id} value={operator.id}>{operatorName(operator)}{operator.is_active ? '' : ' (inactivo)'}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="operation-status">Estado del turno</label>
            <select id="operation-status" className="field-input" value={draftFilters.shiftStatus} onChange={(event) => setDraftFilters({ ...draftFilters, shiftStatus: event.target.value as OperationFilters['shiftStatus'] })}>
              <option value="">Todos</option>
              <option value="open">Abierto</option>
              <option value="report_pending">Informe pendiente</option>
              <option value="closed">Cerrado</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="operation-entity">Entidad del historial</label>
            <select id="operation-entity" className="field-input" value={draftFilters.entityType} onChange={(event) => setDraftFilters({ ...draftFilters, entityType: event.target.value })}>
              <option value="">Todas</option>
              {ENTITY_TYPES.map((entity) => <option key={entity} value={entity}>{label(entity)}</option>)}
            </select>
          </div>
          <div className="grid-span-full">
            <label className="field-label" htmlFor="operation-action">Acción del historial</label>
            <input id="operation-action" className="field-input" value={draftFilters.action} onChange={(event) => setDraftFilters({ ...draftFilters, action: event.target.value })} placeholder="código del evento, ej: shift.closed" />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn-primary button-auto" onClick={() => applyFilters({ ...draftFilters })}>Aplicar filtros</button>
          <button className="btn-secondary" onClick={() => { setDraftFilters(EMPTY_FILTERS); applyFilters(EMPTY_FILTERS); }}>Limpiar</button>
        </div>
      </div>

      <section className="card">
        <div className="section-title-row">
          <div>
            <div className="card-title">Turnos</div>
            <div className="card-subtitle">
              {shifts.length < shiftsTotal
                ? `Mostrando los primeros ${shifts.length} de ${shiftsTotal} turno(s) según los filtros`
                : `${shiftsTotal} turno(s) según los filtros`}
            </div>
          </div>
          <div className="flag-summary">
            <span className="badge badge-danger">{shiftFlags.autoClosed} autocierre(s)</span>
            <span className="badge badge-warning">{shiftFlags.reportMissing} informe(s) faltante(s)</span>
          </div>
        </div>
        {loading && shifts.length === 0 ? (
          <div className="loading-screen">Cargando turnos…</div>
        ) : shifts.length === 0 ? (
          <p className="text-muted">No hay turnos para los filtros seleccionados.</p>
        ) : (
          <div className="operation-list">
            {shifts.map((shift) => {
              const flagged = (shift.shift_handovers || []).filter((handover) => handover.status === 'flagged');
              // A force-closed shift has its own badge: its report will never arrive.
              const reportOutstanding = shift.status !== 'open' && !shift.usage_report_submitted && shift.end_type !== 'admin';
              return (
                <article key={shift.id} className="operation-row">
                  <div className="operation-row-main">
                    <div>
                      <strong>{shift.projects?.name || projectName(shift.project_id)}</strong>
                      <div className="catalog-meta">{shift.profiles?.full_name || shift.profiles?.username || operatorName(operatorById(shift.operator_id))}</div>
                    </div>
                    <span className={`badge ${shiftStatusTone(shift.status)}`}>{shiftStatusLabel(shift.status)}</span>
                  </div>
                  <div className="operation-time-grid">
                    <span><strong>Inicio:</strong> {formatDateTime(shift.started_at)}</span>
                    <span><strong>Fin:</strong> {formatDateTime(shift.ended_at)}</span>
                    <span><strong>Duración:</strong> {formatHours(shift.started_at, shift.ended_at)}</span>
                  </div>
                  <div className="catalog-meta"><strong>En el turno:</strong> {(shiftParticipants[shift.id] || []).map((id) => operatorName(operatorById(id))).join(', ') || '—'}</div>
                  <div className="flag-summary">
                    {shift.end_type === 'auto' && <span className="badge badge-danger">Cierre automático</span>}
                    {shift.end_type === 'admin' && <span className="badge badge-danger">Cerrado por el administrador</span>}
                    {shift.end_type === 'admin' && !shift.usage_report_submitted && <span className="badge badge-warning">Sin informe de uso</span>}
                    {reportOutstanding && <span className="badge badge-warning">Informe pendiente</span>}
                    <span className={`badge ${shift.handover_confirmed ? 'badge-success' : 'badge-neutral'}`}>
                      {shift.handover_confirmed ? 'Entrega confirmada' : 'Entrega sin confirmar'}
                    </span>
                    {shift.device_time_flag && <span className="badge badge-warning">Hora del dispositivo observada</span>}
                    {shift.reassigned_during_shift && <span className="badge badge-warning">Pozo reasignado durante el turno</span>}
                    {flagged.length > 0 && <span className="badge badge-danger">{flagged.length} diferencia(s) en entrega</span>}
                  </div>
                  {flagged.map((handover) => (
                    <div className="handover-alert" key={handover.id}>
                      <strong>{handover.project_materials?.material_name || `Material #${handover.project_material_id}`}</strong>
                      {' · '}esperado {handover.expected_quantity} {handover.project_materials?.unit || ''}
                      {' · '}observado {handover.observed_quantity ?? '—'} {handover.project_materials?.unit || ''}
                      {handover.note ? ` · ${handover.note}` : ''}
                    </div>
                  ))}
                  {shift.end_type === 'admin' && shift.notes && <div className="audit-reason">Motivo: {shift.notes}</div>}
                  {forceClose?.shiftId !== shift.id && (
                    <div className="form-actions">
                      {shift.status !== 'closed' && (
                        <button className="btn-secondary button-auto" onClick={() => {
                          setError(null);
                          setForceClose({ shiftId: shift.id, reason: '', endedAt: asuncionLocalInput(new Date()) });
                        }}>Cerrar turno</button>
                      )}
                      <button className="btn-secondary button-auto" onClick={() => startShiftCorrection(shift)}>Corregir</button>
                    </div>
                  )}
                  {shift.status !== 'closed' && forceClose?.shiftId === shift.id && forceCloseShift && (
                    <div style={{ marginTop: 12 }}>
                      <p className="card-subtitle">El turno se cierra sin informe de uso, y no se puede deshacer. Hacelo solo si el operador no puede cerrarlo.</p>
                      {/* The banner at the top can be a long way up this list. */}
                      {error && <div className="login-error" role="alert">{error}</div>}
                      <label className="field-label" htmlFor="force-close-ended">Hora real de fin</label>
                      <input id="force-close-ended" className="field-input" type="datetime-local"
                        value={forceClose.endedAt}
                        min={asuncionLocalInput(new Date(forceCloseShift.started_at))}
                        max={asuncionLocalInput(new Date())}
                        onChange={(event) => setForceClose({ ...forceClose, endedAt: event.target.value })} />
                      <p className="card-subtitle">Entre el inicio del turno y ahora, como máximo 12 h después del inicio. Por defecto, la hora actual.</p>
                      <label className="field-label" htmlFor="force-close-reason">Motivo obligatorio</label>
                      <textarea id="force-close-reason" className="field-input" value={forceClose.reason} onChange={(event) => setForceClose({ ...forceClose, reason: event.target.value })} />
                      <div className="form-actions">
                        <button className="btn-secondary button-auto" disabled={savingForceClose} onClick={() => setForceClose(null)}>Cancelar</button>
                        <button className="btn-danger" disabled={savingForceClose} onClick={() => void saveForceClose()}>{savingForceClose ? 'Cerrando…' : 'Confirmar cierre'}</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {shifts.length < shiftsTotal && (
          <div className="form-actions">
            <button className="btn-secondary button-auto" disabled={loading} onClick={() => setShiftLimit((limit) => limit + PAGE_SIZE)}>
              {loading ? 'Cargando…' : `Cargar más turnos (${shiftsTotal - shifts.length} restantes)`}
            </button>
          </div>
        )}
      </section>

      <section>
        <div className="section-title-row section-outside-card">
          <div>
            <h3 className="card-title" style={{ marginBottom: 4 }}>Responsabilidad por operador</h3>
            <p className="card-subtitle" style={{ marginBottom: 0 }}>Métricas calculadas desde turnos, barras, reportes y pedidos. Las horas cuentan cada turno en que el operador participó.</p>
          </div>
        </div>
        {metricsFailed.length > 0 && (
          <div className="login-error" role="alert">No se pudieron cargar las métricas de: {metricsFailed.join(', ')}. Actualizá para reintentar.</div>
        )}
        {metrics.length === 0 && !loading ? (
          <div className="card"><p className="text-muted">No hay operadores para mostrar.</p></div>
        ) : (
          <div className="operator-metrics-grid">
            {metrics.map((metric) => (
              <article className="card operator-metric-card" key={metric.operator_id}>
                <div className="catalog-title-row">
                  <span className="card-title">{operatorName(metric.operator)}</span>
                  <span className={`badge ${metric.account_active ? 'badge-success' : 'badge-neutral'}`}>{metric.account_active ? 'Activo' : 'Inactivo'}</span>
                </div>
                <div className="metric-context">
                  <span><strong>Pozo actual:</strong> {metric.current_project?.name || '—'}</span>
                  <span><strong>Turno:</strong> {metric.current_shift ? shiftStatusLabel(metric.current_shift.status) : 'Sin turno abierto'}</span>
                </div>
                <div className="compact-metrics-grid">
                  <div><strong>{metric.shifts_completed}</strong><span>Turnos</span></div>
                  <div><strong>{metric.hours_worked}</strong><span>Horas</span></div>
                  <div><strong>{metric.bars_registered}</strong><span>Barras</span></div>
                  <div><strong>{metric.average_bar_minutes}</strong><span>Min/barra</span></div>
                  <div><strong>{metric.material_reports_submitted}</strong><span>Informes</span></div>
                  <div className={metric.missing_or_late_reports > 0 ? 'metric-alert' : ''}><strong>{metric.missing_or_late_reports}</strong><span>Faltantes/tarde</span></div>
                  <div className={metric.flagged_shifts > 0 ? 'metric-alert' : ''}><strong>{metric.flagged_shifts}</strong><span>Horario a revisar</span></div>
                  <div><strong>{metric.active_pedidos}</strong><span>Pedidos activos</span></div>
                </div>
                <div className="catalog-meta">Ultima actividad: {formatDateTime(metric.last_activity)}</div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 22 }}>
        <div className="card-title" id="correction-form">Corrección administrativa</div>
        <div className="card-subtitle">El registro original nunca se modifica. La corrección requiere motivo y aparece marcada en el dossier. Los totales calculados (profundidad de barras posteriores, stock de materiales y horas de turno) siguen usando el valor original.</div>
        <div className="responsive-form-grid">
          <div>
            <label className="field-label" htmlFor="correction-project">Pozo</label>
            <select id="correction-project" className="field-input" value={correction.projectId} onChange={(event) => setCorrection({ ...correction, projectId: event.target.value, entityId: correction.entityType === 'shifts' ? '' : correction.entityId })}>
              <option value="">Elegí el pozo</option>
              {projects.map((project) => <option key={project.id} value={String(project.id)}>{project.name}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="correction-entity">Entidad</label>
            <select id="correction-entity" className="field-input" value={correction.entityType} onChange={(event) => {
              const entityType = event.target.value as CorrectionEntity;
              setCorrection({ ...correction, entityType, entityId: '', fieldName: correctionFields(entityType)[0] });
            }}>
              {CORRECTION_ENTITIES.map((entity) => <option key={entity} value={entity}>{label(entity)}</option>)}
            </select>
          </div>
          {correction.entityType !== 'completion_reports' && (
            <div>
              <label className="field-label" htmlFor="correction-id">{CORRECTION_REFERENCE[correction.entityType].label}</label>
              <input id="correction-id" className="field-input" value={correction.entityId} onChange={(event) => setCorrection({ ...correction, entityId: event.target.value })} placeholder={CORRECTION_REFERENCE[correction.entityType].placeholder} />
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="correction-field">Campo</label>
            <select id="correction-field" className="field-input" value={correction.fieldName} onChange={(event) => setCorrection({ ...correction, fieldName: event.target.value })}>
              {correctionFields(correction.entityType).map((field) => <option key={field} value={field}>{label(field)}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="correction-value">Valor corregido</label>
            <input id="correction-value" className="field-input" value={correction.value} onChange={(event) => setCorrection({ ...correction, value: event.target.value })} placeholder={correctionPlaceholder(fieldKind(correction.entityType, correction.fieldName))} />
          </div>
          <div className="grid-span-full">
            <label className="field-label" htmlFor="correction-reason">Motivo obligatorio</label>
            <textarea id="correction-reason" className="field-input" value={correction.reason} onChange={(event) => setCorrection({ ...correction, reason: event.target.value })} />
          </div>
        </div>
        {correctionLookup === 'loading' && <p className="card-subtitle" role="status">Buscando el registro…</p>}
        {correctionLookup === 'missing' && <p className="login-error" role="alert">{CORRECTION_REFERENCE[correction.entityType].missing}</p>}
        {correctionLookup === 'error' && <p className="login-error" role="alert">No se pudo buscar el registro. Intentá de nuevo.</p>}
        {correction.value.trim() && !typedValue.ok && <p className="login-error" role="alert">{typedValue.error}</p>}
        {correctionLookup === 'ready' && correctionRecord && correctionRecord.key === correctionKey && typedValue.ok && (() => {
          const preview = formatCorrectionPreview(correction.entityType, correctionRecord.record, correction.fieldName, typedValue.display);
          return <div className="audit-reason" role="status">
            <strong>Vas a corregir:</strong> {preview.wellName} · {preview.recordLabel}<br />
            {label(correction.fieldName)}: {preview.currentValue} → {preview.correctedValue}
          </div>;
        })()}
        <div className="form-actions">
          <button className="btn-danger" disabled={savingCorrection || correctionLookup !== 'ready' || !correctionRecord || correctionRecord.key !== correctionKey || !typedValue.ok} onClick={() => void saveCorrection()}>{savingCorrection ? 'Registrando…' : 'Guardar corrección'}</button>
        </div>
      </section>

      <section className="card audit-section">
        <div className="card-title">Historial del proyecto</div>
        <div className="card-subtitle">
          {audit.length < auditTotal
            ? `Mostrando los primeros ${audit.length} de ${auditTotal} evento(s); el registro es append-only`
            : `${auditTotal} evento(s); el registro es append-only`}
        </div>
        {loading && audit.length === 0 ? (
          <div className="loading-screen">Cargando historial…</div>
        ) : audit.length === 0 ? (
          <p className="text-muted">No hay eventos para los filtros seleccionados.</p>
        ) : (
          <div className="audit-timeline">
            {audit.map((entry) => (
              <article className="audit-entry" key={entry.id}>
                <div className="audit-marker" aria-hidden="true" />
                <div className="audit-content">
                  <div className="operation-row-main">
                    <strong>{auditActionLabel(entry.action)}</strong>
                    <time dateTime={entry.created_at}>{formatDateTime(entry.created_at)}</time>
                  </div>
                  <div className="catalog-meta">
                    {entry.project_id ? projectName(entry.project_id) : 'Sin proyecto'} · {label(entry.entity_type)} #{entry.entity_id}
                  </div>
                  <div className="catalog-meta">Actor: {entry.profiles?.full_name || entry.profiles?.username || 'Sistema'}</div>
                  {entry.reason && <div className="audit-reason">Motivo: {entry.reason}</div>}
                </div>
              </article>
            ))}
          </div>
        )}
        {audit.length < auditTotal && (
          <div className="form-actions">
            <button className="btn-secondary button-auto" disabled={loading} onClick={() => setAuditLimit((limit) => limit + PAGE_SIZE)}>
              {loading ? 'Cargando…' : `Cargar más eventos (${auditTotal - audit.length} restantes)`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
};
