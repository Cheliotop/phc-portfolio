import supabase from '../lib/supabase';
import type { Json } from '../types/supabase.generated';

export type RejectedWorkDecision = 'accepted' | 'rejected';

export const rejectedWorkApi = {
  /** A phone reports work the server refused. Repeating a report adds nothing. */
  async report(input: {
    clientEntryId: string;
    operatorId: string;
    entity: string;
    entityId: string | null;
    op: string | null;
    payload: Record<string, unknown>;
    rejectionReason: string | null;
    rejectedAt: string | null;
  }): Promise<number> {
    const { data, error } = await supabase.rpc('report_rejected_work', {
      p_client_entry_id: input.clientEntryId,
      p_operator_id: input.operatorId,
      p_entity: input.entity,
      p_entity_id: input.entityId ?? '',
      p_op: input.op ?? '',
      p_payload: input.payload as Json,
      p_rejection_reason: input.rejectionReason ?? undefined,
      p_rejected_at: input.rejectedAt ?? undefined,
    });
    if (error) throw error;
    return data as number;
  },

  /** The reporting phone saw this refused work reach the server after a retry. */
  async markSent(clientEntryId: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('mark_rejected_work_sent', {
      p_client_entry_id: clientEntryId,
    });
    if (error) throw error;
    return Boolean(data);
  },

  /** Oldest first, so the admin works through the list in the order it happened. */
  async listPending() {
    const { data, error } = await supabase
      .from('rejected_work_reports')
      .select(
        'id, entity, payload, rejection_reason, rejected_at, sent_later_at, created_at, operator_id, reported_by, project_id,'
        + ' operator:profiles!rejected_work_reports_operator_id_fkey(username, full_name),'
        + ' project:projects(name, well_name)',
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []) as unknown as any[];
  },

  async decide(reportId: number, decision: RejectedWorkDecision, note?: string) {
    const { data, error } = await supabase.rpc('decide_rejected_work', {
      p_report_id: reportId,
      p_decision: decision,
      p_note: note?.trim() || undefined,
    });
    if (error) throw error;
    return data;
  },
};
