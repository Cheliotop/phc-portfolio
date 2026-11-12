import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { completionApi } from '../api/supabase-completion';
import { friendlyApiError } from '../api/supabase-api-errors';
import { operatorsApi } from '../api/supabase-operators';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';
import {
  isDossierMismatch,
  isDossierReplyCurrent,
  shouldReloadAfterAction,
} from '../domain/cierresGuards';
import {
  arrivedLateLabel,
  buildDossierCrew,
  EMPTY_DOSSIER_CREW,
  enteredByLabel,
  shiftCrewLabel,
  type DossierCrew,
  type ShiftParticipantRow,
} from '../domain/dossierCrew';
import type {
  CompletionDiscrepancy,
  CompletionReport,
  JsonRecord,
  ProjectDossier,
} from '../types/completionReview';
import { printDossier } from '../utils/printableDossier';
import { inBatches } from '../domain/paging.ts';

const formatDateTime = (value?: string | null) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('es-PY', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Asuncion',
  });
};

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '—'; }
  }
  return String(value);
};

const projectName = (report: CompletionReport) =>
  report.projects?.well_name || report.projects?.name || `Proyecto #${report.project_id}`;

const operatorName = (report: CompletionReport) =>
  report.profiles?.full_name || report.profiles?.username || 'Operador sin nombre';

const normalizedStatus = (value: unknown) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const isOpenCompanyPedido = (pedido: JsonRecord) =>
  !['cerrado', 'rechazado'].includes(normalizedStatus(pedido.status));

interface Column {
  label: string;
  render: (row: JsonRecord) => ReactNode;
}

const DataTable = ({ rows, columns, empty }: { rows: JsonRecord[]; columns: Column[]; empty: string }) => {
  if (!rows.length) return <p className="text-muted">{empty}</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? `${index}-${columns.length}`)}>
              {columns.map((column) => <td key={column.label}>{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const DossierSection = ({ title, subtitle, children, open = false }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  open?: boolean;
}) => (
  <details open={open} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
      {title}{subtitle ? <span className="text-muted" style={{ fontWeight: 400 }}> · {subtitle}</span> : null}
    </summary>
    <div style={{ marginTop: 12 }}>{children}</div>
  </details>
);

/**
 * `correctionFor` shows an admin's correction instead of the stored value, marked,
 * as the printed dossier does. Without it the admin signed from different numbers
 * than the client receives (code read W1).
 */
const ReadOnlyFields = ({ record, fields, correctionFor }: {
  record: JsonRecord;
  fields: Array<{ key: string; label: string; format?: (value: unknown) => string }>;
  correctionFor?: (key: string) => JsonRecord | undefined;
}) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
    {fields.map((field) => {
      const correction = correctionFor?.(field.key);
      const value = correction ? correction.corrected_value : record[field.key];
      const text = field.format ? field.format(value) : displayValue(value);
      return (
        <div key={field.key} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
          <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700 }}>{field.label}</div>
          <div style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
            {text}{correction ? <> <span className="badge badge-warning">corregido</span></> : null}
          </div>
        </div>
      );
    })}
  </div>
);

// Stored codes in the dossier tables, in words (code read W8). Unknown codes show as is.
const WORDS: Record<string, string> = {
  open: 'Abierto', report_pending: 'Informe pendiente', closed: 'Cerrado', rejected: 'Rechazado',
  manual: 'Por el operador', auto: 'Automático (12 h)', admin: 'Por el administrador',
  confirmed: 'Coincide', flagged: 'Diferencia', field: 'Campo', water_sample: 'Muestra de agua',
  recibido: 'Recibido', parcial: 'Entrega parcial', no_recibido: 'No recibido',
  shifts: 'Turno', drilling_bars: 'Barra', completion_reports: 'Ficha', material_consumption: 'Consumo',
  water_samples: 'Muestra de agua', projects: 'Proyecto', pedidos: 'Pedido', pedido_items: 'Ítem de pedido',
  photos: 'Foto', project_materials: 'Material',
};
const inWords = (value: unknown) => (typeof value === 'string' && WORDS[value]) || displayValue(value);

// Who is on each shift and who entered each row. Loaded with the dossier so a reply
// and its names always belong together.
// Shift ids go in the URL, so a long well is read in batches (inBatches).
const loadDossierCrew = async (shiftIds: string[]): Promise<DossierCrew> => {
  const [replies, operators] = await Promise.all([
    Promise.all(inBatches(shiftIds).map((ids) =>
      supabase.from('shift_participants').select('shift_id, operator_id').in('shift_id', ids))),
    operatorsApi.getAll(),
  ]);
  const failed = replies.find((reply) => reply.error);
  if (failed?.error) {
    throw friendlyApiError(failed.error, 'No se pudo cargar quién participó de cada turno.');
  }
  const participants = replies.flatMap((reply) => (reply.data || []) as ShiftParticipantRow[]);
  return buildDossierCrew(operators, participants);
};

const FICHA_STATUS: Record<string, string> = {
  submitted: 'Enviada, pendiente de firma',
  returned: 'Devuelta al operador',
  approved: 'Firmada',
};

