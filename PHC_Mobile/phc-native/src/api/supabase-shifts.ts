import supabase from '../lib/supabase';
import type {
  HandoverInput,
  OperatorAccountabilityMetrics,
  OperatorDirectoryEntry,
  Shift,
  ShiftStatus,
  ShiftUsageInput,
} from '../types/productV2';

export interface ShiftFilters {
  projectId?: number;
  operatorId?: string;
  status?: ShiftStatus;
  limit?: number;
}

const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

const loadOperatorMetrics = async (operatorId: string): Promise<OperatorAccountabilityMetrics> => {
  const { data, error } = await supabase.rpc('get_operator_accountability_metrics', {
    p_operator_id: operatorId,
  });
  if (error) throw error;
  const raw = data as Partial<OperatorAccountabilityMetrics>;
  return {
    operator_id: operatorId,
    current_project: raw.current_project ?? null,
    current_shift: raw.current_shift ?? null,
    shifts_completed: numberValue(raw.shifts_completed),
    hours_worked: numberValue(raw.hours_worked),
    bars_registered: numberValue(raw.bars_registered),
    average_bar_minutes: numberValue(raw.average_bar_minutes),
    material_reports_submitted: numberValue(raw.material_reports_submitted),
    missing_or_late_reports: numberValue(raw.missing_or_late_reports),
    flagged_shifts: numberValue(raw.flagged_shifts),
    active_pedidos: numberValue(raw.active_pedidos),
    last_activity: raw.last_activity ?? null,
    account_active: raw.account_active === true,
  };
};

export const shiftsApi = {
  async getMine(options: { projectId?: number; operatorId?: string; unresolvedOnly?: boolean } = {}) {
    let query = supabase
      .from('shifts')
      .select('*, projects(name, location)')
      .order('started_at', { ascending: false });
    if (options.projectId) {
      query = query.eq('project_id', options.projectId);
    }
    if (options.operatorId) {
      query = query.eq('operator_id', options.operatorId);
    }
    if (options.unresolvedOnly) {
      query = query.in('status', ['open', 'report_pending']);
    }
    const { data, error } = await query;
    if (error) throw error;
    return (data || []) as Array<Shift & { projects?: { name?: string; location?: string } }>;
  },

  async getAll(filters: ShiftFilters = {}): Promise<Shift[]> {
    let query = supabase
      .from('shifts')
      .select('id, client_entry_id, project_id, operator_id, status, started_at, ended_at, start_device_time, end_device_time, end_type, usage_report_submitted, handover_confirmed, device_time_flag, reassigned_during_shift, notes, projects(name, location), profiles!shifts_operator_id_fkey(username, full_name), shift_handovers(id, shift_id, project_material_id, status, expected_quantity, observed_quantity, note, photo_path, confirmed_by, created_at, project_materials(material_name, unit))')
      .order('started_at', { ascending: false })
      .limit(Math.min(Math.max(filters.limit ?? 150, 1), 500));
    if (filters.projectId) query = query.eq('project_id', filters.projectId);
    if (filters.operatorId) query = query.eq('operator_id', filters.operatorId);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []) as unknown as Shift[];
  },

  async getOperatorDirectory(): Promise<OperatorDirectoryEntry[]> {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, is_active')
      .eq('role', 'operator')
      .order('username', { ascending: true });
    if (error) throw error;
    return (data || []) as OperatorDirectoryEntry[];
  },

  async getById(shiftId: string): Promise<Shift | null> {
    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .eq('id', shiftId)
      .maybeSingle();
    if (error) throw error;
    return data as Shift | null;
  },

  async start(input: {
    projectId: number;
    shiftId: string;
    clientEntryId: string;
    startedAt?: string;
    deviceStartedAt?: string;
    enteredBy?: string | null;
  }): Promise<Shift> {
    const { data, error } = await supabase.rpc('start_shift', {
      p_project_id: input.projectId,
      p_shift_id: input.shiftId,
      p_client_entry_id: input.clientEntryId,
      p_started_at: input.startedAt ?? null,
      p_device_started_at: input.deviceStartedAt ?? null,
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;
    return data as Shift;
  },

  /** Which of these shifts the server has closed. Access rules limit it to the caller's own. */
  async getClosedAmong(ids: string[]) {
    const { data, error } = await supabase
      .from('shifts')
      .select('id, ended_at, end_type, usage_report_submitted, device_time_flag, notes')
      .in('id', ids)
      .eq('status', 'closed');
    if (error) throw error;
    return (data || []) as Array<Pick<Shift, 'id' | 'ended_at' | 'end_type' | 'usage_report_submitted' | 'device_time_flag' | 'notes'>>;
  },

  async forceClose(shiftId: string, reason: string): Promise<Shift> {
    const { data, error } = await supabase.rpc('force_close_shift', {
      p_shift_id: shiftId,
      p_reason: reason,
    });
    if (error) throw error;
    return data as Shift;
  },

  async confirmHandover(shiftId: string, items: HandoverInput[], enteredBy?: string | null): Promise<Shift> {
    const payload = items.map((item) => ({
      client_entry_id: item.client_entry_id,
      project_material_id: item.project_material_id,
      status: item.status,
      expected_quantity: item.expected_quantity,
      observed_quantity: item.observed_quantity,
      note: item.note,
      photo_path: item.photo_path,
    }));
    const { data, error } = await supabase.rpc('confirm_shift_handover', {
      p_shift_id: shiftId,
      p_items: payload,
      ...(enteredBy ? { p_entered_by: enteredBy } : {}),
    });
    if (error) throw error;
    return data as Shift;
  },

  async end(input: {
    shiftId: string;
    usage: ShiftUsageInput[];
    notes?: string;
    deviceEndedAt?: string;
    endType?: 'manual' | 'auto';
    enteredBy?: string | null;
  }): Promise<Shift> {
    const usage = input.usage.map((item) => ({
      client_entry_id: item.client_entry_id,
      project_material_id: item.project_material_id,
      quantity_used: item.quantity_used,
      approximate: item.approximate,
      notes: item.notes,
      date: item.date,
    }));
    const { data, error } = await supabase.rpc('end_shift', {
      p_shift_id: input.shiftId,
      p_usage: usage,
      p_notes: input.notes ?? null,
      p_device_ended_at: input.deviceEndedAt ?? null,
      p_end_type: input.endType ?? 'manual',
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;
    return data as Shift;
  },

  async join(shiftId: string, enteredBy?: string | null): Promise<Shift> {
    const { data, error } = await supabase.rpc('join_shift' as any, {
      p_shift_id: shiftId,
      ...(enteredBy ? { p_entered_by: enteredBy } : {}),
    });
    if (error) throw error;
    return data as Shift;
  },

  async getOperatorMetrics(operatorId: string): Promise<OperatorAccountabilityMetrics> {
    return loadOperatorMetrics(operatorId);
  },

  async getAllOperatorMetrics(operators: OperatorDirectoryEntry[]): Promise<OperatorAccountabilityMetrics[]> {
    return Promise.all(operators.map(async (operator) => ({
      ...(await loadOperatorMetrics(operator.id)),
      operator,
    })));
  },
};
