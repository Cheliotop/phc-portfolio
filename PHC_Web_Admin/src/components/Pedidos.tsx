import { useCallback, useEffect, useMemo, useState } from 'react';
import { pedidosApi } from '../api/supabase-pedidos';
import { approvedPedidoItemNotice, pedidoApprovalExplanation } from '../domain/pedidoDecisionNotice';
import type { MaterialLayer, PedidoItem, PedidoItemState, PedidoV2 } from '../types/productV2';

interface ItemDecision {
  item: PedidoItem;
  kind: PedidoV2['kind'];
  decision: 'aprobado' | 'rechazado';
  quantity: string;
  layer: MaterialLayer;
  reason: string;
}

const operatorLabel = (pedido: PedidoV2) =>
  pedido.profiles?.full_name || pedido.profiles?.username || '—';

const stateLabel: Record<PedidoItemState, string> = {
  solicitado: 'Solicitado',
  aprobado: 'Aprobado, espera recepción',
  rechazado: 'Rechazado',
  recibido: 'Recibido',
  parcial: 'Recepción parcial',
  no_recibido: 'No recibido',
};

const stateTone = (state: PedidoItemState) => {
  if (state === 'recibido') return 'badge-success';
  if (state === 'rechazado' || state === 'no_recibido') return 'badge-danger';
  if (state === 'aprobado' || state === 'parcial') return 'badge-active';
  return 'badge-warning';
};

const order = (pedido: PedidoV2) => {
  const requested = (pedido.pedido_items || []).filter((item) => item.state === 'solicitado').length;
  const waiting = (pedido.pedido_items || []).filter((item) => item.state === 'aprobado' || item.state === 'parcial').length;
  return requested > 0 ? 0 : waiting > 0 ? 1 : 2;
};