export const Cierres = () => {
  const { user } = useAuth();
  const [reports, setReports] = useState<CompletionReport[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dossier, setDossier] = useState<ProjectDossier | null>(null);
  const [crew, setCrew] = useState<DossierCrew | null>(null);
  const [loadingReports, setLoadingReports] = useState(true);
  const [loadingDossier, setLoadingDossier] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState<Record<number, string>>({});
  const [returnReason, setReturnReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fileFallback, setFileFallback] = useState<{ url: string; label: string } | null>(null);
  const dossierRequestRef = useRef(0);
  // Mirrors of the selection for async handlers, which must not act on a Ficha the admin
  // has already moved away from while their RPC was running (WEB-5).
  const selectedIdRef = useRef<number | null>(null);
  const selectedProjectRef = useRef<number | null>(null);

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedId) || null,
    [reports, selectedId],
  );
  const selectedProjectId = selectedReport?.project_id ?? null;

  const loadReports = useCallback(async () => {
    setLoadingReports(true);
    setError(null);
    try {
      const { data: rows } = await completionApi.getAll();
      setReports(rows);
      setSelectedId((current) => {
        if (current && rows.some((report) => report.id === current)) return current;
        return rows.find((report) => !report.admin_signature && (report.format_version || 1) >= 2)?.id
          || rows.find((report) => !report.admin_signature)?.id
          || rows[0]?.id
          || null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar las Fichas.');
    } finally {
      setLoadingReports(false);
    }
  }, []);

  const loadDossier = useCallback(async (projectId: number) => {
    const requestId = ++dossierRequestRef.current;
    setLoadingDossier(true);
    // Never keep another project's compiled evidence visible while a new RPC
    // is in flight. This also prevents printing or signing against stale data.
    setDossier(null);
    setCrew(null);
    setError(null);
    try {
      const result = await completionApi.getDossier(projectId);
      const people = await loadDossierCrew(result.shifts.map((shift) => String(shift.id)));
      // A reply is shown only if it is still the latest request AND its project is still selected.
      if (requestId === dossierRequestRef.current && isDossierReplyCurrent(projectId, selectedProjectRef.current)) {
        setDossier(result);
        setCrew(people);
      }
      return result;
    } catch (loadError) {
      if (requestId === dossierRequestRef.current) {
        setDossier(null);
        setCrew(null);
        setError(loadError instanceof Error ? loadError.message : 'No se pudo compilar el dossier.');
      }
      return null;
    } finally {
      if (requestId === dossierRequestRef.current) setLoadingDossier(false);
    }
  }, []);

  useEffect(() => { void loadReports(); }, [loadReports]);

  useEffect(() => () => { dossierRequestRef.current += 1; }, []);

  // Declared before the dossier load so the mirrors are current when that load starts.
  useEffect(() => {
    selectedIdRef.current = selectedId;
    selectedProjectRef.current = selectedProjectId;
  }, [selectedId, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      dossierRequestRef.current += 1;
      setDossier(null);
      setCrew(null);
      setLoadingDossier(false);
      return;
    }
    void loadDossier(selectedProjectId);
  }, [selectedProjectId, loadDossier]);

  useEffect(() => {
    setReturnReason('');
  }, [selectedId]);

  const openDiscrepancies = useMemo(
    () => (dossier?.discrepancies || []).filter((item) => item.status === 'open'),
    [dossier],
  );
  const resolvedDiscrepancies = useMemo(
    () => (dossier?.discrepancies || []).filter((item) => item.status === 'resolved'),
    [dossier],
  );
  const activeMaterials = useMemo(
    () => (dossier?.materials || []).filter((material) => material.active !== false),
    [dossier],
  );
  const unreconciledMaterials = useMemo(() => {
    const reconciled = new Set((dossier?.reconciliations || []).map((item) => Number(item.project_material_id)));
    return activeMaterials.filter((material) => !reconciled.has(Number(material.id)));
  }, [activeMaterials, dossier]);
  const openCompanyPedidos = useMemo(
    () => (dossier?.company_pedidos || []).filter(isOpenCompanyPedido),
    [dossier],
  );
  const unresolvedFlaggedHandovers = useMemo(() => (
    dossier?.shift_handovers || []
  ).filter((handover) => {
    if (handover.status !== 'flagged') return false;
    return !(dossier?.reconciliations || []).some((reconciliation) => (
      Number(reconciliation.project_material_id) === Number(handover.project_material_id)
      && String(reconciliation.updated_at || '') >= String(handover.created_at || '')
    ));
  }), [dossier]);
  const pedidoReceiptRows = useMemo<JsonRecord[]>(() => (
    dossier?.company_pedidos || []
  ).flatMap((pedido) => (pedido.items || []).flatMap((item) => (
    item.receipts || []
  ).map((receipt) => ({
    ...receipt,
    pedido_number: pedido.pedido_number || `#${pedido.id}`,
    material_name_snapshot: item.material_name_snapshot,
    unit_snapshot: item.unit_snapshot,
  })))), [dossier]);
  const correctionMap = useMemo(() => {
    const map = new Map<string, JsonRecord>();
    [...(dossier?.corrections || [])]
      .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')))
      .forEach((correction) => map.set(
        `${correction.entity_type}:${correction.entity_id}:${correction.field_name}`,
        correction,
      ));
    return map;
  }, [dossier]);

  const correctedValue = (entity: string, row: JsonRecord, field: string): ReactNode => {
    const correction = correctionMap.get(`${entity}:${row.id}:${field}`);
    if (!correction) return displayValue(row[field]);
    return <>{displayValue(correction.corrected_value)} <span className="badge badge-warning">corregido</span></>;
  };

  const correctedDate = (entity: string, row: JsonRecord, field: string): ReactNode => {
    const correction = correctionMap.get(`${entity}:${row.id}:${field}`);
    if (!correction) return formatDateTime(typeof row[field] === 'string' ? row[field] : null);
    return <>{formatDateTime(typeof correction.corrected_value === 'string' ? correction.corrected_value : null)} <span className="badge badge-warning">corregido</span></>;
  };

  const formatVersion = selectedReport?.format_version || 1;
  const dossierCompletionId = Number(dossier?.completion?.id || 0);
  const dossierMismatch = Boolean(selectedReport && isDossierMismatch(dossierCompletionId, selectedReport.id));
  const crewView = crew ?? EMPTY_DOSSIER_CREW;
  const hardBlockers = formatVersion >= 2
    ? openDiscrepancies.length + unreconciledMaterials.length + unresolvedFlaggedHandovers.length + (dossierMismatch ? 1 : 0)
    : (dossierMismatch ? 1 : 0);

  const openStoredFile = async (storagePath: string, label: string) => {
    setError(null);
    setFileFallback(null);
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const url = await completionApi.getStoredFileSignedUrl(storagePath);
      if (popup && !popup.closed) {
        popup.location.href = url;
      } else {
        setFileFallback({ url, label });
        setError('El navegador bloqueó la pestaña. Usá el enlace privado temporal de abajo.');
      }
    } catch (openError) {
      popup?.close();
      setError(openError instanceof Error ? openError.message : 'No se pudo abrir el archivo.');
    }
  };

  const openPhoto = async (storagePath: string, label: string) => {
    setError(null);
    setFileFallback(null);
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const url = await completionApi.getPhotoSignedUrl(storagePath);
      if (popup && !popup.closed) popup.location.href = url;
      else {
        setFileFallback({ url, label });
        setError('El navegador bloqueó la pestaña. Usá el enlace privado temporal de abajo.');
      }
    } catch (openError) {
      popup?.close();
      setError(openError instanceof Error ? openError.message : 'No se pudo abrir la foto.');
    }
  };

  const resolveDiscrepancy = async (discrepancy: CompletionDiscrepancy) => {
    const note = (resolutionNotes[discrepancy.id] || '').trim();
    if (note.length < 3 || !selectedReport) {
      setError('Escribí una nota de resolución de al menos 3 caracteres.');
      return;
    }
    setBusyId(discrepancy.id);
    setError(null);
    setSuccess(null);
    try {
      await completionApi.resolveDiscrepancy(discrepancy.id, note);
      setResolutionNotes((current) => ({ ...current, [discrepancy.id]: '' }));
      if (shouldReloadAfterAction(selectedIdRef.current, selectedReport.id)) {
        await loadDossier(selectedReport.project_id);
      }
      setSuccess('Discrepancia resuelta y registrada en el historial auditable.');
    } catch (resolutionError) {
      setError(resolutionError instanceof Error ? resolutionError.message : 'No se pudo resolver la discrepancia.');
    } finally {
      setBusyId(null);
    }
  };

  const signReport = async () => {
    if (!selectedReport || !dossier) return;
    if (normalizedStatus(selectedReport.status) !== 'submitted') {
      setError('Solo se puede firmar una Ficha enviada y pendiente de revisión.');
      return;
    }
    if (hardBlockers > 0) {
      setError('La Ficha tiene bloqueos pendientes. Resolvelos antes de firmar.');
      return;
    }
    const warning = openCompanyPedidos.length
      ? ` Hay ${openCompanyPedidos.length} pedido(s) de empresa abierto(s); quedarán como advertencia, no como bloqueo.`
      : '';
    const confirmed = window.confirm(
      `Confirmá la firma administrativa de la Ficha #${selectedReport.id}. Esta operación es atómica: firma el informe y mueve el proyecto a Completado.${warning} El registro firmado queda protegido contra edición directa.`,
    );
    if (!confirmed) return;

    setBusyId(selectedReport.id);
    setError(null);
    setSuccess(null);
    try {
      const signature = user?.full_name || user?.username || user?.email || 'Administración';
      await completionApi.signAndComplete(
        selectedReport.id,
        signature,
        true,
        openCompanyPedidos.length > 0,
      );
      await loadReports();
      if (shouldReloadAfterAction(selectedIdRef.current, selectedReport.id)) {
        await loadDossier(selectedReport.project_id);
      }
      setSuccess('Ficha firmada y proyecto completado en una sola transacción.');
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : 'No se pudo firmar la Ficha.');
    } finally {
      setBusyId(null);
    }
  };

  const returnReport = async () => {
    if (!selectedReport || formatVersion < 2) return;
    const reason = returnReason.trim();
    if (normalizedStatus(selectedReport.status) !== 'submitted') {
      setError('Solo se puede devolver una Ficha enviada y pendiente de revisión.');
      return;
    }
    if (reason.length < 3) {
      setError('Escribí un motivo de devolución de al menos 3 caracteres.');
      return;
    }
    if (!window.confirm('La Ficha volverá al operador para que corrija y reconfirme los datos. El motivo quedará auditado.')) return;

    setBusyId(selectedReport.id);
    setError(null);
    setSuccess(null);
    try {
      await completionApi.returnForRevision(selectedReport.id, reason);
      setReturnReason('');
      await loadReports();
      if (shouldReloadAfterAction(selectedIdRef.current, selectedReport.id)) {
        await loadDossier(selectedReport.project_id);
      }
      setSuccess('Ficha devuelta al operador con motivo auditable. Debe corregirla y reconfirmarla antes de la firma.');
    } catch (returnError) {
      setError(returnError instanceof Error ? returnError.message : 'No se pudo devolver la Ficha.');
    } finally {
      setBusyId(null);
    }
  };

  const pending = reports.filter((report) => !report.admin_signature);
  const signed = reports.filter((report) => Boolean(report.admin_signature));
  const completion = (dossier?.completion || {}) as JsonRecord;
  const completionCorrection = (key: string) => correctionMap.get(`completion_reports:${completion.id}:${key}`);
  const casingSource = completionCorrection('casing_layout')?.corrected_value ?? completion.casing_layout;
  const casingLayout = Array.isArray(casingSource)
    ? casingSource.filter((row): row is JsonRecord => Boolean(row) && typeof row === 'object')
    : [];

  return (
    <div>
      <div className="card-header management-toolbar">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Cierres y Ficha técnica</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>
            Revisión inmutable, reconciliación, discrepancias y dossier completo
          </p>
        </div>
        <button className="btn-secondary" disabled={loadingReports} onClick={() => void loadReports()}>
          {loadingReports ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}
      {success && <div className="success-message" role="status">{success}</div>}
      {fileFallback && (
        <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          <a href={fileFallback.url} target="_blank" rel="noopener noreferrer" className="btn-primary button-auto" style={{ display: 'inline-block', textDecoration: 'none' }}>
            Abrir {fileFallback.label}
          </a>
          <button className="btn-secondary" style={{ marginLeft: 8 }} onClick={() => setFileFallback(null)}>Cerrar</button>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-number">{pending.filter((report) => normalizedStatus(report.status) !== 'returned').length}</div><div className="stat-label">Por firmar</div></div>
        <div className="stat-card"><div className="stat-number">{reports.filter((report) => (report.format_version || 1) >= 2).length}</div><div className="stat-label">Fichas v2</div></div>
        <div className="stat-card"><div className="stat-number">{signed.length}</div><div className="stat-label">Firmadas</div></div>
      </div>

      <section className="card">
        <div className="card-title">Fichas recibidas</div>
        <div className="card-subtitle">Seleccioná una Ficha para compilar su dossier desde el servidor.</div>
        {loadingReports && reports.length === 0 ? (
          <div className="loading-screen">Cargando Fichas…</div>
        ) : reports.length === 0 ? (
          <p className="text-muted">No hay Fichas enviadas.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Proyecto</th><th>Operador</th><th>Formato</th><th>Envío</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id} style={selectedId === report.id ? { background: 'rgba(30,86,168,0.16)' } : undefined}>
                    <td><strong>{projectName(report)}</strong><div className="text-muted">{report.projects?.location || ''}</div></td>
                    <td>{operatorName(report)}</td>
                    <td><span className={`badge ${(report.format_version || 1) >= 2 ? 'badge-active' : 'badge-neutral'}`}>v{report.format_version || 1}</span></td>
                    <td>{formatDateTime(report.submitted_at || report.created_at)}</td>
                    <td>
                      <span className={`badge ${report.admin_signature ? 'badge-success' : normalizedStatus(report.status) === 'returned' ? 'badge-danger' : 'badge-warning'}`}>
                        {report.admin_signature ? 'Firmada' : normalizedStatus(report.status) === 'returned' ? 'Devuelta' : 'Pendiente'}
                      </span>
                    </td>
                    <td><button className="btn-secondary" disabled={busyId !== null} onClick={() => setSelectedId(report.id)}>{selectedId === report.id ? 'Revisando' : 'Revisar'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedReport && (
        <section className="card" aria-busy={loadingDossier}>
          <div className="card-header" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="card-title">Dossier · {projectName(selectedReport)}</div>
              <div className="card-subtitle">
                Ficha #{selectedReport.id} · {operatorName(selectedReport)} · formato v{formatVersion}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-secondary" disabled={!selectedReport.pdf_url} onClick={() => selectedReport.pdf_url && void openStoredFile(selectedReport.pdf_url, 'PDF de la Ficha')}>
                {selectedReport.pdf_url ? 'Abrir PDF privado' : 'PDF no generado'}
              </button>
              <button className="btn-secondary" disabled={!dossier || !crew || dossierMismatch || loadingDossier} onClick={() => {
                if (!dossier || !crew || dossierMismatch) return;
                if (!printDossier(selectedReport, dossier, crew)) setError('El navegador bloqueó la ventana de impresión. Habilitá ventanas emergentes para este sitio.');
              }}>
                Imprimir / Guardar dossier
              </button>
            </div>
          </div>

          {loadingDossier && !dossier ? (
            <div className="loading-screen">Compilando dossier auditable…</div>
          ) : dossier ? (
            <>
              {dossierMismatch && (
                <div className="login-error" role="alert">
                  Esta no es la Ficha más reciente del proyecto. El dossier compilado corresponde a la Ficha #{dossierCompletionId}; la firma de esta versión queda bloqueada.
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginBottom: 14 }}>
                <div style={{ border: `1px solid ${openDiscrepancies.length ? 'var(--danger)' : 'var(--success)'}`, borderRadius: 9, padding: 12 }}>
                  <strong>{openDiscrepancies.length} discrepancia(s) abierta(s)</strong>
                  <div className="text-muted" style={{ fontSize: 13 }}>{formatVersion >= 2 ? 'Bloquean la firma.' : 'Historial del formato anterior.'}</div>
                </div>
                <div style={{ border: `1px solid ${unreconciledMaterials.length ? 'var(--danger)' : 'var(--success)'}`, borderRadius: 9, padding: 12 }}>
                  <strong>{dossier.reconciliations.length} de {activeMaterials.length} material(es) reconciliados</strong>
                  <div className="text-muted" style={{ fontSize: 13 }}>{formatVersion >= 2 ? 'Todos son obligatorios para firmar.' : 'No bloquea una Ficha v1.'}</div>
                </div>
                <div style={{ border: `1px solid ${openCompanyPedidos.length ? 'var(--warning)' : 'var(--success)'}`, borderRadius: 9, padding: 12 }}>
                  <strong>{openCompanyPedidos.length} pedido(s) empresa abierto(s)</strong>
                  <div className="text-muted" style={{ fontSize: 13 }}>Advertencia visible; no bloquea la firma.</div>
                </div>
                <div style={{ border: `1px solid ${unresolvedFlaggedHandovers.length ? 'var(--danger)' : 'var(--success)'}`, borderRadius: 9, padding: 12 }}>
                  <strong>{unresolvedFlaggedHandovers.length} entrega(s) con diferencia sin reconciliar</strong>
                  <div className="text-muted" style={{ fontSize: 13 }}>{formatVersion >= 2 ? 'Bloquean la firma.' : 'Historial del formato anterior.'}</div>
                </div>
              </div>

              {unreconciledMaterials.length > 0 && formatVersion >= 2 && (
                <div className="login-error">
                  Reconciliación pendiente: {unreconciledMaterials.map((material) => material.material_name || `material #${material.id}`).join(', ')}.
                  Completá la reconciliación desde Proyectos antes de firmar.
                </div>
              )}
              {openCompanyPedidos.length > 0 && (
                <div style={{ border: '1px solid var(--warning)', background: 'rgba(208,138,30,0.12)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
                  <strong>Advertencia de cierre:</strong> quedan abiertos {openCompanyPedidos.map((pedido) => pedido.pedido_number || `pedido #${pedido.id}`).join(', ')}.
                </div>
              )}
              {unresolvedFlaggedHandovers.length > 0 && formatVersion >= 2 && (
                <div className="login-error">
                  Hay entregas de turno con diferencias que requieren una reconciliación posterior antes de firmar.
                </div>
              )}

              <DossierSection title="Ficha final" subtitle="solo lectura" open>
                <ReadOnlyFields record={completion} correctionFor={completionCorrection} fields={[
                  { key: 'status', label: 'Estado', format: (value) => FICHA_STATUS[String(value)] || displayValue(value) },
                  { key: 'submitted_at', label: 'Enviada', format: (value) => formatDateTime(typeof value === 'string' ? value : null) },
                  { key: 'static_level', label: 'Nivel estático' },
                  { key: 'dynamic_level', label: 'Nivel dinámico' },
                  { key: 'flow_rate', label: 'Caudal bombeado' },
                  { key: 'specific_flow_rate', label: 'Caudal específico' },
                  { key: 'maximum_flow_rate', label: 'Caudal máximo' },
                  { key: 'pump_depth_m', label: 'Profundidad de bomba (m)' },
                  { key: 'hydraulic_mismatch', label: 'Diferencia hidráulica' },
                  { key: 'exploration_depth_m', label: 'Exploración (m)' },
                  { key: 'widening_depth_m', label: 'Ensanche (m)' },
                  { key: 'casing_total_m', label: 'Entubado total (m)' },
                  { key: 'casing_above_ground_m', label: 'Sobre terreno (m)' },
                  { key: 'blind_casing_m', label: 'Ciego (m)' },
                  { key: 'filter_casing_m', label: 'Filtro (m)' },
                  { key: 'sediment_trap_m', label: 'Trampa sedimentos (m)' },
                  { key: 'centralizer_count', label: 'Centralizadores' },
                  { key: 'bottom_plug_details', label: 'Tapón de fondo' },
                  { key: 'bentonite_quantity', label: 'Bentonita' },
                  { key: 'gravel_quantity', label: 'Grava' },
                  { key: 'compressor_hours', label: 'Horas de compresor' },
                  { key: 'pump_hours', label: 'Horas de bomba' },
                  { key: 'installed_meters', label: 'Metros instalados' },
                  { key: 'perforated_meters', label: 'Metros perforados' },
                  { key: 'water_quality', label: 'Calidad de agua' },
                  { key: 'completion_notes', label: 'Notas finales' },
                  { key: 'operator_signature', label: 'Firma operador' },
                  // A resubmitted Ficha keeps the old reason in the row; it is history,
                  // not an open return, so it shows only while the Ficha is returned.
                  ...(completion.status === 'returned' ? [
                    { key: 'return_reason', label: 'Motivo de devolución' },
                    { key: 'returned_at', label: 'Devuelta', format: (value: unknown) => formatDateTime(typeof value === 'string' ? value : null) },
                  ] : []),
                  { key: 'client_signature', label: 'Firma cliente' },
                  { key: 'admin_signature', label: 'Firma administrativa' },
                  { key: 'finalized_at', label: 'Finalizada', format: (value) => formatDateTime(typeof value === 'string' ? value : null) },
                ]} />
                <div style={{ marginTop: 12 }}>
                  <DataTable rows={casingLayout} empty="No se registró un esquema de entubado." columns={[
                    { label: 'Orden', render: (row) => displayValue(row.order) },
                    { label: 'Tipo', render: (row) => displayValue(row.type) },
                    { label: 'Metros', render: (row) => displayValue(row.meters) },
                    { label: 'Diámetro', render: (row) => displayValue(row.diameter) },
                    { label: 'Notas', render: (row) => displayValue(row.notes) },
                  ]} />
                </div>
              </DossierSection>

              <DossierSection title="Discrepancias" subtitle={`${openDiscrepancies.length} abierta(s)`} open={openDiscrepancies.length > 0}>
                {openDiscrepancies.length === 0 ? <p className="text-muted">No hay discrepancias abiertas.</p> : openDiscrepancies.map((item) => (
                  <div key={item.id} style={{ border: '1px solid var(--danger)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                    <div><span className="badge badge-danger">Abierta</span> <strong>{item.section}</strong> · {formatDateTime(item.created_at)}</div>
                    <p>{item.description}</p>
                    <label className="field-label" htmlFor={`resolution-${item.id}`}>Resolución administrativa</label>
                    <textarea
                      id={`resolution-${item.id}`}
                      className="field-input"
                      rows={2}
                      value={resolutionNotes[item.id] || ''}
                      onChange={(event) => setResolutionNotes((current) => ({ ...current, [item.id]: event.target.value }))}
                      placeholder="Qué se verificó y cómo quedó resuelta la diferencia"
                    />
                    <button className="btn-success" style={{ marginTop: 8 }} disabled={busyId === item.id || (resolutionNotes[item.id] || '').trim().length < 3} onClick={() => void resolveDiscrepancy(item)}>
                      {busyId === item.id ? 'Resolviendo…' : 'Resolver y auditar'}
                    </button>
                  </div>
                ))}
                {resolvedDiscrepancies.length > 0 && (
                  <DataTable rows={resolvedDiscrepancies} empty="" columns={[
                    { label: 'Sección', render: (row) => displayValue(row.section) },
                    { label: 'Descripción', render: (row) => displayValue(row.description) },
                    { label: 'Resolución', render: (row) => displayValue(row.resolution_note) },
                    { label: 'Fecha', render: (row) => formatDateTime(typeof row.resolved_at === 'string' ? row.resolved_at : null) },
                  ]} />
                )}
              </DossierSection>

              <DossierSection title="Materiales y reconciliación" subtitle={`${dossier.materials.length} asignado(s)`} open={unreconciledMaterials.length > 0}>
                <DataTable rows={dossier.materials} empty="Sin materiales asignados." columns={[
                  { label: 'Material', render: (row) => displayValue(row.material_name) },
                  { label: 'Capa', render: (row) => displayValue(row.layer) },
                  { label: 'Inicial', render: (row) => displayValue(row.initial_quantity) },
                  { label: 'Actual', render: (row) => displayValue(row.current_quantity) },
                  { label: 'Unidad', render: (row) => displayValue(row.unit) },
                  { label: 'Reconciliado', render: (row) => dossier.reconciliations.some((item) => Number(item.project_material_id) === Number(row.id)) ? <span className="badge badge-success">Sí</span> : <span className="badge badge-danger">No</span> },
                ]} />
                <div style={{ marginTop: 12 }}>
                  <DataTable rows={dossier.reconciliations} empty="No hay reconciliaciones registradas." columns={[
                    { label: 'Material ID', render: (row) => displayValue(row.project_material_id) },
                    { label: 'Enviado', render: (row) => displayValue(row.sent_quantity) },
                    { label: 'Consumido', render: (row) => displayValue(row.consumed_quantity) },
                    { label: 'Devuelto', render: (row) => displayValue(row.returned_quantity) },
                    { label: 'Faltante', render: (row) => displayValue(row.missing_quantity) },
                    { label: 'Notas', render: (row) => displayValue(row.notes) },
                  ]} />
                </div>
              </DossierSection>

              <DossierSection title="Perforación y turnos" subtitle={`${dossier.bars.length} barra(s) · ${dossier.shifts.length} turno(s)`}>
                <DataTable rows={dossier.bars} empty="Sin barras registradas." columns={[
                  { label: 'Barra', render: (row) => displayValue(row.bar_number) },
                  { label: 'Ingresado por', render: (row) => enteredByLabel(row.operator_id, crewView) },
                  { label: 'Llegada', render: (row) => arrivedLateLabel(row) },
                  { label: 'Inicio', render: (row) => correctedDate('drilling_bars', row, 'start_time') },
                  { label: 'Fin', render: (row) => correctedDate('drilling_bars', row, 'end_time') },
                  { label: 'Duración (min)', render: (row) => correctedValue('drilling_bars', row, 'duration_minutes') },
                  { label: 'Profundidad inicial', render: (row) => correctedValue('drilling_bars', row, 'depth_start') },
                  { label: 'Profundidad final', render: (row) => correctedValue('drilling_bars', row, 'depth_end') },
                ]} />
                <div style={{ marginTop: 12 }}>
                  <DataTable rows={dossier.shifts} empty="Sin turnos registrados." columns={[
                    { label: 'Inicio', render: (row) => correctedDate('shifts', row, 'started_at') },
                    { label: 'Fin', render: (row) => correctedDate('shifts', row, 'ended_at') },
                    { label: 'Ingresado por', render: (row) => enteredByLabel(row.operator_id, crewView) },
                    { label: 'Participantes', render: (row) => shiftCrewLabel(row, crewView) },
                    { label: 'Estado', render: (row) => inWords(row.status) },
                    { label: 'Cierre', render: (row) => (correctionMap.has(`shifts:${row.id}:end_type`)
                      ? correctedValue('shifts', row, 'end_type')
                      : inWords(row.end_type)) },
                    { label: 'Informe de uso', render: (row) => displayValue(row.usage_report_submitted) },
                  ]} />
                </div>
              </DossierSection>

              <DossierSection title="Entregas de turno" subtitle={`${dossier.shift_handovers.length} testimonio(s)`} open={unresolvedFlaggedHandovers.length > 0}>
                <DataTable rows={dossier.shift_handovers} empty="Sin testimonios de entrega." columns={[
                  { label: 'Fecha', render: (row) => formatDateTime(typeof row.created_at === 'string' ? row.created_at : null) },
                  { label: 'Turno', render: (row) => displayValue(row.shift_id) },
                  { label: 'Material ID', render: (row) => displayValue(row.project_material_id) },
                  { label: 'Estado', render: (row) => <span className={`badge ${row.status === 'flagged' ? 'badge-danger' : 'badge-success'}`}>{inWords(row.status)}</span> },
                  { label: 'Esperado', render: (row) => displayValue(row.expected_quantity) },
                  { label: 'Observado', render: (row) => displayValue(row.observed_quantity) },
                  { label: 'Nota', render: (row) => displayValue(row.note) },
                  { label: 'Foto', render: (row) => displayValue(row.photo_path) },
                ]} />
              </DossierSection>

              <DossierSection title="Fotos de campo" subtitle={`${dossier.photos.length} foto(s)`}>
                <DataTable rows={dossier.photos} empty="Sin fotos registradas." columns={[
                  { label: 'Fecha', render: (row) => formatDateTime(typeof row.created_at === 'string' ? row.created_at : null) },
                  { label: 'Tipo', render: (row) => inWords(row.evidence_kind) },
                  { label: 'Turno', render: (row) => displayValue(row.shift_id) },
                  { label: 'Archivo', render: (row) => displayValue(row.original_name || row.filename) },
                  { label: 'Descripción', render: (row) => displayValue(row.caption) },
                  { label: 'Privada', render: (row) => typeof row.storage_path === 'string' ? <button className="btn-secondary" onClick={() => void openPhoto(row.storage_path as string, String(row.original_name || row.filename || 'foto'))}>Abrir</button> : '—' },
                ]} />
              </DossierSection>

              <DossierSection title="Consumo" subtitle={`${dossier.consumption.length} registro(s)`}>
                <DataTable rows={dossier.consumption} empty="Sin consumo registrado." columns={[
                  { label: 'Fecha', render: (row) => correctedDate('material_consumption', row, 'date') },
                  { label: 'Ingresado por', render: (row) => enteredByLabel(row.operator_id, crewView) },
                  { label: 'Material ID', render: (row) => displayValue(row.project_material_id || row.material_id) },
                  { label: 'Cantidad', render: (row) => correctedValue('material_consumption', row, 'quantity_used') },
                  { label: 'Aproximado', render: (row) => correctedValue('material_consumption', row, 'approximate') },
                  { label: 'Anomalía', render: (row) => displayValue(row.anomaly_flag ?? row.anomaly) },
                  { label: 'Notas', render: (row) => displayValue(row.notes) },
                ]} />
              </DossierSection>

              <DossierSection title="Muestras de agua" subtitle={`${dossier.samples.length} muestra(s)`}>
                <DataTable rows={dossier.samples} empty="Sin muestras registradas." columns={[
                  { label: 'N.º', render: (row) => displayValue(row.sample_number) },
                  { label: 'Ingresado por', render: (row) => enteredByLabel(row.operator_id, crewView) },
                  { label: 'Fecha', render: (row) => correctedDate('water_samples', row, 'taken_at') },
                  { label: 'Profundidad', render: (row) => correctedValue('water_samples', row, 'depth_m') },
                  { label: 'Etapa', render: (row) => correctedValue('water_samples', row, 'stage') },
                  { label: 'Foto', render: (row) => displayValue(row.bottle_photo_path) },
                  { label: 'Notas', render: (row) => displayValue(row.notes) },
                ]} />
              </DossierSection>

              <DossierSection title="Pedidos de empresa" subtitle={`${openCompanyPedidos.length} abierto(s)`} open={openCompanyPedidos.length > 0}>
                <DataTable rows={dossier.company_pedidos} empty="Sin pedidos de empresa." columns={[
                  { label: 'Pedido', render: (row) => displayValue(row.pedido_number || `#${displayValue(row.id)}`) },
                  { label: 'Fecha', render: (row) => formatDateTime(typeof row.created_at === 'string' ? row.created_at : null) },
                  { label: 'Estado', render: (row) => displayValue(row.status) },
                  { label: 'Justificación', render: (row) => displayValue(row.justification) },
                  { label: 'Ítems', render: (row) => Array.isArray(row.items) ? row.items.map((item) => displayValue((item as JsonRecord).material_name_snapshot)).join(', ') : '—' },
                ]} />
                <div style={{ marginTop: 12 }}>
                  <DataTable rows={pedidoReceiptRows} empty="Sin confirmaciones de recepción." columns={[
                    { label: 'Pedido', render: (row) => displayValue(row.pedido_number) },
                    { label: 'Material', render: (row) => displayValue(row.material_name_snapshot) },
                    { label: 'Resultado', render: (row) => inWords(row.outcome) },
                    { label: 'Cantidad', render: (row) => `${displayValue(row.quantity_received)} ${displayValue(row.unit_snapshot)}` },
                    { label: 'Incidente / nota', render: (row) => displayValue(row.incident_note) },
                    { label: 'Confirmada', render: (row) => formatDateTime(typeof row.created_at === 'string' ? row.created_at : null) },
                  ]} />
                </div>
              </DossierSection>

              <DossierSection title="Adjuntos" subtitle={`${dossier.attachments.length} archivo(s)`}>
                {dossier.attachments.length === 0 ? <p className="text-muted">Sin adjuntos.</p> : dossier.attachments.map((attachment) => (
                  <div key={attachment.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)', padding: '9px 0' }}>
                    <div>
                      <strong>{attachment.filename || attachment.kind || `Adjunto #${attachment.id}`}</strong>
                      <div className="text-muted" style={{ fontSize: 12 }}>{attachment.kind || 'otro'} · {attachment.mime_type || 'tipo no indicado'} · {formatDateTime(attachment.uploaded_at)}</div>
                      {attachment.notes && <div>{attachment.notes}</div>}
                    </div>
                    <button className="btn-secondary" onClick={() => void openStoredFile(attachment.storage_path, attachment.filename || 'adjunto')}>Abrir privado</button>
                  </div>
                ))}
              </DossierSection>

              <DossierSection title="Correcciones e historial auditable" subtitle={`${dossier.corrections.length} corrección(es) · ${dossier.audit.length} evento(s)`}>
                <DataTable rows={dossier.corrections} empty="Sin correcciones administrativas." columns={[
                  { label: 'Fecha', render: (row) => formatDateTime(typeof row.created_at === 'string' ? row.created_at : null) },
                  { label: 'Registro', render: (row) => inWords(row.entity_type) },
                  { label: 'Campo', render: (row) => displayValue(row.field_name) },
                  { label: 'Original', render: (row) => displayValue(row.original_value) },
                  { label: 'Corregido', render: (row) => displayValue(row.corrected_value) },
                  { label: 'Motivo', render: (row) => displayValue(row.reason) },
                ]} />
                <div style={{ marginTop: 12 }}>
                  <DataTable rows={[...dossier.audit].reverse()} empty="Sin eventos de auditoría." columns={[
                    { label: 'Fecha', render: (row) => formatDateTime(typeof row.created_at === 'string' ? row.created_at : null) },
                    { label: 'Acción', render: (row) => displayValue(row.action) },
                    { label: 'Usuario', render: (row) => (typeof row.actor_id === 'string' ? crewView.names.get(row.actor_id) ?? 'Operador desconocido' : 'Sistema') },
                    { label: 'Registro', render: (row) => inWords(row.entity_type) },
                    { label: 'ID del registro', render: (row) => displayValue(row.entity_id) },
                    { label: 'Motivo', render: (row) => displayValue(row.reason) },
                  ]} />
                </div>
              </DossierSection>

              {!selectedReport.admin_signature && normalizedStatus(selectedReport.status) === 'submitted' ? (
                <div style={{ borderTop: '2px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
                  {formatVersion >= 2 && (
                    <div style={{ marginBottom: 12 }}>
                      <label className="field-label" htmlFor={`return-reason-${selectedReport.id}`}>Motivo para devolver al operador</label>
                      <textarea
                        id={`return-reason-${selectedReport.id}`}
                        className="field-input"
                        rows={2}
                        value={returnReason}
                        onChange={(event) => setReturnReason(event.target.value)}
                        placeholder="Qué debe corregir o verificar antes de reconfirmar"
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {formatVersion >= 2 && (
                      <button className="btn-danger" disabled={busyId === selectedReport.id || returnReason.trim().length < 3 || loadingDossier || dossierMismatch} onClick={() => void returnReport()}>
                        {busyId === selectedReport.id ? 'Procesando…' : 'Devolver para corregir'}
                      </button>
                    )}
                    <button className="btn-success" disabled={busyId === selectedReport.id || hardBlockers > 0 || loadingDossier} onClick={() => void signReport()}>
                      {busyId === selectedReport.id ? 'Procesando…' : 'Confirmar firma administrativa y completar proyecto'}
                    </button>
                  </div>
                  {hardBlockers > 0 && <div className="text-muted" style={{ marginTop: 8 }}>La firma está deshabilitada hasta resolver {hardBlockers} bloqueo(s).</div>}
                </div>
              ) : !selectedReport.admin_signature && normalizedStatus(selectedReport.status) === 'returned' ? (
                <div style={{ border: '1px solid var(--warning)', background: 'rgba(208,138,30,0.12)', borderRadius: 8, padding: 12, marginTop: 12 }}>
                  <strong>Devuelta al operador.</strong> {selectedReport.return_reason || 'Debe corregir y reconfirmar la Ficha antes de que pueda firmarse.'}
                  <div className="text-muted" style={{ marginTop: 4 }}>{formatDateTime(selectedReport.returned_at)}</div>
                </div>
              ) : (
                <div className="success-message" style={{ marginTop: 12, marginBottom: 0 }}>
                  Firmada por {selectedReport.admin_signature} · {formatDateTime(selectedReport.finalized_at || selectedReport.updated_at)}
                </div>
              )}
            </>
          ) : null}
        </section>
      )}
    </div>
  );
};
