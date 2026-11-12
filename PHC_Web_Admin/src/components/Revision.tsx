import { useCallback, useEffect, useState } from 'react';
import { rejectedWorkApi, type RejectedWorkDecision, type RejectedWorkReport } from '../api/supabase-rejected-work';
import { SENT_LATER_TEXT, addsToRecord, rejectedWorkDetails, rejectedWorkLabel, rejectionReasonText } from '../domain/rejectedWork';
import { sentByLabel } from '../domain/revisionAuthorship';

const when = (value: string | null): string => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const Revision = () => {
  const [items, setItems] = useState<RejectedWorkReport[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await rejectedWorkApi.listPending());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar la lista de revisión.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (item: RejectedWorkReport, decision: RejectedWorkDecision) => {
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      await rejectedWorkApi.decide(item.id, decision, notes[item.id]);
      setNotice(decision === 'accepted' ? 'Registro aceptado.' : 'Registro rechazado. Queda guardado con el motivo.');
      setNotes((current) => {
        const rest = { ...current };
        delete rest[item.id];
        return rest;
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la decisión.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="card-header">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Revisión</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>
            Trabajo de campo que el servidor rechazó. Aceptá o rechazá cada registro.
          </p>
        </div>
        <button className="btn-secondary button-auto" onClick={() => void load()}>Actualizar</button>
      </div>

      {notice && <div className="success-message" role="status">{notice}</div>}
      {error && <div className="error-message" role="alert">{error}</div>}

      {loading && <div className="card"><p className="text-muted">Cargando…</p></div>}
      {!loading && !error && items.length === 0 && (
        <div className="card">
          <p className="text-muted">Nada para revisar. Acá aparece el trabajo que el servidor no aceptó.</p>
        </div>
      )}

      {items.map((item) => {
        const automatic = addsToRecord(item.entity);
        const sentBy = sentByLabel(item);
        const busy = busyId === item.id;
        return (
          <div className="card" key={item.id}>
            <h3 style={{ marginTop: 0 }}>{rejectedWorkLabel(item.entity)}</h3>
            <p>
              {item.project?.well_name || item.project?.name || 'Sin pozo'}
              {' · '}
              {item.operator?.full_name || item.operator?.username || 'Operador desconocido'}
              {' · '}
              {when(item.rejected_at || item.created_at)}
            </p>
            {rejectedWorkDetails(item.payload).map((detail) => <p className="text-muted" key={detail}>{detail}</p>)}
            <p><strong>Motivo:</strong> {rejectionReasonText(item.rejection_reason)}</p>
            {item.sent_later_at && <p style={{ color: 'var(--success, #1e8e3e)', fontWeight: 600 }}>{SENT_LATER_TEXT}</p>}
            {sentBy && <p className="text-muted">{sentBy}</p>}
            <p className="text-muted">
              {automatic
                ? 'Si lo aceptás, se suma al registro del pozo con una marca de revisión.'
                : 'Si lo aceptás, cargalo a mano e indicá qué hiciste en la nota.'}
            </p>
            <label className="field-label" htmlFor={`revision-note-${item.id}`}>
              {automatic ? 'Nota (obligatoria para rechazar)' : 'Nota obligatoria'}
            </label>
            <textarea
              id={`revision-note-${item.id}`}
              className="field-input"
              value={notes[item.id] || ''}
              onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
            />
            <div className="form-actions">
              <button className="btn-danger" disabled={busy} onClick={() => void decide(item, 'rejected')}>Rechazar</button>
              <button className="btn-success" disabled={busy} onClick={() => void decide(item, 'accepted')}>
                {busy ? 'Guardando…' : 'Aceptar'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