export const Pedidos = () => {
  const [pedidos, setPedidos] = useState<PedidoV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [decision, setDecision] = useState<ItemDecision | null>(null);
  const [closing, setClosing] = useState<PedidoV2 | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await pedidosApi.getAll();
      setPedidos([...response.data].sort((a, b) => order(a) - order(b) || b.created_at.localeCompare(a.created_at)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Error al cargar pedidos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es');
    return pedidos.filter((pedido) => {
      if (kindFilter && pedido.kind !== kindFilter) return false;
      if (stateFilter && !(pedido.pedido_items || []).some((item) => item.state === stateFilter)) return false;
      if (!term) return true;
      return [
        pedido.pedido_number,
        pedido.projects?.name,
        operatorLabel(pedido),
        ...(pedido.pedido_items || []).map((item) => item.material_name_snapshot),
      ].some((value) => value?.toLocaleLowerCase('es').includes(term));
    });
  }, [pedidos, kindFilter, stateFilter, search]);

  const openDecision = (item: PedidoItem, next: ItemDecision['decision'], kind: PedidoV2['kind']) => {
    setDecision({
      item,
      kind,
      decision: next,
      quantity: next === 'aprobado' ? String(item.requested_quantity) : '',
      layer: item.layer || 'extras',
      reason: '',
    });
    setError(null);
    setNotice(null);
  };

  const saveDecision = async () => {
    if (!decision) return;
    const quantity = Number(decision.quantity);
    if (decision.decision === 'aprobado' && !(quantity > 0)) {
      setError('La cantidad aprobada debe ser mayor que cero.');
      return;
    }
    if (decision.decision === 'rechazado' && decision.reason.trim().length < 3) {
      setError('El rechazo requiere un motivo claro.');
      return;
    }
    setBusyId(decision.item.id);
    setError(null);
    try {
      await pedidosApi.decideItem({
        itemId: decision.item.id,
        decision: decision.decision,
        approvedQuantity: decision.decision === 'aprobado' ? quantity : undefined,
        reason: decision.reason,
        layer: decision.layer,
      });
      setNotice(decision.decision === 'aprobado'
        ? approvedPedidoItemNotice(decision.kind)
        : 'Ítem rechazado con motivo registrado.');
      setDecision(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar la decisión');
    } finally {
      setBusyId(null);
    }
  };

  const closePedido = async () => {
    if (!closing) return;
    if (closeReason.trim().length < 3) {
      setError('El cierre manual requiere un motivo.');
      return;
    }
    setBusyId(closing.id);
    setError(null);
    try {
      await pedidosApi.closeManually(closing.id, closeReason);
      setNotice('Pedido cerrado manualmente; el motivo quedó en auditoría.');
      setClosing(null);
      setCloseReason('');
      await load();
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : 'No se pudo cerrar el pedido');
    } finally {
      setBusyId(null);
    }
  };

  const pendingDecisions = pedidos.reduce(
    (count, pedido) => count + (pedido.pedido_items || []).filter((item) => item.state === 'solicitado').length,
    0,
  );
  const waitingReceipt = pedidos.reduce(
    (count, pedido) => count + (pedido.pedido_items || []).filter((item) => item.state === 'aprobado' || item.state === 'parcial').length,
    0,
  );

  return (
    <div>
      <div className="card-header management-toolbar">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Pedidos</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>
            {pendingDecisions} decisión(es) pendiente(s) · {waitingReceipt} ítem(s) esperan recepción
          </p>
        </div>
        <button className="btn-secondary" disabled={loading} onClick={() => void load()}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}
      {notice && <div className="success-message" role="status">{notice}</div>}

      <div className="card operation-filters">
        <div className="responsive-form-grid">
          <div>
            <label className="field-label" htmlFor="pedido-search">Buscar</label>
            <input id="pedido-search" className="field-input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Número, proyecto, operador o material" />
          </div>
          <div>
            <label className="field-label" htmlFor="pedido-kind">Tipo</label>
            <select id="pedido-kind" className="field-input" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
              <option value="">Empresa y personal</option>
              <option value="empresa">Empresa</option>
              <option value="personal">Personal</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="pedido-state">Estado de ítem</label>
            <select id="pedido-state" className="field-input" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
              <option value="">Todos</option>
              {Object.entries(stateLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loading && pedidos.length === 0 ? (
        <div className="loading-screen">Cargando pedidos…</div>
      ) : visible.length === 0 ? (
        <div className="card"><p className="text-muted">No hay pedidos para los filtros seleccionados.</p></div>
      ) : (
        <div className="pedido-v2-list">
          {visible.map((pedido) => {
            const waiting = (pedido.pedido_items || []).some((item) => item.state === 'aprobado' || item.state === 'parcial');
            const canManualClose = !pedido.closed_manually && waiting;
            return (
              <article className="card pedido-v2-card" key={pedido.id}>
                <div className="section-title-row">
                  <div>
                    <div className="card-title">{pedido.pedido_number || `Pedido #${pedido.id}`}</div>
                    <div className="card-subtitle">
                      {pedido.projects?.name || `Proyecto #${pedido.project_id}`} · {operatorLabel(pedido)} · {new Date(pedido.created_at).toLocaleString('es-PY')}
                    </div>
                  </div>
                  <div className="flag-summary">
                    <span className={`badge ${pedido.kind === 'empresa' ? 'badge-active' : 'badge-neutral'}`}>
                      {pedido.kind === 'empresa' ? 'Empresa' : 'Personal'}
                    </span>
                    <span className="badge badge-warning">{pedido.priority || 'Normal'}</span>
                    <span className="badge badge-neutral">{pedido.status}</span>
                  </div>
                </div>
                {pedido.kind === 'empresa' && (
                  <div className="pedido-justification"><strong>Justificación:</strong> {pedido.justification || '—'}</div>
                )}

                <div className="pedido-items">
                  {(pedido.pedido_items || []).map((item) => (
                    <div className="pedido-item" key={item.id}>
                      <div className="operation-row-main">
                        <div>
                          <strong>{item.material_name_snapshot}</strong>
                          <div className="catalog-meta">
                            Solicitado: {item.requested_quantity} {item.unit_snapshot}
                            {item.approved_quantity != null ? ` · Aprobado: ${item.approved_quantity}` : ''}
                            {item.received_quantity ? ` · Recibido: ${item.received_quantity}` : ''}
                            {' · '}{item.layer}
                          </div>
                        </div>
                        <span className={`badge ${stateTone(item.state)}`}>{stateLabel[item.state]}</span>
                      </div>

                      {item.state === 'solicitado' && (
                        <div className="form-actions compact-actions">
                          <button className="btn-success" onClick={() => openDecision(item, 'aprobado', pedido.kind)}>Aprobar ítem</button>
                          <button className="btn-danger" onClick={() => openDecision(item, 'rechazado', pedido.kind)}>Rechazar ítem</button>
                        </div>
                      )}
                      {item.decision_reason && <div className="audit-reason">Decisión: {item.decision_reason}</div>}
                      {item.incident_note && <div className="handover-alert">Incidente: {item.incident_note}</div>}
                      {(item.pedido_receipts || []).length > 0 && (
                        <div className="receipt-history">
                          {(item.pedido_receipts || []).map((receipt) => (
                            <div key={receipt.id}>
                              {new Date(receipt.created_at).toLocaleString('es-PY')} · {receipt.outcome.replace('_', ' ')} · {receipt.quantity_received} {item.unit_snapshot}
                              {receipt.incident_note ? ` · ${receipt.incident_note}` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {canManualClose && (
                  <button className="btn-secondary" onClick={() => { setClosing(pedido); setCloseReason(''); setError(null); }}>
                    Cerrar manualmente por incidente
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}

      {decision && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="decision-title">
          <div className="modal-card">
            <h3 id="decision-title" className="card-title">
              {decision.decision === 'aprobado' ? 'Aprobar ítem' : 'Rechazar ítem'}
            </h3>
            <p className="card-subtitle">{decision.item.material_name_snapshot} · solicitado {decision.item.requested_quantity} {decision.item.unit_snapshot}</p>
            {decision.decision === 'aprobado' ? (
              <>
                <div className="success-message">
                  {pedidoApprovalExplanation(decision.kind)}
                </div>
                <label className="field-label" htmlFor="decision-qty">Cantidad aprobada</label>
                <input id="decision-qty" className="field-input" type="number" min="0" step="any" value={decision.quantity} onChange={(event) => setDecision({ ...decision, quantity: event.target.value })} />
                {decision.kind === 'empresa' && (
                  <>
                    <label className="field-label" htmlFor="decision-layer">Capa al recibir</label>
                    <select id="decision-layer" className="field-input" value={decision.layer} onChange={(event) => setDecision({ ...decision, layer: event.target.value as MaterialLayer })}>
                      <option value="presupuesto">Presupuesto</option>
                      <option value="extras">Extras</option>
                    </select>
                  </>
                )}
                <label className="field-label" htmlFor="decision-note">Nota de decisión</label>
                <textarea id="decision-note" className="field-input" value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value })} />
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="reject-reason">Motivo obligatorio</label>
                <textarea id="reject-reason" className="field-input" value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value })} />
              </>
            )}
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setDecision(null)}>Cancelar</button>
              <button className={decision.decision === 'aprobado' ? 'btn-success' : 'btn-danger'} disabled={busyId === decision.item.id} onClick={() => void saveDecision()}>
                {busyId === decision.item.id ? 'Guardando…' : 'Confirmar decisión'}
              </button>
            </div>
          </div>
        </div>
      )}

      {closing && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="close-title">
          <div className="modal-card">
            <h3 id="close-title" className="card-title">Cerrar pedido por incidente</h3>
            <p className="card-subtitle">No inventa una recepción. Cierra los ítems pendientes y deja el motivo en el historial.</p>
            <label className="field-label" htmlFor="close-reason">Motivo obligatorio</label>
            <textarea id="close-reason" className="field-input" value={closeReason} onChange={(event) => setCloseReason(event.target.value)} />
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setClosing(null)}>Cancelar</button>
              <button className="btn-danger" disabled={busyId === closing.id} onClick={() => void closePedido()}>
                {busyId === closing.id ? 'Cerrando…' : 'Confirmar cierre manual'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
