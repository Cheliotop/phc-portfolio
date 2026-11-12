import supabase from '../lib/supabase';

export const drillingBarsApi = {
  // Per-project: bar_number order (the depth chain, e.g. ProgresoTab).
  // Without a project it's the admin dashboard's recent-activity source, so
  // newest-first and capped — the old unconditional bar_number ordering made
  // the feed show the OLDEST bars across all wells once more than one
  // project had data.
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
   * The deepest bar of each of these wells, from one paged request. The admin's phone
   * records no bars itself, so its local tables showed every well at 0 m next to the
   * server's percentage (code read A6).
   */
  async getMaxDepths(projectIds: Array<number | string>): Promise<Map<string, number>> {
    const depths = new Map<string, number>();
    if (projectIds.length === 0) return depths;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('drilling_bars')
        .select('project_id, depth_end')
        .in('project_id', projectIds.map(Number))
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      for (const row of (data || []) as Array<{ project_id: number; depth_end: number | null }>) {
        const key = String(row.project_id);
        depths.set(key, Math.max(depths.get(key) ?? 0, Number(row.depth_end || 0)));
      }
      if (!data || data.length < 1000) return depths;
    }
  },

  async getNext(projectId: number) {
    const { data, error } = await supabase
      .from('drilling_bars')
      .select('bar_number')
      .eq('project_id', projectId)
      .order('bar_number', { ascending: false })
      .limit(1);
    if (error) throw error;
    const nextNumber = (data && data.length > 0 ? data[0].bar_number : 0) + 1;
    return { data: { bar_number: nextNumber } };
  },

  // NOTE: bar_number/depth_start/depth_end are intentionally NOT accepted here.
  // They used to be computed on-device and inserted directly, which raced under
  // concurrent/offline-replayed writes and could silently corrupt the depth
  // chain (see PHC_SUPABASE_MIGRATION_PLAN_2026-07-08.md §2.1). The
  // `create_drilling_bar` RPC now computes both atomically, server-side, inside
  // a locked transaction, and is idempotent on `client_entry_id`. Always trust
  // the row it returns over whatever the phone guessed locally.
  async create(data: {
    client_entry_id?: string;
    project_id: number;
    soil_type: string;
    length?: number;
    diameter?: string;
    start_time?: string;
    end_time?: string;
    duration_minutes?: number;
    water_level?: number;
    notes?: string;
    photo_paths?: string;
    timestamp_local?: string;
    shift_id?: string;
  }, enteredBy?: string | null) {
    const { data: result, error } = await supabase.rpc('create_drilling_bar', {
      p_project_id: data.project_id,
      p_soil_type: data.soil_type,
      p_client_entry_id: data.client_entry_id ?? null,
      p_length: data.length ?? null,
      p_diameter: data.diameter ?? null,
      p_start_time: data.start_time ?? null,
      p_end_time: data.end_time ?? null,
      p_duration_minutes: data.duration_minutes ?? null,
      p_water_level: data.water_level ?? null,
      p_notes: data.notes ?? null,
      ...(enteredBy ? { p_entered_by: enteredBy } : {}),
      p_photo_paths: data.photo_paths ?? null,
      p_timestamp_local: data.timestamp_local ?? null,
      p_shift_id: data.shift_id ?? null,
    });
    if (error) throw error;
    // The RPC returns the canonical row whether this was a fresh insert or a
    // replayed client_entry_id — never build the returned object from the
    // client's guess.
    return {
      data: {
        id: result.id,
        bar_number: result.bar_number,
        depth_start: result.depth_start,
        depth_end: result.depth_end,
        length: result.length,
      },
    };
  },
};
