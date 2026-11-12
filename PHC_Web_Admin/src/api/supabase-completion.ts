import { supabase } from '../lib/supabase';
import type {
  CompletionDiscrepancy,
  CompletionReport,
  ProjectDossier,
} from '../types/completionReview';
import type {
  CompletionDiscrepancy as OperatorCompletionDiscrepancy,
  OperatorCompletionReport,
  OperatorFichaPreview,
  ResubmitCompletionV2Input,
  SubmitCompletionV2Input,
} from '../types/operatorConsole';
import { friendlyApiError } from './supabase-api-errors';
import { requireAuthenticatedUserId } from './supabase-operator-session';

const REPORTS_BUCKET = 'phc-reports';
const PHOTOS_BUCKET = 'phc-photos';

const normalizeDossier = (value: unknown): ProjectDossier => {
  const dossier = (value || {}) as Partial<ProjectDossier>;
  return {
    project: dossier.project || null,
    bars: Array.isArray(dossier.bars) ? dossier.bars : [],
    shifts: Array.isArray(dossier.shifts) ? dossier.shifts : [],
    shift_handovers: Array.isArray(dossier.shift_handovers) ? dossier.shift_handovers : [],
    photos: Array.isArray(dossier.photos) ? dossier.photos : [],
    materials: Array.isArray(dossier.materials) ? dossier.materials : [],
    consumption: Array.isArray(dossier.consumption) ? dossier.consumption : [],
    samples: Array.isArray(dossier.samples) ? dossier.samples : [],
    company_pedidos: Array.isArray(dossier.company_pedidos) ? dossier.company_pedidos : [],
    corrections: Array.isArray(dossier.corrections) ? dossier.corrections : [],
    discrepancies: Array.isArray(dossier.discrepancies) ? dossier.discrepancies : [],
    completion: dossier.completion || null,
    attachments: Array.isArray(dossier.attachments) ? dossier.attachments : [],
    reconciliations: Array.isArray(dossier.reconciliations) ? dossier.reconciliations : [],
    audit: Array.isArray(dossier.audit) ? dossier.audit : [],
  };
};

const normalizeOperatorPreview = (value: unknown): OperatorFichaPreview => {
  const preview = (value || {}) as Partial<OperatorFichaPreview>;
  return {
    project: preview.project || null,
    bars: Array.isArray(preview.bars) ? preview.bars : [],
    shifts: Array.isArray(preview.shifts) ? preview.shifts : [],
    shift_handovers: Array.isArray(preview.shift_handovers) ? preview.shift_handovers : [],
    photos: Array.isArray(preview.photos) ? preview.photos : [],
    materials: Array.isArray(preview.materials) ? preview.materials : [],
    consumption: Array.isArray(preview.consumption) ? preview.consumption : [],
    samples: Array.isArray(preview.samples) ? preview.samples : [],
    company_pedidos: Array.isArray(preview.company_pedidos) ? preview.company_pedidos : [],
    corrections: Array.isArray(preview.corrections) ? preview.corrections : [],
    discrepancies: Array.isArray(preview.discrepancies) ? preview.discrepancies : [],
    completion: preview.completion || null,
  };
};

