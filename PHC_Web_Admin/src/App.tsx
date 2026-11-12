import { Suspense, lazy, useEffect, useState } from 'react';
import './App.css';
import { useAuth } from './hooks/useAuth';
import { Login } from './components/Login';
import { ChangePassword } from './components/ChangePassword';
import { projectsApi } from './api/supabase-projects';
import { pedidosApi } from './api/supabase-pedidos';
import { exportPedidosCsv, exportProjectsCsv } from './utils/exportCsv';
import { writePedidosList, writeProjectsList } from './utils/printableLists';
import { useHashRoute } from './hooks/useHashRoute';

// Tab panels are route-level code-split: the login shell stays light and each
// admin section loads on first visit. Named exports are remapped to default
// for React.lazy so the component files themselves don't change.
const Dashboard = lazy(() => import('./components/Dashboard').then((m) => ({ default: m.Dashboard })));
const Proyectos = lazy(() => import('./components/Proyectos').then((m) => ({ default: m.Proyectos })));
const Catalogo = lazy(() => import('./components/Catalogo').then((m) => ({ default: m.Catalogo })));
const Operacion = lazy(() => import('./components/Operacion').then((m) => ({ default: m.Operacion })));
const Operadores = lazy(() => import('./components/Operadores').then((m) => ({ default: m.Operadores })));
const Pedidos = lazy(() => import('./components/Pedidos').then((m) => ({ default: m.Pedidos })));
const Cierres = lazy(() => import('./components/Cierres').then((m) => ({ default: m.Cierres })));
const Revision = lazy(() => import('./components/Revision').then((m) => ({ default: m.Revision })));

// No "Inventario" tab (removed 2026-07-10) — materials are assigned directly
// per-project (Proyectos) or via approving a pedido, not drawn from a shared
// warehouse stock.
const TABS = [
  { key: 'resumen', label: 'Resumen' },
  { key: 'proyectos', label: 'Proyectos' },
  { key: 'catalogo', label: 'Catálogo' },
  { key: 'operacion', label: 'Operación' },
  { key: 'operadores', label: 'Operadores' },
  { key: 'pedidos', label: 'Pedidos' },
  { key: 'cierres', label: 'Cierres' },
  { key: 'revision', label: 'Revisión' },
] as const;

function App() {
  const { user, loading, logout, isAdmin, isOperator } = useAuth();
  const { route, navigate } = useHashRoute();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin && window.location.hash.startsWith('#/operador/')) {
      navigate('resumen');
    }
  }, [isAdmin, navigate]);

  const handleExport = async (kind: 'projects' | 'pedidos', format: 'csv' | 'pdf' = 'csv') => {
    const printWindow = format === 'pdf' ? window.open('about:blank', '_blank') : null;
    if (format === 'pdf' && !printWindow) {
      setExportError('El navegador bloqueó la ventana del reporte. Permití ventanas emergentes e intentá de nuevo.');
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      if (kind === 'projects') {
        const projects = await projectsApi.getAll();
        if (format === 'pdf' && printWindow) writeProjectsList(printWindow, (projects || []) as any[]);
        else exportProjectsCsv((projects || []) as any[]);
      } else {
        const pedidosRes = await pedidosApi.getAll();
        if (format === 'pdf' && printWindow) writePedidosList(printWindow, pedidosRes.data || []);
        else exportPedidosCsv((pedidosRes.data || []) as any[]);
      }
    } catch (e: any) {
      printWindow?.close();
      setExportError(e?.message || 'No se pudo exportar');
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return <div className="loading-screen">Cargando…</div>;
  }

  if (!user) {
    return <Login />;
  }

  // The web operator console ("QA web") is hidden from operators: it cannot yet show a
  // well's equipo partner or the shift the partner opened (audit WEB-11). Operators work
  // in the phone or tablet app.
  if (isOperator) {
    return (
      <div className="card" style={{ maxWidth: 480, margin: '48px auto' }}>
        <div className="card-title">Consola web no disponible</div>
        <p className="card-subtitle">Los operadores trabajan desde la app de PHC en el teléfono o la tablet. Esta consola web es solo para administración.</p>
        <button className="btn-secondary" onClick={logout}>Salir</button>
      </div>
    );
  }

  if (!isAdmin) {
    return <div className="loading-screen">La cuenta no tiene un rol habilitado.</div>;
  }

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="app-header-brand">
          <div className="app-header-logo">PHC</div>
          <div className="app-header-title">Administración · Panel de Control</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn-secondary" disabled={exporting} onClick={() => handleExport('projects')}>
            {exporting ? 'Exportando…' : 'CSV Proyectos'}
          </button>
          <button className="btn-secondary" disabled={exporting} onClick={() => handleExport('pedidos')}>
            CSV Pedidos
          </button>
          <button className="btn-secondary" disabled={exporting} onClick={() => handleExport('projects', 'pdf')}>
            PDF Proyectos
          </button>
          <button className="btn-secondary" disabled={exporting} onClick={() => handleExport('pedidos', 'pdf')}>
            PDF Pedidos
          </button>
          <button className="btn-secondary" onClick={() => setShowChangePassword((s) => !s)}>Cambiar contraseña</button>
          <button className="btn-secondary" onClick={logout}>Salir ({user.full_name || user.username || user.email})</button>
        </div>
      </div>
      {exportError && (
        <div className="login-error" style={{ margin: '8px 16px 0' }}>{exportError}</div>
      )}

      <div className="app-nav">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`app-nav-item ${route.tab === t.key ? 'active' : ''}`}
            aria-current={route.tab === t.key ? 'page' : undefined}
            onClick={() => navigate(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="app-content">
        {showChangePassword && <ChangePassword onClose={() => setShowChangePassword(false)} />}
        {route.tab === null ? (
          <div className="card">
            <div className="card-title">Sección no encontrada</div>
            <p className="card-subtitle">La dirección solicitada no existe en el panel.</p>
            <button className="btn-primary" style={{ width: 'auto', marginTop: 0 }} onClick={() => navigate('resumen')}>
              Volver al Resumen
            </button>
          </div>
        ) : (
          <Suspense fallback={<div className="loading-screen">Cargando…</div>}>
            {route.tab === 'resumen' && <Dashboard />}
            {route.tab === 'proyectos' && <Proyectos />}
            {route.tab === 'catalogo' && <Catalogo />}
            {route.tab === 'operacion' && <Operacion />}
            {route.tab === 'operadores' && <Operadores />}
            {route.tab === 'pedidos' && <Pedidos />}
            {route.tab === 'cierres' && <Cierres />}
            {route.tab === 'revision' && <Revision />}
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default App;
