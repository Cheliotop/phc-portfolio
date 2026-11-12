import { useEffect, useState } from 'react';
import { adminStatsApi, type AdminStats } from '../api/adminStats';
import { friendlyApiError } from '../api/supabase-api-errors';
import { drillingBarsApi } from '../api/supabase-drilling-bars';
import { pedidosApi } from '../api/supabase-pedidos';
import { completionApi } from '../api/supabase-completion';
import { materialsApi } from '../api/supabase-materials';
import { projectsApi } from '../api/supabase-projects';
import { shiftsApi } from '../api/supabase-shifts';
import { productProjectsApi } from '../api/supabase-product-projects';
import { failedSourcesMessage, recordFailure } from '../domain/dashboardLoad';
import { cierreFeedLabel, pedidoStatusLabel, unresolvedLateShifts } from '../domain/dashboardFeed';
import { normalizeStatus } from '../domain/projectStatus';
import type { PedidoV2, ProjectMaterialAssignment, Shift } from '../types/productV2';
import type { CompletionReport } from '../types/completionReview';

interface ActivityItem {
  kind: 'progress' | 'pedido' | 'cierre' | 'consumo';
  title: string;
  subtitle: string;
  created_at?: string;
}

interface ProjectSummary {
  id: number;
  name: string;
  location?: string | null;
  targetDepth?: number | null;
  currentDepth: number;
  bars: number;
  shifts: Shift[];
  materials: ProjectMaterialAssignment[];
  pedidos: PedidoV2[];
  completion?: CompletionReport;
  lastActivity?: string;
  // Sources that failed to load: their counts and flags are unknown, not zero.
  missing: string[];
}

// Source labels, as shown to the admin when they fail to load.
const PEDIDOS = 'pedidos';
const TURNOS = 'turnos';
const FICHAS = 'Fichas';
const FEED_SOURCES = ['barras recientes', PEDIDOS, FICHAS, 'consumos'];

const formatDateTime = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Asuncion' });
};

const statValue = (stats: AdminStats | null, key: keyof AdminStats) => (stats ? stats[key] ?? 0 : '—');

const latest = (values: Array<string | null | undefined>) => values
  .filter((value): value is string => Boolean(value))
  .sort((left, right) => right.localeCompare(left))[0];

