import { supabase } from '../lib/supabase';

/**
 * Pass 4: server-derived admin dashboard truth. The old Resumen computed stats
 * from the local SQLite mirror, so a fresh install or a second admin device
 * showed 0/stale numbers until tabs were visited. These read straight from
 * Supabase (RLS lets admins see everything) using head+count queries, so
 * they're cheap and always current. Callers should fall back to a loading/
 * error state — never silently show zeros as if they were real.
 */

export interface AdminStats {
  activeProjects: number;
  pendingPedidos: number;
  projectsWithoutMaterials: number;
  unsignedCierres: number;
  activeOperators: number;
}

const countHead = async (
  table: string,
  build: (q: any) => any,
): Promise<number> => {
  const { count, error } = await build(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
};

export const adminStatsApi = {
  async getStats(): Promise<AdminStats> {
    const [activeProjects, pendingPedidos, unsignedCierres, activeOperators] = await Promise.all([
      // planning + active + closure_submitted count as ongoing
      countHead('projects', (q) => q.in('status', ['planning', 'active', 'closure_submitted'])),
      // A pedido waits on the admin while any of its items is still 'solicitado';
      // its status changes as soon as one item is decided (code read W6).
      (async () => {
        const { data, error } = await supabase.from('pedido_items').select('pedido_id').eq('state', 'solicitado');
        if (error) throw error;
        return new Set((data || []).map((row: { pedido_id: number }) => row.pedido_id)).size;
      })(),
      // submitted (or otherwise not yet approved) completion reports
      // Only a submitted Ficha can be signed; a returned one waits on the operator.
      countHead('completion_reports', (q) => q.eq('status', 'submitted')),
      countHead('profiles', (q) => q.eq('role', 'operator').eq('is_active', true)),
    ]);

    // Active projects with nothing assigned in project_materials yet — now that
    // materials are assigned per-project instead of tracked as shared warehouse
    // stock, this is the admin's checklist of projects still needing materials.
    // PostgREST can't express a NOT EXISTS join from the client, so diff the
    // two id sets locally (project counts here are small).
    let projectsWithoutMaterials = 0;
    try {
      const { data: activeRows, error: activeErr } = await supabase
        .from('projects')
        .select('id')
        .in('status', ['planning', 'active', 'closure_submitted']);
      if (activeErr) throw activeErr;
      const activeIds = (activeRows || []).map((p: any) => p.id);
      if (activeIds.length > 0) {
        const { data: assignedRows, error: assignedErr } = await supabase
          .from('project_materials')
          .select('project_id')
          .in('project_id', activeIds);
        if (assignedErr) throw assignedErr;
        const assignedIds = new Set((assignedRows || []).map((r: any) => r.project_id));
        projectsWithoutMaterials = activeIds.filter((id: number) => !assignedIds.has(id)).length;
      }
    } catch (e) {
      console.warn('[adminStats] projects-without-materials count failed:', e);
    }

    return { activeProjects, pendingPedidos, projectsWithoutMaterials, unsignedCierres, activeOperators };
  },
};
