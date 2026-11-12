import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { normalizeStatus, statusLabel } from '../../domain/projectStatus';
import { operatorApi } from '../../api/supabase-operator';
import type {
  ActiveOperatorCatalog,
  CasingLayoutRow,
  CompletionFinalFields,
  OperatorFichaPreview,
  OperatorProject,
  OperatorProjectMaterial,
  PedidoDraftItem,
  WaterSample,
} from '../../types/operatorConsole';
import type { OperatorAccountabilityMetrics, PedidoItem, PedidoV2, Shift } from '../../types/productV2';

const OPERATOR_TABS = ['resumen', 'turnos', 'progreso', 'pedidos', 'muestras', 'ficha'] as const;
type OperatorTab = typeof OPERATOR_TABS[number];

const TAB_LABELS: Record<OperatorTab, string> = {
  resumen: 'Resumen',
  turnos: 'Turnos',
  progreso: 'Progreso',
  pedidos: 'Pedidos',
  muestras: 'Muestras',
  ficha: 'Ficha técnica',
};

const parseOperatorTab = (): OperatorTab => {
  const match = window.location.hash.match(/^#\/operador\/([^/?]+)/);
  const candidate = match?.[1] as OperatorTab | undefined;
  return candidate && OPERATOR_TABS.includes(candidate) ? candidate : 'resumen';
};

const numberOrNull = (value: string): number | null => {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

const nonNegative = (value: string, fallback = 0) => {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
};

const displayDate = (value?: string | null) => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('es-PY');
};

interface StableMutationAttempt {
  fingerprint: string;
  clientEntryId: string;
  entityId: string;
  occurredAt: string;
}

// A lost response must be retryable with the exact same IDs, timestamps, and
// payload. Editing the form changes the fingerprint and starts a new attempt;
// a successful refresh explicitly clears it.
const useStableMutationAttempt = () => {
  const attemptRef = useRef<StableMutationAttempt | null>(null);
  const get = useCallback((payload: unknown) => {
    const fingerprint = JSON.stringify(payload);
    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      attemptRef.current = {
        fingerprint,
        clientEntryId: operatorApi.createClientEntryId(),
        entityId: operatorApi.createClientEntryId(),
        occurredAt: new Date().toISOString(),
      };
    }
    return attemptRef.current;
  }, []);
  const clear = useCallback(() => {
    attemptRef.current = null;
  }, []);
  return { get, clear };
};

const projectName = (project?: OperatorProject | null) =>
  project?.well_name || project?.name || (project ? `Proyecto #${project.id}` : 'Sin proyecto');

const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'active' | 'success' | 'warning' | 'danger' }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

const Notice = ({ kind, children }: { kind: 'error' | 'success'; children: ReactNode }) => (
  <div className={kind === 'error' ? 'login-error' : 'success-message'} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>
);

interface SharedPanelProps {
  project: OperatorProject | null;
  projects: OperatorProject[];
  materials: OperatorProjectMaterial[];
  selectProject: (id: number) => void;
  refresh: () => Promise<void>;
  setError: (message: string | null) => void;
  setSuccess: (message: string | null) => void;
}

const ProjectPicker = ({ projects, value, onChange }: {
  projects: OperatorProject[];
  value: number;
  onChange: (id: number) => void;
}) => (
  <label className="operator-project-picker">
    <span>Pozo activo</span>
    <select className="field-input" value={value || ''} onChange={(event) => onChange(Number(event.target.value))}>
      <option value="" disabled>Seleccioná un proyecto</option>
      {projects.map((project) => <option key={project.id} value={project.id}>{projectName(project)} · {statusLabel(project.status)}</option>)}
    </select>
  </label>
);

const SummaryPanel = ({ projects, metrics, shifts, pedidos }: {
  projects: OperatorProject[];
  metrics: OperatorAccountabilityMetrics | null;
  shifts: Shift[];
  pedidos: PedidoV2[];
}) => (
  <div>
    <div className="stats-grid">
      <div className="stat-card"><div className="stat-number">{projects.length}</div><div className="stat-label">Pozos asignados</div></div>
      <div className="stat-card"><div className="stat-number">{metrics?.shifts_completed ?? 0}</div><div className="stat-label">Turnos cerrados</div></div>
      <div className="stat-card"><div className="stat-number">{metrics?.bars_registered ?? 0}</div><div className="stat-label">Barras registradas</div></div>
      <div className="stat-card"><div className="stat-number">{pedidos.filter((row) => !['Cerrado', 'Rechazado'].includes(row.status)).length}</div><div className="stat-label">Pedidos activos</div></div>
    </div>
    <section className="card operator-card">
      <div className="card-title">Mis proyectos</div>
      <div className="card-subtitle">La consola web usa los mismos RPC y reglas de seguridad que Android, pero requiere conexión.</div>
      {projects.length ? projects.map((project) => (
        <div className="operator-list-row" key={project.id}>
          <div><strong>{projectName(project)}</strong><div className="text-muted">{project.location || 'Sin ubicación'} · {project.target_depth ? `${project.target_depth} m objetivo` : 'Sin profundidad objetivo'}</div></div>
          <Badge tone={normalizeStatus(project.status) === 'active' ? 'active' : 'warning'}>{statusLabel(project.status)}</Badge>
        </div>
      )) : <p className="text-muted">No hay proyectos activos asignados.</p>}
    </section>
    <section className="card operator-card">
      <div className="card-title">Actividad reciente</div>
      {shifts.slice(0, 5).map((shift) => <div className="operator-list-row" key={shift.id}><span>Turno · {displayDate(shift.started_at)}</span><Badge tone={shift.status === 'closed' ? 'success' : 'warning'}>{shift.status}</Badge></div>)}
      {!shifts.length && <p className="text-muted">Todavía no hay turnos.</p>}
    </section>
  </div>
);

interface HandoverDraft { status: 'confirmed' | 'flagged'; observed: string; note: string }
interface UsageDraft { quantity: string; approximate: boolean; notes: string }

