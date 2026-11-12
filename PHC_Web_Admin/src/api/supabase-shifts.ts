import { supabase } from '../lib/supabase';
import type {
  HandoverInput,
  OperatorAccountabilityMetrics,
  OperatorDirectoryEntry,
  Shift,
  ShiftStatus,
  ShiftUsageInput,
} from '../types/productV2';
import { friendlyApiError } from './supabase-api-errors';
import { inBatches } from '../domain/paging.ts';
import { requireAuthenticatedUserId } from './supabase-operator-session';
import type { MetricsPeriod } from '../domain/metricsPeriod';

export interface ShiftFilters {
  projectId?: number;
  operatorId?: string;
  status?: ShiftStatus;
  limit?: number;
}

export interface ShiftPage {
  rows: Shift[];
  total: number;
}

const SHIFT_LIST_SELECT = 'id, client_entry_id, project_id, operator_id, status, started_at, ended_at, start_device_time, end_device_time, end_type, usage_report_submitted, handover_confirmed, device_time_flag, reassigned_during_shift, notes, projects(name, location), profiles!shifts_operator_id_fkey(username, full_name), shift_handovers(id, shift_id, project_material_id, status, expected_quantity, observed_quantity, note, photo_path, confirmed_by, created_at, project_materials(material_name, unit))';

const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

