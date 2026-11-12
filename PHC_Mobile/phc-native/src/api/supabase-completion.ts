import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import supabase from '../lib/supabase';
import type { CompletionFinalFields, ProjectDossier } from '../types/productV2';
import { completionFinalFieldsToJson, projectDossierFromJson } from '../utils/productV2Json';

const REPORTS_BUCKET = 'phc-reports';

export const completionApi = {
  // Embeds project/well/operator names via PostgREST's FK-based embedded
  // resource syntax. The old getAll() only selected '*' on this table, which
  // has no name columns of its own (only project_id/operator_id) — there was
  // no way for the admin screen to show which project a report belonged to.
  async getAll(projectId?: number, options?: { page?: number; pageSize?: number }) {
    let query = supabase
      .from('completion_reports')
      .select('*, projects(name, well_name, location), profiles!completion_reports_operator_id_fkey(full_name, username)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (projectId) {
      query = query.eq('project_id', projectId);
    }
    if (options?.page && options?.pageSize) {
      const from = (options.page - 1) * options.pageSize;
      query = query.range(from, from + options.pageSize - 1);
    }
    const { data, error } = await query;
    if (error) throw error;
    return { data: data || [] };
  },

  // operator_id is intentionally not accepted — completion_reports.operator_id
  // now defaults to auth.uid() server-side (see migration
  // phc_owner_column_defaults). The old signature required it but the actual
  // caller (CompletionTab.tsx) never passed it, which would have violated the
  // NOT NULL constraint on every submission.
  // client_entry_id (see pedidosApi.create for the same reasoning): lets a
  // dropped-response retry from the offline outbox fetch the real row
  // instead of erroring or double-submitting.
  async create(data: {
    client_entry_id?: string;
    project_id: number;
    static_level?: number;
    dynamic_level?: number;
    flow_rate?: number;
    required_flow?: number;
    bucket_flow_rate?: number;
    flow_unit?: string;
    compressor_hours?: number;
    pump_hours?: number;
    water_quality?: string;
    perforated_meters?: number;
    installed_meters?: number;
    materials_summary?: string;
    completion_checklist?: string;
    completion_notes?: string;
    operator_signature?: string;
    client_signature?: string;
    pdf_url?: string;
  }) {
    const { data: result, error } = await supabase
      .from('completion_reports')
      .insert(data)
      .select()
      .single();
    if (error) {
      if (error.code === '23505' && data.client_entry_id) {
        const { data: existing, error: fetchError } = await supabase
          .from('completion_reports')
          .select('*')
          .eq('client_entry_id', data.client_entry_id)
          .single();
        if (fetchError) throw fetchError;
        return { data: existing };
      }
      throw error;
    }
    return { data: result };
  },

  async getPreview(projectId: number): Promise<ProjectDossier> {
    const { data, error } = await supabase.rpc('get_closing_ficha_preview', {
      p_project_id: projectId,
    });
    if (error) throw error;
    return projectDossierFromJson(data);
  },

  async submitV2(input: {
    projectId: number;
    clientEntryId: string;
    finalFields: CompletionFinalFields;
    operatorSignature: string;
    completionNotes?: string;
    pdfUrl?: string;
    enteredBy?: string | null;
  }) {
    const { data, error } = await supabase.rpc('submit_completion_v2', {
      p_project_id: input.projectId,
      p_client_entry_id: input.clientEntryId,
      p_final_fields: completionFinalFieldsToJson(input.finalFields),
      p_operator_signature: input.operatorSignature,
      p_completion_notes: input.completionNotes ?? null,
      p_pdf_url: input.pdfUrl ?? null,
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;
    return { data };
  },

  async resubmitV2(input: {
    reportId: number;
    clientEntryId: string;
    finalFields: CompletionFinalFields;
    operatorSignature: string;
    completionNotes?: string;
    pdfUrl?: string;
    enteredBy?: string | null;
  }) {
    const { data, error } = await supabase.rpc('resubmit_completion_v2', {
      p_report_id: input.reportId,
      p_client_entry_id: input.clientEntryId,
      p_final_fields: completionFinalFieldsToJson(input.finalFields),
      p_operator_signature: input.operatorSignature,
      p_completion_notes: input.completionNotes ?? null,
      p_pdf_url: input.pdfUrl ?? null,
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;
    return { data };
  },

  async reportDiscrepancy(input: {
    projectId: number;
    section: string;
    description: string;
    completionReportId?: number;
  }) {
    const { data, error } = await supabase.rpc('report_completion_discrepancy', {
      p_project_id: input.projectId,
      p_section: input.section,
      p_description: input.description,
      p_completion_report_id: input.completionReportId ?? null,
    });
    if (error) throw error;
    return data;
  },

  async resolveDiscrepancy(id: number, note: string) {
    const { data, error } = await supabase.rpc('resolve_completion_discrepancy', {
      p_discrepancy_id: id,
      p_resolution_note: note,
    });
    if (error) throw error;
    return data;
  },

  // Pass 4: atomic sign. Sets admin_signature + status='approved' AND moves
  // the project to 'completed' in one transaction (sign_completion_report RPC),
  // and blocks a double-sign. Replaces the old client-side update in adminSign
  // for the completion flow. Notification stays best-effort below.
  async signAndComplete(
    id: number,
    admin_signature: string,
    completeProject = true,
    acknowledgeOpenPedidos = false,
  ) {
    const { data, error } = await supabase.rpc('sign_completion_report', {
      p_report_id: id,
      p_admin_signature: admin_signature,
      p_complete_project: completeProject,
      p_acknowledge_open_pedidos: acknowledgeOpenPedidos,
    });
    if (error) throw error;
    // Best-effort notification, never blocks the signature.
    supabase.functions
      .invoke('notify-email', {
        body: { type: 'completion_signed', entity_id: id },
      })
      .catch((e) => console.warn('[notify-email] completion_signed failed:', e));
    return { data };
  },

  async adminSign(id: number, admin_signature: string) {
    return completionApi.signAndComplete(id, admin_signature, true);
  },

  // Admin-only (relies on the existing "Only admins can update completion
  // reports" RLS policy) — used to attach the re-generated, signed PDF after
  // adminSign().
  async updatePdfUrl(id: number, storagePath: string) {
    const { data: result, error } = await supabase.rpc('attach_completion_pdf', {
      p_report_id: id,
      p_storage_path: storagePath,
    });
    if (error) throw error;
    return { data: result };
  },

  // The `pdf_url` column actually stores a Storage *path*, not a public URL
  // (the bucket is private) — sign it on demand for viewing/sharing.
  async getPdfSignedUrl(storagePath: string, expiresInSeconds = 60 * 60) {
    const { data, error } = await supabase.storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw error;
    return data?.signedUrl;
  },

  // Uploads a locally-generated PDF (from src/utils/pdfGenerator.ts) to the
  // phc-reports bucket and returns the storage path to save as pdf_url.
  async uploadReportPdf(projectId: number, localUri: string, suffix: string, stableId?: string) {
    const safeId = (stableId || String(Date.now())).replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = `${projectId}/completion_${safeId}_${suffix}.pdf`;
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const { error } = await supabase.storage
      .from(REPORTS_BUCKET)
      .upload(path, decode(base64), { contentType: 'application/pdf', upsert: false });
    if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
    return path;
  },

  async registerAttachment(input: {
    projectId: number;
    kind: 'analisis_agua' | 'otro';
    storagePath: string;
    filename?: string;
    mimeType?: string;
    notes?: string;
    waterSampleId?: number;
  }) {
    const { data, error } = await supabase.rpc('register_project_attachment', {
      p_project_id: input.projectId,
      p_kind: input.kind,
      p_storage_path: input.storagePath,
      p_filename: input.filename ?? null,
      p_mime_type: input.mimeType ?? null,
      p_notes: input.notes ?? null,
      p_water_sample_id: input.waterSampleId ?? null,
    });
    if (error) throw error;
    return data;
  },

  async deleteAttachment(id: number, reason: string) {
    const { error } = await supabase.functions.invoke('admin-delete-project-attachment', {
      body: {
        attachment_id: id,
        reason,
      },
    });
    if (error) throw error;
  },
};
