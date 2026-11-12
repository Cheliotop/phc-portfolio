import { useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';

export const Login = () => {
  const { login, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const identity = email.trim().toLowerCase();
    const loginEmail = identity.includes('@') ? identity : `${identity}@phc.local`;
    await login(loginEmail, password);
    setSubmitting(false);
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <div className="login-logo">PHC</div>
          <div className="login-brand-name">PERFORACIONES HIDROGEOLÓGICAS CHACO</div>
          <div className="login-tagline">Acceso de administración y operadores</div>
        </div>

        {error && <div className="login-error">{error}</div>}

        <label className="field-label">Usuario o email</label>
        <input
          className="field-input"
          type="text"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />

        <label className="field-label">Contraseña</label>
        <input
          className="field-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        <button className="btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Iniciando…' : 'Iniciar Sesión'}
        </button>
      </form>
    </div>
  );
};