export const completionApi = {
  async getMine(projectId?: number): Promise<{ data: OperatorCompletionReport[] }> {
    const operatorId = await requireAuthenticatedUserId();
    let query = supabase
      .from('completion_reports')
      .select('*')
      .eq('operator_id', operatorId)
      .order('created_at', { ascending: false });
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar tus Fichas de cierre.');
    return { data: (data || []) as unknown as OperatorCompletionReport[] };
  },

  async getOperatorPreview(projectId: number): Promise<OperatorFichaPreview> {
    const { data, error } = await supabase.rpc('get_closing_ficha_preview', {
      p_project_id: projectId,
    });
    if (error) throw friendlyApiError(error, 'No se pudo compilar la vista previa de la Ficha.');
    return normalizeOperatorPreview(data);
  },

  async reportDiscrepancy(input: {
    projectId: number;
    section: string;
    description: string;
    completionReportId?: number;
  }): Promise<OperatorCompletionDiscrepancy> {
    const section = input.section.trim();
    const description = input.description.trim();
    if (!section) throw new Error('Indicá la sección de la discrepancia.');
    if (description.length < 3) throw new Error('Describí la discrepancia con al menos 3 caracteres.');
    const { data, error } = await supabase.rpc('report_completion_discrepancy', {
      p_project_id: input.projectId,
      p_section: section,
      p_description: description,
      p_completion_report_id: input.completionReportId ?? null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo informar la discrepancia.');
    return data as OperatorCompletionDiscrepancy;
  },

  async submitV2(input: SubmitCompletionV2Input): Promise<OperatorCompletionReport> {
    const signature = input.operatorSignature.trim();
    if (signature.length < 2) throw new Error('La firma del operador es obligatoria.');
    const { data, error } = await supabase.rpc('submit_completion_v2', {
      p_project_id: input.projectId,
      p_client_entry_id: input.clientEntryId,
      p_final_fields: input.finalFields,
      p_operator_signature: signature,
      p_completion_notes: input.completionNotes?.trim() || null,
      p_pdf_url: input.pdfUrl?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo enviar la Ficha de cierre.');
    return data as OperatorCompletionReport;
  },

  async resubmitV2(input: ResubmitCompletionV2Input): Promise<OperatorCompletionReport> {
    const signature = input.operatorSignature.trim();
    if (signature.length < 2) throw new Error('La firma del operador es obligatoria.');
    const { data, error } = await supabase.rpc('resubmit_completion_v2', {
      p_report_id: input.reportId,
      p_client_entry_id: input.clientEntryId,
      p_final_fields: input.finalFields,
      p_operator_signature: signature,
      p_completion_notes: input.completionNotes?.trim() || null,
      p_pdf_url: input.pdfUrl?.trim() || null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo reenviar la Ficha corregida.');
    return data as OperatorCompletionReport;
  },

  async getAll(projectId?: number): Promise<{ data: CompletionReport[] }> {
    let query = supabase
      .from('completion_reports')
      .select('*, projects(name, well_name, location), profiles!completion_reports_operator_id_fkey(full_name, username)')
      .order('created_at', { ascending: false });
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudieron cargar las Fichas de cierre.');
    return { data: (data || []) as unknown as CompletionReport[] };
  },

  async getDossier(projectId: number): Promise<ProjectDossier> {
    const { data, error } = await supabase.rpc('get_admin_project_dossier', {
      p_project_id: projectId,
    });
    if (error) throw friendlyApiError(error, 'No se pudo compilar el dossier del proyecto.');
    return normalizeDossier(data);
  },

  async resolveDiscrepancy(id: number, resolutionNote: string): Promise<CompletionDiscrepancy> {
    const note = resolutionNote.trim();
    if (note.length < 3) throw new Error('Escribí una nota de resolución de al menos 3 caracteres.');
    const { data, error } = await supabase.rpc('resolve_completion_discrepancy', {
      p_discrepancy_id: id,
      p_resolution_note: note,
    });
    if (error) throw friendlyApiError(error, 'No se pudo resolver la discrepancia.');
    return data as CompletionDiscrepancy;
  },

  async returnForRevision(id: number, reason: string): Promise<CompletionReport> {
    const safeReason = reason.trim();
    if (safeReason.length < 3) throw new Error('Escribí un motivo de devolución de al menos 3 caracteres.');
    const { data, error } = await supabase.rpc('return_completion_v2', {
      p_report_id: id,
      p_reason: safeReason,
    });
    if (error) throw friendlyApiError(error, 'No se pudo devolver la Ficha al operador.');
    return data as CompletionReport;
  },

  // Atomic server-side operation: signs the Ficha and, when requested, moves
  // the project to the canonical completed status in the same transaction.
  async signAndComplete(
    id: number,
    adminSignature: string,
    completeProject = true,
    acknowledgeOpenPedidos = false,
  ): Promise<CompletionReport> {
    const signature = adminSignature.trim();
    if (signature.length < 2) throw new Error('La firma administrativa es obligatoria.');
    const { data, error } = await supabase.rpc('sign_completion_report', {
      p_report_id: id,
      p_admin_signature: signature,
      p_complete_project: completeProject,
      p_acknowledge_open_pedidos: acknowledgeOpenPedidos,
    });
    if (error) throw friendlyApiError(error, 'No se pudo firmar la Ficha.');

    // This notification is intentionally best-effort. Authorization,
    // recipient selection and message content are derived server-side.
    void supabase.functions
      .invoke('notify-email', {
        body: { type: 'completion_signed', entity_id: id },
      })
      .then(({ error: notifyError }) => {
        if (notifyError) console.warn('[notify-email] completion_signed failed:', notifyError);
      })
      .catch((notifyError) => console.warn('[notify-email] completion_signed failed:', notifyError));

    return data as CompletionReport;
  },

  // Both generated completion PDFs and admin attachments are private objects.
  // Create short-lived signed links only when the admin explicitly opens one.
  async getStoredFileSignedUrl(storagePath: string, expiresInSeconds = 60 * 60): Promise<string> {
    const { data, error } = await supabase.storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw friendlyApiError(error, 'No se pudo generar el enlace privado.');
    if (!data?.signedUrl) throw new Error('Supabase no devolvió un enlace para el archivo.');
    return data.signedUrl;
  },

  async getPhotoSignedUrl(storagePath: string, expiresInSeconds = 60 * 60): Promise<string> {
    const { data, error } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw friendlyApiError(error, 'No se pudo generar el enlace privado de la foto.');
    if (!data?.signedUrl) throw new Error('Supabase no devolvió un enlace para la foto.');
    return data.signedUrl;
  },

};
