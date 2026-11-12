import supabase from '../lib/supabase';

interface OperatorListOptions {
  page?: number;
  pageSize?: number;
}

const applyRange = (query: any, options?: OperatorListOptions) => {
  if (!options?.page || !options?.pageSize) return query;
  const from = (options.page - 1) * options.pageSize;
  return query.range(from, from + options.pageSize - 1);
};

export const operatorsApi = {
  async getAll(options?: OperatorListOptions) {
    const { data, error } = await applyRange(supabase
      .from('profiles')
      .select('*')
      .order('username'), options);
    if (error) throw error;
    return data || [];
  },

  async getActive(options?: OperatorListOptions) {
    const { data, error } = await applyRange(supabase
      .from('profiles')
      .select('*')
      .eq('role', 'operator')
      .eq('is_active', true)
      .order('username'), options);
    if (error) throw error;
    return data || [];
  },

  async getAllActivePages(pageSize = 50) {
    const rows: any[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await operatorsApi.getActive({ page, pageSize });
      rows.push(...batch);
      if (batch.length < pageSize) return rows;
    }
  },

  async getByUsername(username: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'operator')
      .eq('username', username)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // Counts, per operator id, how many wells that operator is actually on.
  //
  // Counts BOTH kinds of assignment. Reading only `assigned_operator_id` made
  // the Operadores tab report "Proyectos asignados: 0" for a subcontractor who
  // was correctly assigned and could see the well, which reads as a broken
  // assignment and invites an admin to assign them a second time.
  //
  // A well is counted once per operator even if somebody manages to record
  // them both ways: the number answers "how many wells is this person on",
  // and two is a wrong answer to that question.
  async getAssignedProjectCounts(operatorIds: string[]): Promise<Record<string, number>> {
    if (!operatorIds.length) return {};

    const [primary, secondary] = await Promise.all([
      supabase
        .from('projects')
        .select('id, assigned_operator_id')
        .in('assigned_operator_id', operatorIds),
      supabase
        .from('project_secondary_operators')
        .select('project_id, operator_id')
        .in('operator_id', operatorIds),
    ]);
    if (primary.error) throw primary.error;
    if (secondary.error) throw secondary.error;

    const wellsByOperator: Record<string, Set<string>> = {};
    const add = (operatorId: unknown, projectId: unknown) => {
      const key = String(operatorId);
      if (!wellsByOperator[key]) wellsByOperator[key] = new Set();
      wellsByOperator[key].add(String(projectId));
    };

    for (const row of primary.data || []) {
      add((row as any).assigned_operator_id, (row as any).id);
    }
    for (const row of secondary.data || []) {
      add((row as any).operator_id, (row as any).project_id);
    }

    const counts: Record<string, number> = {};
    for (const [operatorId, wells] of Object.entries(wellsByOperator)) {
      counts[operatorId] = wells.size;
    }
    return counts;
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Remove an operator who has no history at all — a typo, or a duplicate.
   *
   * The server refuses for anyone who has ever worked, because
   * `audit_log.actor_id` is ON DELETE SET NULL: a plain delete would not fail,
   * it would quietly anonymise that operator's entries in an append-only log
   * whose whole value is saying who did what. The refusal comes back as a
   * Spanish sentence naming what to do instead, so it is shown as-is.
   */
  async deleteUnusedOperator(id: string) {
    const { data, error } = await supabase.rpc('delete_unused_operator', {
      p_operator_id: id,
    });
    if (error) throw error;
    return data as { deleted: boolean; username: string };
  },

  // Pass 1.5: real server-side activate/deactivate. Allowed only for admins
  // ("Admins can update any profile" RLS policy); the DB trigger
  // protect_profiles_privileged blocks everyone else (and blocks admins from
  // changing their OWN activation). Deactivated users are rejected at login.
  async setActive(id: string, isActive: boolean) {
    const { data, error } = await supabase
      .from('profiles')
      .update({ is_active: isActive })
      .eq('id', id)
      .select('id, username, full_name, role, is_active')
      .single();
    if (error) throw error;
    return data;
  },
};
