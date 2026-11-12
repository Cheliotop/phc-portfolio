import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { passwordError } from '../domain/accountRules';
import { friendlyApiError } from '../api/supabase-api-errors';

// Lets the logged-in admin rotate their own password without leaving the
// app. A *forgotten* admin password is a different path (Supabase dashboard
// → Authentication → Users → Reset password) — documented in HANDOFF.md.
export const ChangePassword = ({ onClose }: { onClose: () => void }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSave = async () => {
    const invalidPassword = passwordError(password);
    if (invalidPassword) {
      setError(invalidPassword);
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setDone(true);
    } catch (e: any) {
      setError(friendlyApiError(e, 'No se pudo cambiar la contraseña').message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 420, margin: '0 auto 14px', borderLeft: '3px solid var(--accent)' }}>
      <div className="card-title">Cambiar mi contraseña</div>
      {done ? (
        <>
          <p style={{ marginTop: 0 }}>Contraseña actualizada correctamente.</p>
          <button className="btn-primary" style={{ width: 'auto', marginTop: 0 }} onClick={onClose}>Cerrar</button>
        </>
      ) : (
        <>
          {error && <div className="login-error">{error}</div>}
          <label className="field-label">Nueva contraseña</label>
          <input className="field-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <label className="field-label">Repetir nueva contraseña</label>
          <input className="field-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" style={{ width: 'auto' }} disabled={saving} onClick={handleSave}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
            <button className="btn-secondary" style={{ marginTop: 22 }} onClick={onClose}>Cancelar</button>
          </div>
        </>
      )}
    </div>
  );
};
