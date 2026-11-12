import { supabase } from '../lib/supabase';
import type { CreateDrillingBarInput, DrillingBar } from '../types/operatorConsole';
import { friendlyApiError } from './supabase-api-errors';
import { requireAuthenticatedUserId } from './supabase-operator-session';

export const drillingBarsApi = {
  async getMine(projectId: number): Promise<{ data: DrillingBar[] }> {
    // Crew handoff: the depth chain belongs to the WHOLE well, not just this
    // operator's bars -- an incoming operator must see the well's true current
    // depth to keep drilling safely. Visibility is governed by RLS (own +
    // current project operator + closing operator + admin), not a client filter.
    await requireAuthenticatedUserId();
    const { data, error } = await supabase
      .from('drilling_bars')
      .select('*, projects(name)')
      .eq('project_id', projectId)
      .order('bar_number', { ascending: true });
    if (error) throw friendlyApiError(error, 'No se pudieron cargar las barras del pozo.');
    return { data: (data || []) as unknown as DrillingBar[] };
  },

  // Per-project: bar_number order (the depth chain). Without a project it's
  // the dashboard's recent-activity source, so newest-first and capped —
  // the old unconditional bar_number ordering made the feed show the OLDEST
  // bars across all wells once more than one project had data.
  async getAll(projectId?: number) {
    let query = supabase.from('drilling_bars').select('*, projects(name)');
    if (projectId) {
      query = query.eq('project_id', projectId).order('bar_number', { ascending: true });
    } else {
      query = query.order('created_at', { ascending: false }).limit(15);
    }
    const { data, error } = await query;
    if (error) throw error;
    return { data: data || [] };
  },

  /**
   * Depth and time of every bar on these wells, in one paged request instead of one
   * per well (code read W5). Paged because PostgREST returns at most 1,000 rows.
   */
  async getForProjects(projectIds: number[]): Promise<Array<{ project_id: number; depth_end: number | null; created_at: string }>> {
    if (projectIds.length === 0) return [];
    const rows: Array<{ project_id: number; depth_end: number | null; created_at: string }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('drilling_bars')
        .select('project_id, depth_end, created_at')
        .in('project_id', projectIds)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      rows.push(...((data || []) as typeof rows));
      if (!data || data.length < 1000) return rows;
    }
  },

  // NOTE: bar_number/depth_start/depth_end are intentionally NOT accepted here.
  // They used to be computed on-device and inserted directly, which raced under
  // concurrent/offline-replayed writes and could silently corrupt the depth
  // chain (see PHC_SUPABASE_MIGRATION_PLAN_2026-07-08.md §2.1). The
  // `create_drilling_bar` RPC now computes both atomically, server-side, inside
  // a locked transaction, and is idempotent on `client_entry_id`. Always trust
  // the row it returns over whatever the phone guessed locally.
  async create(data: CreateDrillingBarInput): Promise<{ data: DrillingBar }> {
    const { data: result, error } = await supabase.rpc('create_drilling_bar', {
      p_project_id: data.project_id,
      p_soil_type: data.soil_type,
      p_client_entry_id: data.client_entry_id,
      p_length: data.length ?? null,
      p_diameter: data.diameter ?? null,
      p_start_time: data.start_time ?? null,
      p_end_time: data.end_time ?? null,
      p_duration_minutes: data.duration_minutes ?? null,
      p_water_level: data.water_level ?? null,
      p_notes: data.notes ?? null,
      p_photo_paths: data.photo_paths ?? null,
      p_timestamp_local: data.timestamp_local ?? null,
      p_shift_id: data.shift_id,
    });
    if (error) throw friendlyApiError(error, 'No se pudo registrar la barra de perforación.');
    // The RPC returns the canonical row whether this was a fresh insert or a
    // replayed client_entry_id — never build the returned object from the
    // client's guess.
    return { data: result as DrillingBar };
  },
};
