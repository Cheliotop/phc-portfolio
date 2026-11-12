import { supabase } from '../lib/supabase';
import { friendlyApiError } from './supabase-api-errors';

export type RejectedWorkDecision = 'accepted' | 'rejected';

export interface RejectedWorkReport {
  id: number;
  entity: string;
  payload: Record<string, unknown> | null;
  rejection_reason: string | null;
  sent_later_at?: string | null;
  rejected_at: string | null;
  created_at: string;
  operator_id: string;
  reported_by: string;
  project_id: number | null;
  operator: { username: string | null; full_name: string | null } | null;
  reporter: { username: string | null; full_name: string | null } | null;
  project: { name: string | null; well_name: string | null } | null;
}

export const rejectedWorkApi = {
  /** Oldest first, so the admin works through the list in the order it happened. */
  async listPending(): Promise<RejectedWorkReport[]> {
    const { data, error } = await supabase
      .from('rejected_work_reports')
      .select(`
        id, entity, payload, rejection_reason, rejected_at, sent_later_at, created_at,
        operator_id, reported_by, project_id,
        operator:profiles!rejected_work_reports_operator_id_fkey(username, full_name),
        reporter:profiles!rejected_work_reports_reported_by_fkey(username, full_name),
        project:projects(name, well_name)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw friendlyApiError(error, 'No se pudo cargar la lista de revisión.');
    return (data || []) as unknown as RejectedWorkReport[];
  },

  async decide(reportId: number, decision: RejectedWorkDecision, note?: string): Promise<void> {
    const { error } = await supabase.rpc('decide_rejected_work', {
      p_report_id: reportId,
      p_decision: decision,
      p_note: note?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo guardar la decisión.');
  },
};