const TurnosPanel = ({ project, projects, materials, selectProject, refresh, setError, setSuccess, shifts }: SharedPanelProps & { shifts: Shift[] }) => {
  const unresolved = shifts.find((shift) => shift.status === 'open' || shift.status === 'report_pending') || null;
  const [busy, setBusy] = useState(false);
  const [handover, setHandover] = useState<Record<number, HandoverDraft>>({});
  const [usage, setUsage] = useState<Record<number, UsageDraft>>({});
  const [endNotes, setEndNotes] = useState('');
  const startAttempt = useStableMutationAttempt();
  const handoverAttempt = useStableMutationAttempt();
  const endAttempt = useStableMutationAttempt();

  useEffect(() => {
    const handoverSeed: Record<number, HandoverDraft> = {};
    const usageSeed: Record<number, UsageDraft> = {};
    materials.forEach((material) => {
      handoverSeed[material.id] = { status: 'confirmed', observed: String(material.current_quantity ?? 0), note: '' };
      usageSeed[material.id] = { quantity: '0', approximate: false, notes: '' };
    });
    setHandover(handoverSeed);
    setUsage(usageSeed);
  }, [materials, unresolved?.id]);

  const run = async (operation: () => Promise<unknown>, success: string, onSuccess?: () => void) => {
    setBusy(true); setError(null); setSuccess(null);
    try { await operation(); await refresh(); onSuccess?.(); setSuccess(success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo completar la operación.'); }
    finally { setBusy(false); }
  };

  const start = () => {
    if (!project || normalizeStatus(project.status) !== 'active') {
      setError('El proyecto debe estar En progreso para iniciar un turno.');
      return;
    }
    const attempt = startAttempt.get({ projectId: project.id });
    void run(async () => {
      const result = await operatorApi.shifts.start({ projectId: project.id, shiftId: attempt.entityId, clientEntryId: attempt.clientEntryId, startedAt: attempt.occurredAt, deviceStartedAt: attempt.occurredAt });
      if (result.id !== attempt.entityId) {
        await refresh();
        throw new Error('Ya existe otro turno sin resolver. Cerralo antes de iniciar uno nuevo.');
      }
    }, 'Turno iniciado. Confirmá la entrega antes de registrar trabajo.', startAttempt.clear);
  };

  const confirmHandover = () => {
    if (!unresolved) return;
    const testimony = materials.map((material) => {
      const draft = handover[material.id] || { status: 'confirmed' as const, observed: '', note: '' };
      const observed = numberOrNull(draft.observed);
      if (draft.status === 'flagged' && (observed === null || observed < 0)) throw new Error(`Indicá la cantidad observada de ${material.material_name}.`);
      return {
        project_material_id: material.id,
        status: draft.status,
        expected_quantity: material.current_quantity ?? 0,
        observed_quantity: observed ?? undefined,
        note: draft.note.trim() || undefined,
      };
    });
    const attempt = handoverAttempt.get({ shiftId: unresolved.id, testimony });
    const items = testimony.map((item) => ({
      ...item,
      client_entry_id: `${attempt.clientEntryId}:${item.project_material_id}`,
    }));
    void run(() => operatorApi.shifts.confirmHandover(unresolved.id, items), 'Entrega del turno confirmada con trazabilidad.', handoverAttempt.clear);
  };

  const endShift = () => {
    if (!unresolved) return;
    const usageReport = materials.map((material) => {
      const draft = usage[material.id] || { quantity: '0', approximate: false, notes: '' };
      const quantity = numberOrNull(draft.quantity);
      if (quantity === null || quantity < 0) throw new Error(`Uso inválido para ${material.material_name}.`);
      return { project_material_id: material.id, quantity_used: quantity, approximate: draft.approximate, notes: draft.notes.trim() || undefined };
    });
    const notes = endNotes.trim() || undefined;
    const attempt = endAttempt.get({ shiftId: unresolved.id, usageReport, notes, endType: 'manual' });
    const report = usageReport.map((item) => ({
      ...item,
      client_entry_id: `${attempt.clientEntryId}:${item.project_material_id}`,
    }));
    void run(() => operatorApi.shifts.end({ shiftId: unresolved.id, usage: report, notes, deviceEndedAt: attempt.occurredAt, endType: 'manual' }), 'Turno cerrado y reporte de uso enviado.', endAttempt.clear);
  };

  return (
    <div>
      <ProjectPicker projects={projects} value={project?.id || 0} onChange={selectProject} />
      {!unresolved ? (
        <section className="card operator-card"><div className="card-title">Sin turno abierto</div><p className="card-subtitle">Iniciá un turno para confirmar materiales, registrar barras y reportar consumos.</p><button className="btn-primary button-auto" disabled={busy || !project} onClick={start}>Iniciar turno</button></section>
      ) : (
        <>
          <section className="card operator-card">
            <div className="section-title-row"><div><div className="card-title">Turno en curso</div><div className="card-subtitle">{displayDate(unresolved.started_at)} · {unresolved.projects?.name || `Proyecto #${unresolved.project_id}`}</div></div><Badge tone={unresolved.status === 'open' ? 'active' : 'warning'}>{unresolved.status}</Badge></div>
            {unresolved.project_id !== project?.id && <Notice kind="error">El turno pendiente pertenece a otro proyecto. Seleccionalo o cerralo antes de continuar.</Notice>}
          </section>
          {!unresolved.handover_confirmed && unresolved.project_id === project?.id && (
            <section className="card operator-card"><div className="card-title">1. Confirmar entrega</div><div className="card-subtitle">Confirmá cada material o marcá una diferencia observada.</div>
              {materials.map((material) => { const draft = handover[material.id] || { status: 'confirmed', observed: '', note: '' }; return (
                <div className="operator-material-row" key={material.id}>
                  <div><strong>{material.material_name}</strong><div className="text-muted">Esperado: {material.current_quantity} {material.unit}</div></div>
                  <select className="field-input" value={draft.status} onChange={(event) => setHandover((current) => ({ ...current, [material.id]: { ...draft, status: event.target.value as HandoverDraft['status'] } }))}><option value="confirmed">Confirmado</option><option value="flagged">Hay diferencia</option></select>
                  {draft.status === 'flagged' && <><input className="field-input" inputMode="decimal" value={draft.observed} onChange={(event) => setHandover((current) => ({ ...current, [material.id]: { ...draft, observed: event.target.value } }))} placeholder="Cantidad observada" /><input className="field-input" value={draft.note} onChange={(event) => setHandover((current) => ({ ...current, [material.id]: { ...draft, note: event.target.value } }))} placeholder="Explicación" /></>}
                </div>
              ); })}
              <button className="btn-success" disabled={busy} onClick={() => { try { confirmHandover(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Entrega inválida.'); } }}>Confirmar entrega</button>
            </section>
          )}
          {unresolved.handover_confirmed && unresolved.project_id === project?.id && (
            <section className="card operator-card"><div className="card-title">2. Cerrar turno e informar uso</div><div className="card-subtitle">Declarar cero también es una confirmación explícita. Todos los materiales activos deben estar incluidos.</div>
              {materials.map((material) => { const draft = usage[material.id] || { quantity: '0', approximate: false, notes: '' }; return (
                <div className="operator-material-row" key={material.id}><div><strong>{material.material_name}</strong><div className="text-muted">Disponible: {material.current_quantity} {material.unit}</div></div><input className="field-input" inputMode="decimal" value={draft.quantity} onChange={(event) => setUsage((current) => ({ ...current, [material.id]: { ...draft, quantity: event.target.value } }))} placeholder="Cantidad usada" /><label className="checkbox-row"><input type="checkbox" checked={draft.approximate} onChange={(event) => setUsage((current) => ({ ...current, [material.id]: { ...draft, approximate: event.target.checked } }))} /> Aproximado</label><input className="field-input" value={draft.notes} onChange={(event) => setUsage((current) => ({ ...current, [material.id]: { ...draft, notes: event.target.value } }))} placeholder="Nota opcional" /></div>
              ); })}
              <textarea className="field-input operator-textarea" value={endNotes} onChange={(event) => setEndNotes(event.target.value)} placeholder="Observaciones del turno" />
              <button className="btn-success" disabled={busy} onClick={() => { try { endShift(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Reporte inválido.'); } }}>Finalizar turno</button>
            </section>
          )}
        </>
      )}
    </div>
  );
};

const ProgressPanel = ({ project, projects, selectProject, refresh, setError, setSuccess, shifts, bars }: SharedPanelProps & { shifts: Shift[]; bars: Awaited<ReturnType<typeof operatorApi.bars.getMine>>['data'] }) => {
  const shift = shifts.find((row) => row.project_id === project?.id && (row.status === 'open' || row.status === 'report_pending')) || null;
  const [busy, setBusy] = useState(false);
  const [soil, setSoil] = useState('');
  const [length, setLength] = useState('');
  const [diameter, setDiameter] = useState('');
  const [waterLevel, setWaterLevel] = useState('');
  const [minutes, setMinutes] = useState('');
  const [notes, setNotes] = useState('');
  const barAttempt = useStableMutationAttempt();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !shift || !shift.handover_confirmed) { setError('Iniciá el turno y confirmá la entrega antes de registrar una barra.'); return; }
    if (!soil.trim()) { setError('Indicá el tipo de suelo.'); return; }
    const barLength = numberOrNull(length) ?? project.default_bar_length ?? 3;
    if (barLength <= 0) { setError('La longitud debe ser mayor que cero.'); return; }
    const payload = { projectId: project.id, shiftId: shift.id, soil: soil.trim(), barLength, diameter: diameter.trim() || project.default_bar_diameter || undefined, minutes: numberOrNull(minutes) ?? undefined, waterLevel: numberOrNull(waterLevel) ?? undefined, notes: notes.trim() || undefined };
    const attempt = barAttempt.get(payload);
    setBusy(true); setError(null); setSuccess(null);
    try {
      await operatorApi.bars.create({ client_entry_id: attempt.clientEntryId, project_id: project.id, shift_id: shift.id, soil_type: payload.soil, length: barLength, diameter: payload.diameter, duration_minutes: payload.minutes, water_level: payload.waterLevel, notes: payload.notes, end_time: attempt.occurredAt, timestamp_local: attempt.occurredAt });
      setSoil(''); setLength(''); setWaterLevel(''); setMinutes(''); setNotes('');
      await refresh(); barAttempt.clear(); setSuccess('Barra registrada en la cadena canónica del pozo.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar la barra.'); }
    finally { setBusy(false); }
  };

  return <div><ProjectPicker projects={projects} value={project?.id || 0} onChange={selectProject} />
    <section className="card operator-card"><div className="card-title">Registrar avance</div><div className="card-subtitle">El servidor calcula número y profundidad de forma atómica. La consola nunca los inventa.</div>
      {!shift?.handover_confirmed && <Notice kind="error">Necesitás un turno abierto con entrega confirmada.</Notice>}
      <form className="responsive-form-grid" onSubmit={submit}>
        <label className="field-label">Tipo de suelo<input className="field-input" value={soil} onChange={(event) => setSoil(event.target.value)} required /></label>
        <label className="field-label">Longitud (m)<input className="field-input" inputMode="decimal" value={length} onChange={(event) => setLength(event.target.value)} placeholder={String(project?.default_bar_length || 3)} /></label>
        <label className="field-label">Diámetro<input className="field-input" value={diameter} onChange={(event) => setDiameter(event.target.value)} placeholder={project?.default_bar_diameter || 'Opcional'} /></label>
        <label className="field-label">Nivel de agua<input className="field-input" inputMode="decimal" value={waterLevel} onChange={(event) => setWaterLevel(event.target.value)} /></label>
        <label className="field-label">Duración (min)<input className="field-input" inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label>
        <label className="field-label">Notas<input className="field-input" value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="grid-span-full"><button className="btn-primary button-auto" disabled={busy || !shift?.handover_confirmed}>{busy ? 'Guardando…' : 'Registrar barra'}</button></div>
      </form>
    </section>
    <section className="card operator-card"><div className="card-title">Barras del pozo</div>{bars.length ? <div className="table-scroll"><table><thead><tr><th>Barra</th><th>Profundidad</th><th>Suelo</th><th>Duración</th></tr></thead><tbody>{bars.map((bar) => <tr key={bar.id}><td>#{bar.bar_number}</td><td>{bar.depth_start} → {bar.depth_end} m</td><td>{bar.soil_type}</td><td>{bar.duration_minutes ?? '—'} min</td></tr>)}</tbody></table></div> : <p className="text-muted">Sin barras registradas.</p>}</section>
  </div>;
};

interface PedidoItemDraft { id: string; variantId: string; name: string; quantity: string; unit: string; layer: 'presupuesto' | 'extras' }
const emptyPedidoItem = (): PedidoItemDraft => ({ id: operatorApi.createClientEntryId(), variantId: '', name: '', quantity: '1', unit: 'unidad', layer: 'extras' });

const PedidosPanel = ({ project, projects, selectProject, refresh, setError, setSuccess, pedidos, catalog }: SharedPanelProps & { pedidos: PedidoV2[]; catalog: ActiveOperatorCatalog }) => {
  const [kind, setKind] = useState<'empresa' | 'personal'>('empresa');
  const [justification, setJustification] = useState('');
  const [priority, setPriority] = useState('Normal');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<PedidoItemDraft[]>([emptyPedidoItem()]);
  const [busy, setBusy] = useState(false);
  const [receiptDrafts, setReceiptDrafts] = useState<Record<number, { outcome: 'recibido' | 'parcial' | 'no_recibido'; quantity: string; note: string }>>({});
  const pedidoAttempt = useStableMutationAttempt();
  const receiptAttempt = useStableMutationAttempt();
  const variants = useMemo(() => catalog.flatMap((material) => (material.catalog_variants || []).map((variant) => ({ ...variant, materialName: material.name, unit: material.unit }))), [catalog]);

  const updateItem = (id: string, patch: Partial<PedidoItemDraft>) => setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const selectVariant = (item: PedidoItemDraft, variantId: string) => {
    const variant = variants.find((row) => row.id === Number(variantId));
    updateItem(item.id, { variantId, name: variant ? `${variant.materialName}${variant.display_name.toLowerCase() === 'estándar' || variant.display_name.toLowerCase() === 'estandar' ? '' : ` · ${variant.display_name}`}` : item.name, unit: variant?.unit || item.unit });
  };
  const createPedido = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || normalizeStatus(project.status) !== 'active') { setError('Seleccioná un proyecto En progreso.'); return; }
    if (kind === 'empresa' && justification.trim().length < 3) { setError('El pedido Empresa requiere justificación.'); return; }
    let payloadItems: PedidoDraftItem[];
    try {
      payloadItems = items.map((item) => {
        const quantity = numberOrNull(item.quantity);
        if (quantity === null || quantity <= 0 || (!item.variantId && !item.name.trim())) throw new Error('Cada ítem necesita material y cantidad positiva.');
        return { client_entry_id: item.id, catalog_variant_id: item.variantId ? Number(item.variantId) : undefined, material_name: item.variantId ? undefined : item.name.trim() || undefined, requested_quantity: quantity, unit: item.variantId ? undefined : item.unit.trim() || 'unidad', layer: item.layer };
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Revisá los ítems del pedido.');
      return;
    }
    const payload = { projectId: project.id, kind, items: payloadItems, justification: kind === 'empresa' ? justification.trim() : undefined, priority, notes: notes.trim() || undefined };
    const attempt = pedidoAttempt.get(payload);
    setBusy(true); setError(null); setSuccess(null);
    try { await operatorApi.pedidos.createV2({ clientEntryId: attempt.clientEntryId, ...payload }); setItems([emptyPedidoItem()]); setJustification(''); setNotes(''); await refresh(); pedidoAttempt.clear(); setSuccess('Pedido multiítem enviado. La aprobación no modifica inventario.'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo crear el pedido.'); }
    finally { setBusy(false); }
  };
  const receive = async (item: PedidoItem) => {
    const draft = receiptDrafts[item.id] || { outcome: 'recibido' as const, quantity: String(Math.max(0, (item.approved_quantity || 0) - item.received_quantity)), note: '' };
    const quantity = nonNegative(draft.quantity);
    if ((draft.outcome === 'parcial' || draft.outcome === 'no_recibido') && draft.note.trim().length < 3) { setError('Una recepción parcial o no recibida requiere una nota.'); return; }
    const payload = { itemId: item.id, outcome: draft.outcome, quantityReceived: draft.outcome === 'no_recibido' ? 0 : quantity, incidentNote: draft.note.trim() || undefined };
    const attempt = receiptAttempt.get(payload);
    setBusy(true); setError(null); setSuccess(null);
    try { await operatorApi.pedidos.confirmReceipt({ ...payload, clientEntryId: attempt.clientEntryId }); await refresh(); receiptAttempt.clear(); setSuccess('Recepción confirmada. Solo Empresa actualiza inventario al recibir.'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo confirmar la recepción.'); }
    finally { setBusy(false); }
  };

  return <div><ProjectPicker projects={projects} value={project?.id || 0} onChange={selectProject} />
    <section className="card operator-card"><div className="card-title">Nuevo pedido</div><form onSubmit={(event) => { try { void createPedido(event); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Pedido inválido.'); } }}>
      <div className="responsive-form-grid"><label className="field-label">Tipo<select className="field-input" value={kind} onChange={(event) => setKind(event.target.value as 'empresa' | 'personal')}><option value="empresa">Empresa</option><option value="personal">Personal</option></select></label><label className="field-label">Prioridad<select className="field-input" value={priority} onChange={(event) => setPriority(event.target.value)}><option>Normal</option><option>Alta</option><option>Urgente</option></select></label></div>
      {kind === 'empresa' && <label className="field-label">Justificación<input className="field-input" value={justification} onChange={(event) => setJustification(event.target.value)} required /></label>}
      {items.map((item, index) => <div className="operator-pedido-item" key={item.id}><div className="section-title-row"><strong>Ítem {index + 1}</strong>{items.length > 1 && <button type="button" className="btn-danger" onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}>Quitar</button>}</div><div className="responsive-form-grid"><label className="field-label">Variante de catálogo<select className="field-input" value={item.variantId} onChange={(event) => selectVariant(item, event.target.value)}><option value="">Texto libre</option>{variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.materialName} · {variant.display_name}</option>)}</select></label><label className="field-label">Material<input className="field-input" value={item.name} disabled={Boolean(item.variantId)} onChange={(event) => updateItem(item.id, { name: event.target.value })} /></label><label className="field-label">Cantidad<input className="field-input" inputMode="decimal" value={item.quantity} onChange={(event) => updateItem(item.id, { quantity: event.target.value })} /></label><label className="field-label">Unidad<input className="field-input" value={item.unit} disabled={Boolean(item.variantId)} onChange={(event) => updateItem(item.id, { unit: event.target.value })} /></label><label className="field-label">Capa<select className="field-input" value={item.layer} onChange={(event) => updateItem(item.id, { layer: event.target.value as PedidoItemDraft['layer'] })}><option value="extras">Extras</option><option value="presupuesto">Presupuesto</option></select></label></div></div>)}
      <button type="button" className="btn-secondary" onClick={() => setItems((current) => [...current, emptyPedidoItem()])}>+ Agregar ítem</button>
      <label className="field-label">Notas<textarea className="field-input operator-textarea" value={notes} onChange={(event) => setNotes(event.target.value)} /></label><button className="btn-primary button-auto" disabled={busy || !project}>{busy ? 'Enviando…' : 'Enviar pedido'}</button>
    </form></section>
    <section className="card operator-card"><div className="card-title">Mis pedidos</div>{pedidos.length ? pedidos.map((pedido) => <div className="operator-pedido-card" key={pedido.id}><div className="section-title-row"><div><strong>{pedido.pedido_number || `Pedido #${pedido.id}`}</strong><div className="text-muted">{pedido.projects?.name || `Proyecto #${pedido.project_id}`} · {pedido.kind}</div></div><Badge tone={pedido.status === 'Cerrado' ? 'success' : 'warning'}>{pedido.status}</Badge></div>{(pedido.pedido_items || []).map((item) => { const eligible = item.state === 'aprobado' || item.state === 'parcial'; const fallback = { outcome: 'recibido' as const, quantity: String(Math.max(0, (item.approved_quantity || 0) - item.received_quantity)), note: '' }; const draft = receiptDrafts[item.id] || fallback; return <div className="operator-receipt-row" key={item.id}><div><strong>{item.material_name_snapshot}</strong><div className="text-muted">Solicitado {item.requested_quantity} · aprobado {item.approved_quantity ?? '—'} · recibido {item.received_quantity} {item.unit_snapshot}</div></div><Badge tone={item.state === 'recibido' ? 'success' : item.state === 'rechazado' ? 'danger' : 'neutral'}>{item.state}</Badge>{eligible && <><select className="field-input" value={draft.outcome} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: { ...draft, outcome: event.target.value as typeof draft.outcome } }))}><option value="recibido">Recibido</option><option value="parcial">Parcial</option><option value="no_recibido">No recibido</option></select><input className="field-input" inputMode="decimal" value={draft.quantity} disabled={draft.outcome === 'no_recibido'} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: { ...draft, quantity: event.target.value } }))} placeholder="Cantidad" /><input className="field-input" value={draft.note} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: { ...draft, note: event.target.value } }))} placeholder="Incidente / nota" /><button className="btn-success" disabled={busy} onClick={() => void receive(item)}>Confirmar</button></>}</div>; })}</div>) : <p className="text-muted">Todavía no hay pedidos.</p>}</section>
  </div>;
};

const SamplesPanel = ({ project, projects, selectProject, refresh, setError, setSuccess, samples }: SharedPanelProps & { samples: WaterSample[] }) => {
  const [depth, setDepth] = useState(''); const [stage, setStage] = useState(''); const [notes, setNotes] = useState(''); const [busy, setBusy] = useState(false);
  const sampleAttempt = useStableMutationAttempt();
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!project || normalizeStatus(project.status) !== 'active') { setError('Seleccioná un proyecto En progreso.'); return; } const depthValue = numberOrNull(depth); if (depthValue !== null && depthValue < 0) { setError('La profundidad no puede ser negativa.'); return; } const payload = { projectId: project.id, depthM: depthValue ?? undefined, stage: stage.trim() || undefined, notes: notes.trim() || undefined }; const attempt = sampleAttempt.get(payload); setBusy(true); setError(null); setSuccess(null); try { await operatorApi.samples.register({ clientEntryId: attempt.clientEntryId, ...payload, takenAt: attempt.occurredAt, timestampLocal: attempt.occurredAt }); setDepth(''); setStage(''); setNotes(''); await refresh(); sampleAttempt.clear(); setSuccess('Muestra registrada. El servidor asignó el número correlativo.'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar la muestra.'); } finally { setBusy(false); } };
  return <div><ProjectPicker projects={projects} value={project?.id || 0} onChange={selectProject} /><section className="card operator-card"><div className="card-title">Registrar muestra de agua</div><div className="card-subtitle">Sin recordatorios obligatorios. La evidencia fotográfica nativa se prueba en Android.</div><form className="responsive-form-grid" onSubmit={submit}><label className="field-label">Profundidad (m)<input className="field-input" inputMode="decimal" value={depth} onChange={(event) => setDepth(event.target.value)} /></label><label className="field-label">Etapa<input className="field-input" value={stage} onChange={(event) => setStage(event.target.value)} /></label><label className="field-label grid-span-full">Notas<textarea className="field-input operator-textarea" value={notes} onChange={(event) => setNotes(event.target.value)} /></label><div className="grid-span-full"><button className="btn-primary button-auto" disabled={busy || !project}>{busy ? 'Guardando…' : 'Registrar muestra'}</button></div></form></section><section className="card operator-card"><div className="card-title">Historial del pozo</div>{samples.length ? <div className="table-scroll"><table><thead><tr><th>N.º</th><th>Fecha</th><th>Profundidad</th><th>Etapa</th><th>Notas</th></tr></thead><tbody>{samples.map((sample) => <tr key={sample.id}><td>#{sample.sample_number}</td><td>{displayDate(sample.taken_at)}</td><td>{sample.depth_m ?? '—'}</td><td>{sample.stage || '—'}</td><td>{sample.notes || '—'}</td></tr>)}</tbody></table></div> : <p className="text-muted">No hay muestras.</p>}</section></div>;
};

interface FichaValues { static: string; dynamic: string; flow: string; specific: string; maximum: string; pumpDepth: string; exploration: string; widening: string; aboveGround: string; centralizers: string; bottomPlug: string; bentonite: string; gravel: string; compressorHours: string; pumpHours: string; waterQuality: string; notes: string; signature: string }
const emptyFicha = (): FichaValues => ({ static: '', dynamic: '', flow: '', specific: '', maximum: '', pumpDepth: '', exploration: '', widening: '', aboveGround: '', centralizers: '', bottomPlug: '', bentonite: '', gravel: '', compressorHours: '', pumpHours: '', waterQuality: '', notes: '', signature: '' });
interface CasingDraft { id: string; type: CasingLayoutRow['type']; meters: string; diameter: string; notes: string }
const emptyCasing = (): CasingDraft => ({ id: operatorApi.createClientEntryId(), type: 'ciego', meters: '', diameter: '', notes: '' });

const FichaPanel = ({ assignments, setError, setSuccess }: { assignments: Array<{ project_id: number }>; setError: (message: string | null) => void; setSuccess: (message: string | null) => void }) => {
  const [projectId, setProjectId] = useState(0); const [preview, setPreview] = useState<OperatorFichaPreview | null>(null); const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false); const [values, setValues] = useState<FichaValues>(emptyFicha); const [casing, setCasing] = useState<CasingDraft[]>([emptyCasing()]); const [discrepancySection, setDiscrepancySection] = useState('perforacion'); const [discrepancy, setDiscrepancy] = useState('');
  const fichaAttempt = useStableMutationAttempt();
  const load = useCallback(async (id: number) => { if (!id) return; setLoading(true); setError(null); try { const result = await operatorApi.completion.getPreview(id); setPreview(result); const completion = result.completion as unknown as Record<string, unknown> | null; const status = String(completion?.status || ''); if (status === 'returned') { const text = (key: string) => completion?.[key] == null ? '' : String(completion[key]); setValues({ static: text('static_level'), dynamic: text('dynamic_level'), flow: text('flow_rate'), specific: completion?.specific_flow_overridden ? text('specific_flow_rate') : '', maximum: text('maximum_flow_rate'), pumpDepth: text('pump_depth_m'), exploration: text('exploration_depth_m'), widening: text('widening_depth_m'), aboveGround: text('casing_above_ground_m'), centralizers: text('centralizer_count'), bottomPlug: text('bottom_plug_details'), bentonite: text('bentonite_quantity'), gravel: text('gravel_quantity'), compressorHours: text('compressor_hours'), pumpHours: text('pump_hours'), waterQuality: text('water_quality'), notes: text('completion_notes'), signature: '' }); const layout = Array.isArray(completion?.casing_layout) ? completion.casing_layout as Array<Record<string, unknown>> : []; setCasing(layout.length ? layout.map((row) => ({ id: operatorApi.createClientEntryId(), type: ['ciego', 'filtro', 'deposito', 'otro'].includes(String(row.type)) ? String(row.type) as CasingLayoutRow['type'] : 'otro', meters: String(row.meters ?? ''), diameter: String(row.diameter ?? ''), notes: String(row.notes ?? '') })) : [emptyCasing()]); } else { setValues(emptyFicha()); setCasing([emptyCasing()]); } } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo compilar la Ficha.'); setPreview(null); } finally { setLoading(false); } }, [setError]);
  useEffect(() => { const next = assignments.some((row) => row.project_id === projectId) ? projectId : assignments[0]?.project_id || 0; if (next !== projectId) setProjectId(next); if (next) void load(next); else setPreview(null); }, [assignments, projectId, load]);
  const completion = preview?.completion; const completionStatus = String(completion?.status || ''); const editable = !completion || completionStatus === 'returned'; const openDiscrepancies = (preview?.discrepancies || []).filter((row) => row.status === 'open');
  const update = (key: keyof FichaValues, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const finalFields = (): CompletionFinalFields => { const required = [values.static, values.dynamic, values.flow, values.maximum, values.pumpDepth, values.exploration, values.widening, values.aboveGround, values.centralizers, values.bentonite, values.gravel].map(numberOrNull); if (required.some((value) => value === null)) throw new Error('Completá todos los campos numéricos obligatorios.'); const [staticLevel, dynamicLevel, flow, maximum, pumpDepth, exploration, widening, aboveGround, centralizers, bentonite, gravel] = required as number[]; if (staticLevel < 0 || dynamicLevel <= staticLevel || flow <= 0 || maximum < flow || pumpDepth <= 0 || exploration <= 0 || widening <= 0 || pumpDepth > exploration || widening > exploration) throw new Error('Revisá niveles, caudales y profundidades: están fuera de rango.'); if (aboveGround < 0 || !Number.isInteger(centralizers) || centralizers < 0 || bentonite < 0 || gravel < 0) throw new Error('El desglose de entubado contiene valores negativos o centralizadores no enteros.'); if (!values.bottomPlug.trim() || values.signature.trim().length < 2) throw new Error('El tapón de fondo y una firma nueva del operador son obligatorios.'); const layout = casing.map((row, index) => { const meters = numberOrNull(row.meters); if (meters === null || meters <= 0) throw new Error('Cada tramo de entubado necesita metros positivos.'); return { order: index + 1, type: row.type, meters, diameter: row.diameter.trim() || undefined, notes: row.notes.trim() || undefined }; }); const total = layout.reduce((sum, row) => sum + row.meters, 0); if (total <= 0 || total > exploration + aboveGround) throw new Error('El entubado total está fuera del rango del pozo.'); const sum = (type: CasingLayoutRow['type']) => layout.filter((row) => row.type === type).reduce((totalMeters, row) => totalMeters + row.meters, 0); return { static_level: staticLevel, dynamic_level: dynamicLevel, flow_rate: flow, specific_flow_rate: numberOrNull(values.specific) ?? undefined, maximum_flow_rate: maximum, pump_depth_m: pumpDepth, exploration_depth_m: exploration, widening_depth_m: widening, casing_total_m: total, casing_above_ground_m: aboveGround, blind_casing_m: sum('ciego'), filter_casing_m: sum('filtro'), sediment_trap_m: sum('deposito'), centralizer_count: centralizers, bottom_plug_details: values.bottomPlug.trim(), bentonite_quantity: bentonite, gravel_quantity: gravel, casing_layout: layout, compressor_hours: numberOrNull(values.compressorHours) ?? undefined, pump_hours: numberOrNull(values.pumpHours) ?? undefined, water_quality: values.waterQuality.trim() || undefined, installed_meters: total, perforated_meters: widening }; };
  const submit = async () => { if (!projectId || !editable) return; if (openDiscrepancies.length) { setError('Administración debe resolver las discrepancias abiertas antes del reenvío.'); return; } let fields: CompletionFinalFields; try { fields = finalFields(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Ficha inválida.'); return; } const payload = { projectId, reportId: completionStatus === 'returned' ? completion?.id : undefined, finalFields: fields, operatorSignature: values.signature.trim(), completionNotes: values.notes.trim() || undefined }; const attempt = fichaAttempt.get(payload); setBusy(true); setError(null); setSuccess(null); try { const base = { projectId, clientEntryId: attempt.clientEntryId, finalFields: fields, operatorSignature: payload.operatorSignature, completionNotes: payload.completionNotes }; if (completionStatus === 'returned' && completion) await operatorApi.completion.resubmitV2({ ...base, reportId: completion.id }); else await operatorApi.completion.submitV2(base); await load(projectId); fichaAttempt.clear(); setSuccess(completionStatus === 'returned' ? 'Ficha corregida, reconfirmada y reenviada.' : 'Ficha enviada para revisión administrativa.'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo enviar la Ficha.'); } finally { setBusy(false); } };
  const report = async () => { if (!projectId || discrepancy.trim().length < 3) { setError('Describí la discrepancia con al menos 3 caracteres.'); return; } setBusy(true); setError(null); setSuccess(null); try { await operatorApi.completion.reportDiscrepancy({ projectId, section: discrepancySection, description: discrepancy.trim(), completionReportId: completion?.id }); setDiscrepancy(''); await load(projectId); setSuccess('Discrepancia enviada a administración sin alterar la evidencia.'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo informar la discrepancia.'); } finally { setBusy(false); } };
  if (!assignments.length) return <section className="card operator-card"><div className="card-title">Sin cierres asignados</div><p className="text-muted">Administración debe designarte como operador responsable del cierre.</p></section>;
  return <div><label className="operator-project-picker"><span>Ficha asignada</span><select className="field-input" value={projectId} onChange={(event) => setProjectId(Number(event.target.value))}>{assignments.map((row) => <option key={row.project_id} value={row.project_id}>Proyecto #{row.project_id}</option>)}</select></label>{loading ? <div className="loading-screen">Compilando evidencia…</div> : preview && <><section className="card operator-card"><div className="section-title-row"><div><div className="card-title">{String((preview.project as Record<string, unknown> | null)?.well_name || (preview.project as Record<string, unknown> | null)?.name || `Proyecto #${projectId}`)}</div><div className="card-subtitle">{preview.bars.length} barras · {preview.shifts.length} turnos · {preview.samples.length} muestras</div></div>{completion && <Badge tone={completionStatus === 'returned' ? 'danger' : completion.admin_signature ? 'success' : 'warning'}>{completionStatus}</Badge>}</div>{completionStatus === 'returned' && <Notice kind="error"><strong>Devuelta:</strong> {completion?.return_reason || 'Revisá los datos y reconfirmá.'}</Notice>}<div className="responsive-form-grid"><label className="field-label">Sección a reportar<select className="field-input" value={discrepancySection} onChange={(event) => setDiscrepancySection(event.target.value)}><option value="perforacion">Perforación</option><option value="materiales">Materiales</option><option value="muestras">Muestras</option><option value="hidraulica">Hidráulica</option><option value="entubado">Entubado</option></select></label><label className="field-label">Discrepancia<input className="field-input" value={discrepancy} onChange={(event) => setDiscrepancy(event.target.value)} /></label></div><button className="btn-secondary" disabled={busy || discrepancy.trim().length < 3} onClick={() => void report()}>Reportar sin sobrescribir</button>{openDiscrepancies.length > 0 && <p className="danger-text">{openDiscrepancies.length} discrepancia(s) abierta(s).</p>}</section>{editable ? <section className="card operator-card"><div className="card-title">{completionStatus === 'returned' ? 'Corregir y reconfirmar' : 'Campos finales'}</div><div className="responsive-form-grid">{([['static', 'Nivel estático (m)'], ['dynamic', 'Nivel dinámico (m)'], ['flow', 'Caudal bombeado'], ['specific', 'Caudal específico (opcional)'], ['maximum', 'Caudal máximo'], ['pumpDepth', 'Profundidad de bomba'], ['exploration', 'Profundidad de exploración'], ['widening', 'Profundidad de ensanche'], ['aboveGround', 'Entubado sobre terreno'], ['centralizers', 'Centralizadores'], ['bentonite', 'Bentonita'], ['gravel', 'Grava'], ['compressorHours', 'Horas compresor (opcional)'], ['pumpHours', 'Horas bomba (opcional)']] as Array<[keyof FichaValues, string]>).map(([key, label]) => <label className="field-label" key={key}>{label}<input className="field-input" inputMode="decimal" value={values[key]} onChange={(event) => update(key, event.target.value)} /></label>)}<label className="field-label">Tapón de fondo<input className="field-input" value={values.bottomPlug} onChange={(event) => update('bottomPlug', event.target.value)} /></label><label className="field-label">Calidad de agua<input className="field-input" value={values.waterQuality} onChange={(event) => update('waterQuality', event.target.value)} /></label></div><div className="section-title-row section-outside-card"><strong>Esquema de entubado</strong><button className="btn-secondary" onClick={() => setCasing((current) => [...current, emptyCasing()])}>+ Tramo</button></div>{casing.map((row, index) => <div className="operator-casing-row" key={row.id}><strong>{index + 1}</strong><select className="field-input" value={row.type} onChange={(event) => setCasing((current) => current.map((item) => item.id === row.id ? { ...item, type: event.target.value as CasingDraft['type'] } : item))}><option value="ciego">Ciego</option><option value="filtro">Filtro</option><option value="deposito">Depósito</option><option value="otro">Otro</option></select><input className="field-input" inputMode="decimal" value={row.meters} onChange={(event) => setCasing((current) => current.map((item) => item.id === row.id ? { ...item, meters: event.target.value } : item))} placeholder="Metros" /><input className="field-input" value={row.diameter} onChange={(event) => setCasing((current) => current.map((item) => item.id === row.id ? { ...item, diameter: event.target.value } : item))} placeholder="Diámetro" />{casing.length > 1 && <button className="btn-danger" onClick={() => setCasing((current) => current.filter((item) => item.id !== row.id))}>Quitar</button>}</div>)}<label className="field-label">Notas finales<textarea className="field-input operator-textarea" value={values.notes} onChange={(event) => update('notes', event.target.value)} /></label><label className="field-label">Firma y aclaración nueva<input className="field-input" value={values.signature} onChange={(event) => update('signature', event.target.value)} /></label><button className="btn-success" disabled={busy || openDiscrepancies.length > 0} onClick={() => void submit()}>{busy ? 'Enviando…' : completionStatus === 'returned' ? 'Reconfirmar y reenviar' : 'Confirmar y enviar Ficha'}</button></section> : <section className="card operator-card"><div className="card-title">Ficha enviada</div><p className="text-muted">Estado: {completionStatus}. Los datos de evidencia y cierre permanecen en solo lectura.</p></section>}</>}</div>;
};

export const OperatorConsole = ({ onLogout, displayName }: { onLogout: () => Promise<void>; displayName: string }) => {
  const [tab, setTab] = useState<OperatorTab>(parseOperatorTab);
  const [projects, setProjects] = useState<OperatorProject[]>([]); const [projectId, setProjectId] = useState(0); const [materials, setMaterials] = useState<OperatorProjectMaterial[]>([]); const [catalog, setCatalog] = useState<ActiveOperatorCatalog>([]); const [shifts, setShifts] = useState<Shift[]>([]); const [bars, setBars] = useState<Awaited<ReturnType<typeof operatorApi.bars.getMine>>['data']>([]); const [pedidos, setPedidos] = useState<PedidoV2[]>([]); const [samples, setSamples] = useState<WaterSample[]>([]); const [assignments, setAssignments] = useState<Array<{ project_id: number }>>([]); const [metrics, setMetrics] = useState<OperatorAccountabilityMetrics | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [success, setSuccess] = useState<string | null>(null);
  const project = projects.find((row) => row.id === projectId) || null;
  const loadBase = useCallback(async () => { setLoading(true); setError(null); try { const [projectRows, catalogRows, shiftRows, pedidoResult, assignmentRows, metricRows] = await Promise.all([operatorApi.projects.getAssigned(), operatorApi.catalog.getActive(), operatorApi.shifts.getMine({ limit: 150 }), operatorApi.pedidos.getMine(), operatorApi.projects.getClosingAssignments(), operatorApi.shifts.getMyMetrics()]); setProjects(projectRows); setCatalog(catalogRows); setShifts(shiftRows); setPedidos(pedidoResult.data); setAssignments(assignmentRows); setMetrics(metricRows); setProjectId((current) => projectRows.some((row) => row.id === current) ? current : projectRows[0]?.id || 0); } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo cargar la consola de operador.'); } finally { setLoading(false); } }, []);
  const loadProject = useCallback(async (id: number) => { if (!id) { setMaterials([]); setBars([]); setSamples([]); return; } try { const [materialRows, barResult, sampleRows] = await Promise.all([operatorApi.projects.getMaterials(id), operatorApi.bars.getMine(id), operatorApi.samples.getHistory(id)]); setMaterials(materialRows); setBars(barResult.data); setSamples(sampleRows); } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo cargar el proyecto.'); } }, []);
  const refresh = useCallback(async () => { await loadBase(); if (projectId) await loadProject(projectId); }, [loadBase, loadProject, projectId]);
  useEffect(() => { void loadBase(); }, [loadBase]); useEffect(() => { void loadProject(projectId); }, [loadProject, projectId]);
  useEffect(() => { const onHash = () => { if (!window.location.hash.startsWith('#/operador/')) { window.history.replaceState(window.history.state, '', '#/operador/resumen'); setTab('resumen'); return; } setTab(parseOperatorTab()); }; window.addEventListener('hashchange', onHash); onHash(); return () => window.removeEventListener('hashchange', onHash); }, []);
  const navigate = (next: OperatorTab) => { setError(null); setSuccess(null); window.location.hash = `#/operador/${next}`; };
  const shared: SharedPanelProps = { project, projects, materials, selectProject: setProjectId, refresh, setError, setSuccess };
  return <div className="app-shell operator-shell"><header className="app-header"><div className="app-header-brand"><div className="app-header-logo">PHC</div><div><div className="app-header-title">Consola de Operador · QA web</div><div className="operator-online-label">Online · no reemplaza el modo offline del APK</div></div></div><button className="btn-secondary" onClick={() => void onLogout()}>Salir ({displayName})</button></header><nav className="app-nav" aria-label="Secciones de operador">{OPERATOR_TABS.map((key) => <button key={key} className={`app-nav-item ${tab === key ? 'active' : ''}`} aria-current={tab === key ? 'page' : undefined} onClick={() => navigate(key)}>{TAB_LABELS[key]}</button>)}</nav><main className="app-content"><div className="card-header management-toolbar"><div><h1 className="operator-page-title">{TAB_LABELS[tab]}</h1><p className="card-subtitle">Cuenta operador real · permisos limitados por RLS y RPC</p></div><button className="btn-secondary" disabled={loading} onClick={() => void refresh()}>{loading ? 'Actualizando…' : 'Actualizar'}</button></div>{error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}{loading && !projects.length ? <div className="loading-screen">Cargando consola…</div> : <>{tab === 'resumen' && <SummaryPanel projects={projects} metrics={metrics} shifts={shifts} pedidos={pedidos} />}{tab === 'turnos' && <TurnosPanel {...shared} shifts={shifts} />}{tab === 'progreso' && <ProgressPanel {...shared} shifts={shifts} bars={bars} />}{tab === 'pedidos' && <PedidosPanel {...shared} pedidos={pedidos} catalog={catalog} />}{tab === 'muestras' && <SamplesPanel {...shared} samples={samples} />}{tab === 'ficha' && <FichaPanel assignments={assignments} setError={setError} setSuccess={setSuccess} />}</>}</main></div>;
};