export const Dashboard = () => {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      // Each secondary source that fails is recorded here and shown as an error (WEB-9).
      const failed: string[] = [];
      try {
        const [statsResult, recentBars, pedidosRes, cierresRes, consumoRes, projectRows, shiftRows] = await Promise.all([
          adminStatsApi.getStats(),
          drillingBarsApi.getAll().catch(recordFailure(failed, 'barras recientes', () => ({ data: [] }))),
          pedidosApi.getAll().catch(recordFailure(failed, PEDIDOS, () => ({ data: [] as PedidoV2[] }))),
          completionApi.getAll().catch(recordFailure(failed, FICHAS, () => ({ data: [] as CompletionReport[] }))),
          materialsApi.getRecentConsumption().catch(recordFailure(failed, 'consumos', () => ({ data: [] }))),
          projectsApi.getAll({ orderBy: 'updated_at', orderDir: 'desc' }) as Promise<any[]>,
          shiftsApi.getAll({ limit: 500 }).catch(recordFailure(failed, TURNOS, () => [] as Shift[])),
        ]);
        if (cancelled) return;
        setStats(statsResult);

        const active = projectRows.filter((project) =>
          ['planning', 'active', 'closure_submitted'].includes(normalizeStatus(project.status)),
        );
        // Two requests for every well together, not two per well. A failure now shows
        // as an error instead of every well at 0 m (code read W5).
        const activeIds = active.map((project) => Number(project.id));
        const [allBars, allMaterials] = await Promise.all([
          drillingBarsApi.getForProjects(activeIds),
          productProjectsApi.getActiveMaterialAssignmentsFor(activeIds),
        ]);
        if (cancelled) return;
        const summaries = active.map((project): ProjectSummary => {
          const bars = allBars.filter((bar) => Number(bar.project_id) === Number(project.id));
          const materialRows = allMaterials.filter((row) => Number(row.project_id) === Number(project.id));
          const projectShifts = shiftRows.filter((shift) => Number(shift.project_id) === Number(project.id));
          const projectPedidos = pedidosRes.data.filter((pedido) => Number(pedido.project_id) === Number(project.id));
          const completion = cierresRes.data.find((report) => Number(report.project_id) === Number(project.id));
          return {
            missing: failed,
            id: project.id,
            name: project.well_name || project.name,
            location: project.location,
            targetDepth: project.target_depth,
            currentDepth: Math.max(0, ...bars.map((bar: any) => Number(bar.depth_end || 0))),
            bars: bars.length,
            shifts: projectShifts,
            materials: materialRows,
            pedidos: projectPedidos,
            completion,
            lastActivity: latest([
              ...bars.map((bar: any) => bar.created_at),
              ...projectShifts.map((shift) => shift.ended_at || shift.started_at),
              ...projectPedidos.map((pedido) => pedido.created_at),
              completion?.submitted_at || completion?.created_at,
            ]),
          };
        });
        if (!cancelled) setProjects(summaries);

        const feed: ActivityItem[] = [];
        for (const bar of (recentBars.data || []).slice(0, 12) as any[]) {
          feed.push({
            kind: 'progress',
            title: `Progreso · ${bar.projects?.name || 'Pozo'}`,
            subtitle: `Profundidad ${bar.depth_end ?? '-'} m`,
            created_at: bar.created_at,
          });
        }
        for (const pedido of pedidosRes.data.slice(0, 12)) {
          const first = pedido.pedido_items?.[0];
          feed.push({
            kind: 'pedido',
            title: `Pedido · ${first?.material_name_snapshot || pedido.pedido_number || 'material'}`,
            subtitle: `${pedido.pedido_items?.length || 0} ítem(s) · ${pedido.projects?.name || 'Sin proyecto'} · ${pedidoStatusLabel(pedido.status)}`,
            created_at: pedido.created_at,
          });
        }
        for (const consumption of (consumoRes.data || []) as any[]) {
          feed.push({
            kind: 'consumo',
            title: `Consumo · ${consumption.material_name || 'material'}`,
            subtitle: `${consumption.quantity_used ?? ''} ${consumption.unit || ''} · ${consumption.projects?.name || 'Pozo'}${consumption.anomaly_flag ? ' · anomalía' : ''}`,
            created_at: consumption.created_at,
          });
        }
        for (const completion of cierresRes.data.slice(0, 12)) {
          feed.push({
            kind: 'cierre',
            title: `Cierre · ${completion.projects?.name || 'Pozo'}`,
            subtitle: cierreFeedLabel(completion),
            created_at: completion.created_at,
          });
        }
        feed.sort((left, right) => new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime());
        if (!cancelled) setActivity(feed.slice(0, 15));
      } catch (loadError) {
        if (!cancelled) setError(friendlyApiError(loadError, 'No se pudo cargar el panel de control.').message);
      } finally {
        if (!cancelled) {
          setFailures(failed);
          setLoading(false);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [attempt]);

  if (loading) return <div className="loading-screen">Cargando panel de control…</div>;

  const sourceMessage = failedSourcesMessage(failures);
  const feedFailed = failures.some((failure) => FEED_SOURCES.includes(failure));

  return (
    <div>
      <h2 className="card-title" style={{ marginBottom: 4 }}>Panel de Control</h2>
      <p className="card-subtitle">Cada pozo como unidad operativa, con alertas globales</p>
      {error && <div className="login-error" role="alert">{error}</div>}
      {!error && sourceMessage && <div className="login-error" role="alert">{sourceMessage}</div>}
      {(error || sourceMessage) && (
        <button className="btn-secondary" style={{ marginBottom: 12 }} onClick={() => setAttempt((count) => count + 1)}>Reintentar</button>
      )}

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-icon neutral"><svg viewBox="0 0 24 24"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/></svg></div><div><div className="stat-number">{statValue(stats, 'activeProjects')}</div><div className="stat-label">Proyectos Activos</div></div></div>
        <div className="stat-card"><div className="stat-icon neutral"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6"/></svg></div><div><div className="stat-number">{statValue(stats, 'activeOperators')}</div><div className="stat-label">Operadores</div></div></div>
        <div className="stat-card"><div className="stat-icon warn"><svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/></svg></div><div><div className="stat-number">{statValue(stats, 'pendingPedidos')}</div><div className="stat-label">Pedidos Pendientes</div></div></div>
        <div className="stat-card"><div className="stat-icon danger"><svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18"/><path d="M8 4v6M16 4v6"/></svg></div><div><div className="stat-number">{statValue(stats, 'projectsWithoutMaterials')}</div><div className="stat-label">Proyectos Sin Materiales</div></div></div>
        <div className="stat-card"><div className={`stat-icon ${stats?.unsignedCierres ? 'warn' : 'ok'}`}><svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg></div><div><div className="stat-number">{statValue(stats, 'unsignedCierres')}</div><div className="stat-label">Cierres por Firmar</div></div></div>
      </div>

      <section>
        <div className="section-title-row section-outside-card"><div><h3 className="card-title">Pozos activos</h3><p className="card-subtitle">Progreso, turnos, materiales y pedidos agrupados por pozo</p></div></div>
        {error ? null : projects.length === 0 ? <div className="card"><div className="empty-state"><div className="empty-icon"><svg viewBox="0 0 24 24"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/></svg></div><div className="empty-title">Todavía no hay pozos activos</div><div className="empty-sub">Creá el primer proyecto para empezar a registrar barras, materiales y pedidos.</div></div></div> : (
          <div className="well-dashboard-grid">
            {projects.map((project) => {
              const pedidosKnown = !project.missing.includes(PEDIDOS);
              const turnosKnown = !project.missing.includes(TURNOS);
              const cierresKnown = !project.missing.includes(FICHAS);
              // Only unresolved shifts count: a closed auto-close is not a pending report (WEB-17).
              const unresolvedShifts = project.shifts.filter((shift) => shift.status !== 'closed');
              const lateShifts = unresolvedLateShifts(project.shifts);
              const lowMaterials = project.materials.filter((material) => {
                const initial = Number(material.initial_quantity || 0);
                return Number(material.current_quantity || 0) < 0 || (initial > 0 && Number(material.current_quantity || 0) / initial <= 0.25);
              });
              const pendingItems = project.pedidos.flatMap((pedido) => pedido.pedido_items || []).filter((item) => item.state === 'solicitado').length;
              const awaitingReceipt = project.pedidos.flatMap((pedido) => pedido.pedido_items || []).filter((item) => item.state === 'aprobado' || item.state === 'parcial').length;
              const percent = project.targetDepth && project.targetDepth > 0 ? Math.min(100, Math.round((project.currentDepth / project.targetDepth) * 100)) : 0;
              return (
                <article className="card well-dashboard-card" key={project.id}>
                  <div className="operation-row-main"><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><div className="well-icon"><svg viewBox="0 0 24 24"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/></svg></div><div><div className="card-title">{project.name}</div><div className="catalog-meta">{project.location || 'Sin ubicación'} · última actividad {formatDateTime(project.lastActivity)}</div></div></div><span className="badge badge-active">{percent}%</span></div>
                  <div className="well-progress"><span style={{ width: `${percent}%` }} /></div>
                  <div className="compact-metrics-grid well-metrics">
                    <div><strong>{project.currentDepth}{project.targetDepth ? <span className="well-metric-target"> / {project.targetDepth}</span> : ''}</strong><span>Profundidad m</span></div>
                    <div><strong>{project.bars}</strong><span>Barras</span></div>
                    <div><strong>{project.materials.length}</strong><span>Materiales</span></div>
                    <div><strong>{pedidosKnown ? project.pedidos.length : '—'}</strong><span>Pedidos</span></div>
                  </div>
                  <div className="flag-summary">
                    {turnosKnown && unresolvedShifts.length > 0 && <span className="badge badge-active">{unresolvedShifts.length} turno(s) abierto(s)</span>}
                    {turnosKnown && lateShifts.length > 0 && <span className="badge badge-danger">{lateShifts.length} autocierre/informe</span>}
                    {lowMaterials.length > 0 && <span className="badge badge-warning">{lowMaterials.length} material(es) bajo/anómalo</span>}
                    {pedidosKnown && pendingItems > 0 && <span className="badge badge-warning">{pendingItems} decisión(es)</span>}
                    {pedidosKnown && awaitingReceipt > 0 && <span className="badge badge-active">{awaitingReceipt} espera(n) recepción</span>}
                    {cierresKnown && project.completion && <span className={`badge ${project.completion.admin_signature ? 'badge-success' : 'badge-warning'}`}>{project.completion.admin_signature ? 'Ficha firmada' : project.completion.status === 'returned' ? 'Ficha devuelta' : 'Ficha por firmar'}</span>}
                    {(!pedidosKnown || !turnosKnown || !cierresKnown) && <span className="badge badge-warning">Datos incompletos</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">Actividad Reciente</div>
        {activity.length === 0 ? <p className="text-muted">{feedFailed ? 'No se pudo cargar la actividad reciente.' : 'Sin actividad reciente.'}</p> : activity.map((item, index) => (
          <div className="feed-row" key={`${item.kind}-${index}`} style={{ padding: '10px 0', borderBottom: index < activity.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <div className={`feed-icon ${item.kind}`}>
              <svg viewBox="0 0 24 24">
                {item.kind === 'pedido' ? <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18"/></> : item.kind === 'cierre' ? <path d="m5 13 4 4L19 7"/> : <path d="M12 2v20M5 9l7-7 7 7"/>}
              </svg>
            </div>
            <div className="feed-row-body">
              <div><div style={{ fontWeight: 600 }}>{item.title}</div><div className="text-muted" style={{ fontSize: 13 }}>{item.subtitle}</div></div>
              <div className="text-muted" style={{ fontSize: 12, flexShrink: 0 }}>{formatDateTime(item.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
