import { Fragment, useEffect, useState } from 'react';
import { operatorsApi } from '../api/supabase-operators';
import { friendlyApiError } from '../api/supabase-api-errors';
import { adminCreateOperator } from '../api/adminCreateOperator';
import { adminResetOperatorPassword } from '../api/adminResetOperatorPassword';
import { MIN_PASSWORD_LENGTH, normalizeUsername, passwordError, usernameError } from '../domain/accountRules';
import { supabase } from '../lib/supabase';
import { deactivationConfirmation } from '../domain/operatorDeactivation';
import { ACTIVE_PROJECT_STATUSES } from '../domain/projectStatus';
import { inBatches } from '../domain/paging.ts';

interface Operator {
  id: string;
  username: string;
  email?: string;
  full_name?: string;
  role: string;
  is_active: boolean;
  auth_available?: boolean;
}

export const Operadores = () => {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetDone, setResetDone] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await operatorsApi.getAll();
      setOperators((all || []).filter((p: any) => p.role === 'operator'));
    } catch (e: any) {
      setError(friendlyApiError(e, 'Error al cargar operadores').message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    const invalidAccount = usernameError(username) ?? passwordError(password);
    if (invalidAccount) {
      setError(invalidAccount);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminCreateOperator({
        username: normalizeUsername(username),
        password,
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
      });
      setShowCreate(false);
      setUsername('');
      setPassword('');
      setFirstName('');
      setLastName('');
      await load();
    } catch (e: any) {
      setError(friendlyApiError(e, 'No se pudo crear el operador').message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (op: Operator) => {
    if (op.is_active) {
      setBusyId(op.id);
      setError(null);
      let confirmation = '';
      try {
        const [shiftResult, participantResult, primaryResult, secondaryResult] = await Promise.all([
          supabase.from('shifts').select('id, project_id').eq('operator_id', op.id).in('status', ['open', 'report_pending']),
          supabase.from('shift_participants').select('shift_id').eq('operator_id', op.id),
          supabase.from('projects').select('id, name').eq('assigned_operator_id', op.id).in('status', ACTIVE_PROJECT_STATUSES),
          supabase.from('project_secondary_operators').select('project_id').eq('operator_id', op.id),
        ]);
        if (shiftResult.error || participantResult.error || primaryResult.error || secondaryResult.error) {
          setError('No se pudo revisar la actividad del operador. No se desactivó.');
          return;
        }
        const participantShiftIds = [...new Set((participantResult.data || []).map((row) => row.shift_id))];
        // Every shift this operator ever joined: read in batches, the ids travel in the URL.
        const participantReplies = await Promise.all(inBatches(participantShiftIds).map((ids) =>
          supabase.from('shifts').select('id, project_id').in('id', ids).in('status', ['open', 'report_pending'])));
        const participantFailed = participantReplies.find((reply) => reply.error);
        const participantOpenShifts = participantShiftIds.length
          ? { data: participantReplies.flatMap((reply) => reply.data || []), error: participantFailed?.error ?? null }
          : null;
        if (participantOpenShifts?.error) {
          setError('No se pudo revisar los turnos del operador. No se desactivó.');
          return;
        }
        const secondaryProjectIds = [...new Set((secondaryResult.data || []).map((row) => row.project_id))];
        const secondaryProjects = secondaryProjectIds.length
          ? await supabase.from('projects').select('id, name').in('status', ACTIVE_PROJECT_STATUSES).in('id', secondaryProjectIds)
          : null;
        if (secondaryProjects?.error) {
          setError('No se pudo revisar los equipos del operador. No se desactivó.');
          return;
        }
        const openShiftCount = new Set([
          ...(shiftResult.data || []).map((shift) => shift.id),
          ...(participantOpenShifts?.data || []).map((shift) => shift.id),
        ]).size;
        const activeWells = [...(primaryResult.data || []), ...(secondaryProjects?.data || [])];
        confirmation = deactivationConfirmation({
          name: op.full_name || op.username,
          openShiftCount,
          wellNames: activeWells.map((well) => well.name),
        });
      } catch {
        setError('No se pudo revisar la actividad del operador. No se desactivó.');
        return;
      } finally {
        setBusyId(null);
      }
      if (!window.confirm(confirmation)) return;
    }
    setBusyId(op.id);
    try {
      await operatorsApi.setActive(op.id, !op.is_active);
      await load();
    } catch (e: any) {
      setError(friendlyApiError(e, 'No se pudo actualizar el operador').message);
    } finally {
      setBusyId(null);
    }
  };

  const handleResetPassword = async (op: Operator) => {
    const invalidPassword = passwordError(resetPassword);
    if (invalidPassword) {
      setError(invalidPassword);
      return;
    }
    setBusyId(op.id);
    setError(null);
    try {
      await adminResetOperatorPassword(op.id, resetPassword);
      setResetDone(`Contraseña de ${op.username} actualizada. Avisale la nueva contraseña al operador.`);
      setResettingId(null);
      setResetPassword('');
    } catch (e: any) {
      setError(friendlyApiError(e, 'No se pudo restablecer la contraseña').message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="card-header">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Operadores</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>Total: {operators.length} · Activos: {operators.filter((o) => o.is_active).length}</p>
        </div>
        <button className="btn-primary" style={{ width: 'auto', marginTop: 0 }} onClick={() => setShowCreate((s) => !s)}>
          {showCreate ? 'Cancelar' : '+ Nuevo Operador'}
        </button>
      </div>

      {error && <div className="login-error">{error}</div>}
      {resetDone && (
        <div className="card" style={{ borderLeft: '3px solid var(--success)', padding: 12 }}>
          {resetDone}
          <button className="btn-secondary" style={{ marginLeft: 12, padding: '4px 10px' }} onClick={() => setResetDone(null)}>OK</button>
        </div>
      )}

      {showCreate && (
        <div className="card">
          <div className="card-title">Nuevo Operador</div>
          <div className="form-row">
            <div style={{ flex: 1 }}>
              <label className="field-label">Usuario *</label>
              <input className="field-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ej: juanperez" />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">Contraseña *</label>
              <input className="field-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div style={{ flex: 1 }}>
              <label className="field-label">Nombre</label>
              <input className="field-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">Apellido</label>
              <input className="field-input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <button className="btn-primary" style={{ width: 'auto' }} disabled={saving} onClick={handleCreate}>
            {saving ? 'Creando…' : 'Crear Operador'}
          </button>
        </div>
      )}

      <div className="card">
        {loading ? (
          <p className="text-muted">Cargando…</p>
        ) : operators.length === 0 ? (
          <p className="text-muted">No hay operadores registrados todavía.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Nombre</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {operators.map((op) => (
                  <Fragment key={op.id}>
                    <tr>
                      <td>{op.username}</td>
                      <td>{op.full_name || '—'}</td>
                      <td>
                        <span className={`badge ${op.is_active ? 'badge-success' : 'badge-neutral'}`}>
                          {op.auth_available === false ? 'Acceso eliminado' : op.is_active ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td>
                        <div className="actions-cell">
                          <button
                            className={op.is_active ? 'btn-danger' : 'btn-success'}
                            disabled={busyId === op.id || op.auth_available === false}
                            onClick={() => toggleActive(op)}
                          >
                            {busyId === op.id ? '…' : op.is_active ? 'Desactivar' : 'Activar'}
                          </button>
                          <button
                            className="btn-secondary"
                            disabled={op.auth_available === false}
                            onClick={() => {
                              setResettingId(resettingId === op.id ? null : op.id);
                              setResetPassword('');
                            }}
                          >
                            {resettingId === op.id ? 'Cancelar' : 'Restablecer contraseña'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {resettingId === op.id && (
                      <tr>
                        <td colSpan={4} style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <div className="form-row" style={{ marginTop: 0, alignItems: 'center' }}>
                            <input
                              className="field-input"
                              type="text"
                              placeholder={`Nueva contraseña (mín. ${MIN_PASSWORD_LENGTH} caracteres)`}
                              value={resetPassword}
                              onChange={(e) => setResetPassword(e.target.value)}
                              style={{ maxWidth: 280 }}
                            />
                            <button className="btn-success" disabled={busyId === op.id || op.auth_available === false} onClick={() => handleResetPassword(op)}>
                              {busyId === op.id ? 'Guardando…' : 'Confirmar'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
