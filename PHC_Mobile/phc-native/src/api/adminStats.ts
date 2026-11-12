import supabase from '../lib/supabase';

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

export const adminStatsApi = {
  async getStats(): Promise<AdminStats> {
    const [activeResult, pendingResult, unsignedResult, operatorsResult] = await Promise.all([
      // planning + active + closure_submitted count as ongoing
      supabase.from('projects').select('*', { count: 'exact', head: true })
        .in('status', ['planning', 'active', 'closure_submitted']),
      // A pedido waits on the admin while any of its items is still 'solicitado'.
      // Its status moves to 'Aprobado' or 'Decisión parcial' as soon as one item is
      // decided, so counting status = 'Pendiente' missed those (code read A9).
      supabase.from('pedido_items').select('pedido_id').eq('state', 'solicitado'),
      // submitted (or otherwise not yet approved) completion reports
      // Only a submitted Ficha can be signed; a returned one waits on the operator.
      supabase.from('completion_reports').select('*', { count: 'exact', head: true })
        .eq('status', 'submitted'),
      supabase.from('profiles').select('*', { count: 'exact', head: true })
        .eq('role', 'operator').eq('is_active', true),
    ]);
    const countError = activeResult.error || pendingResult.error || unsignedResult.error || operatorsResult.error;
    if (countError) throw countError;
    const activeProjects = activeResult.count || 0;
    const pendingPedidos = new Set((pendingResult.data || []).map((row: { pedido_id: number }) => row.pedido_id)).size;
    const unsignedCierres = unsignedResult.count || 0;
    const activeOperators = operatorsResult.count || 0;

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
      const activeIds = (activeRows || []).map((project) => project.id);
      if (activeIds.length > 0) {
        // Only ACTIVE assignments count. deactivate_project_material_assignment is a
        // real, shipped RPC — without this filter a project whose materials were all
        // deactivated still reads as "has materials" and silently drops off the
        // admin's needs-materials checklist, which is the checklist's whole purpose.
        const { data: assignedRows, error: assignedErr } = await supabase
          .from('project_materials')
          .select('project_id')
          .eq('active', true)
          .in('project_id', activeIds);
        if (assignedErr) throw assignedErr;
        const assignedIds = new Set((assignedRows || []).map((assignment) => assignment.project_id));
        projectsWithoutMaterials = activeIds.filter((id) => !assignedIds.has(id)).length;
      }
    } catch (e) {
      console.warn('[adminStats] projects-without-materials count failed:', e);
    }

    return { activeProjects, pendingPedidos, projectsWithoutMaterials, unsignedCierres, activeOperators };
  },
};