const loadOperatorMetrics = async (operatorId: string, period?: MetricsPeriod): Promise<OperatorAccountabilityMetrics> => {
  const { data, error } = await supabase.rpc('get_operator_accountability_metrics', {
    p_operator_id: operatorId,
    p_from: period?.from || null,
    p_to: period?.to || null,
  });
  if (error) throw friendlyApiError(error, 'No se pudieron cargar las métricas del operador.');
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
  async getShiftParticipants(shiftIds: string[]): Promise<Record<string, string[]>> {
    if (!shiftIds.length) return {};
    // "Cargar más" keeps growing the list, and the ids travel in the URL: read in batches.
    const replies = await Promise.all(inBatches(shiftIds).map((ids) => supabase.from('shift_participants')
      .select('shift_id, operator_id').in('shift_id', ids)));
    const failed = replies.find((reply) => reply.error);
    if (failed?.error) throw friendlyApiError(failed.error, 'No se pudieron cargar los integrantes de los turnos.');
    const grouped: Record<string, string[]> = {};
    for (const row of replies.flatMap((reply) => reply.data || [])) {
      grouped[row.shift_id] = [...(grouped[row.shift_id] || []), row.operator_id];
    }
    return grouped;
  },
  async getMine(options: { projectId?: number; unresolvedOnly?: boolean; limit?: number } = {}): Promise<Shift[]> {
    const operatorId = await requireAuthenticatedUserId();
    let query = supabase
      .from('shifts')
      .select('id, client_entry_id, project_id, operator_id, status, started_at, ended_at, start_device_time, end_device_time, end_type, usage_report_submitted, handover_confirmed, device_time_flag, notes, projects(name, location), shift_handovers(id, shift_id, project_material_id, status, expected_quantity, observed_quantity, note, photo_path, confirmed_by, created_at, project_materials(material_name, unit))')
      .eq('operator_id', operatorId)
      .order('started_at', { ascending: false })
      .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
    if (options.projectId) query = query.eq('project_id', options.projectId);
    if (options.unresolvedOnly) query = query.in('status', ['open', 'report_pending']);
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar tus turnos.');
    return (data || []) as unknown as Shift[];
  },

  async getMyMetrics(): Promise<OperatorAccountabilityMetrics> {
    const operatorId = await requireAuthenticatedUserId();
    return loadOperatorMetrics(operatorId);
  },

  async getAll(filters: ShiftFilters = {}): Promise<Shift[]> {
    return (await shiftsApi.getPage(filters)).rows;
  },

  /** The newest shifts plus the exact count of every shift the filters match (audit WEB-7). */
  async getPage(filters: ShiftFilters = {}): Promise<ShiftPage> {
    let query = supabase
      .from('shifts')
      .select(SHIFT_LIST_SELECT, { count: 'exact' })
      .order('started_at', { ascending: false })
      .limit(Math.min(Math.max(filters.limit ?? 150, 1), 500));
    if (filters.projectId) query = query.eq('project_id', filters.projectId);
    if (filters.operatorId) query = query.eq('operator_id', filters.operatorId);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error, count } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los turnos.');
    return { rows: (data || []) as Shift[], total: count ?? (data || []).length };
  },

  /**
   * Exact counts for the header badges, over every shift the filters match, not only
   * the rows on screen (audit WEB-7, WEB-17). A force-closed shift does not count as a
   * missing report: its report will never arrive.
   */
  async countFlags(filters: ShiftFilters = {}): Promise<{ autoClosed: number; reportMissing: number }> {
    const shiftCount = () => {
      let query = supabase.from('shifts').select('id', { count: 'exact', head: true });
      if (filters.projectId) query = query.eq('project_id', filters.projectId);
      if (filters.operatorId) query = query.eq('operator_id', filters.operatorId);
      if (filters.status) query = query.eq('status', filters.status);
      return query;
    };
    const autoQuery = shiftCount().eq('end_type', 'auto');
    const missingQuery = shiftCount()
      .neq('status', 'open')
      .eq('usage_report_submitted', false)
      .or('end_type.is.null,end_type.neq.admin');
    const [auto, missing] = await Promise.all([autoQuery, missingQuery]);
    if (auto.error) throw friendlyApiError(auto.error, 'No se pudieron contar los turnos.');
    if (missing.error) throw friendlyApiError(missing.error, 'No se pudieron contar los turnos.');
    return { autoClosed: auto.count ?? 0, reportMissing: missing.count ?? 0 };
  },

  async getOperatorDirectory(): Promise<OperatorDirectoryEntry[]> {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, is_active')
      .eq('role', 'operator')
      .order('username', { ascending: true });
    if (error) throw friendlyApiError(error, 'No se pudieron cargar los operadores.');
    return (data || []) as OperatorDirectoryEntry[];
  },

  /**
   * One request per operator (the server computes them one at a time). A failed
   * operator is returned in `failed` rather than dropped silently (audit WEB-18); only
   * a total failure throws.
   */
  async getAllOperatorMetrics(operators: OperatorDirectoryEntry[], period?: MetricsPeriod): Promise<{
    metrics: OperatorAccountabilityMetrics[];
    failed: OperatorDirectoryEntry[];
  }> {
    const settled = await Promise.allSettled(operators.map(async (operator) => ({
      ...(await loadOperatorMetrics(operator.id, period)),
      operator,
    })));
    const metrics = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failed = settled.flatMap((result, index) => (result.status === 'rejected' ? [operators[index]] : []));
    const firstFailure = settled.find((result) => result.status === 'rejected');
    if (metrics.length === 0 && firstFailure) throw (firstFailure as PromiseRejectedResult).reason;
    return { metrics, failed };
  },

  async start(input: {
    projectId: number;
    shiftId: string;
    clientEntryId: string;
    startedAt?: string;
    deviceStartedAt?: string;
  }): Promise<Shift> {
    const { data, error } = await supabase.rpc('start_shift', {
      p_project_id: input.projectId,
      p_shift_id: input.shiftId,
      p_client_entry_id: input.clientEntryId,
      p_started_at: input.startedAt ?? null,
      p_device_started_at: input.deviceStartedAt ?? null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo iniciar el turno.');
    return data as Shift;
  },

  /** endedAtIso is the real end the admin states (decided 2026-11-09); null means "now" on the server. */
  async forceClose(shiftId: string, reason: string, endedAtIso: string | null = null): Promise<Shift> {
    const { data, error } = await supabase.rpc('force_close_shift', {
      p_shift_id: shiftId,
      p_reason: reason,
      p_ended_at: endedAtIso,
    });
    if (error) throw friendlyApiError(error, 'No se pudo cerrar el turno.');
    return data as Shift;
  },

  async confirmHandover(shiftId: string, items: HandoverInput[]): Promise<Shift> {
    const { data, error } = await supabase.rpc('confirm_shift_handover', {
      p_shift_id: shiftId,
      p_items: items,
    });
    if (error) throw friendlyApiError(error, 'No se pudo confirmar la entrega del turno.');
    return data as Shift;
  },

  async end(input: {
    shiftId: string;
    usage: ShiftUsageInput[];
    notes?: string;
    deviceEndedAt?: string;
    endType?: 'manual' | 'auto';
  }): Promise<Shift> {
    const { data, error } = await supabase.rpc('end_shift', {
      p_shift_id: input.shiftId,
      p_usage: input.usage,
      p_notes: input.notes?.trim() || null,
      p_device_ended_at: input.deviceEndedAt ?? null,
      p_end_type: input.endType ?? 'manual',
    });
    if (error) throw friendlyApiError(error, 'No se pudo finalizar el turno.');
    return data as Shift;
  },
};
