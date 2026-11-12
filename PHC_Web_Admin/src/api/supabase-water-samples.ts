import { supabase } from '../lib/supabase';
import type { RegisterWaterSampleInput, WaterSample } from '../types/operatorConsole';
import { friendlyApiError } from './supabase-api-errors';
import { operatorProjectsApi } from './supabase-operator-projects';

export const waterSamplesApi = {
  async getHistory(projectId: number): Promise<WaterSample[]> {
    // Explicitly enforce assignment even when an administrator happens to be
    // signed in; the operator facade should behave like the shipping role.
    await operatorProjectsApi.getById(projectId);
    const { data, error } = await supabase
      .from('water_samples')
      .select('id, client_entry_id, project_id, sample_number, depth_m, stage, operator_id, notes, bottle_photo_path, taken_at, timestamp_local, device_time_flag, created_at, projects(name), profiles!water_samples_operator_id_fkey(username, full_name)')
      .eq('project_id', projectId)
      .order('sample_number', { ascending: false });
    if (error) throw friendlyApiError(error, 'No se pudo cargar el historial de muestras.');
    return (data || []) as unknown as WaterSample[];
  },

  async register(input: RegisterWaterSampleInput): Promise<WaterSample> {
    await operatorProjectsApi.getById(input.projectId);
    const { data, error } = await supabase.rpc('register_water_sample', {
      p_project_id: input.projectId,
      p_client_entry_id: input.clientEntryId,
      p_taken_at: input.takenAt,
      p_depth_m: input.depthM ?? null,
      p_stage: input.stage?.trim() || null,
      p_notes: input.notes?.trim() || null,
      p_bottle_photo_path: input.bottlePhotoPath?.trim() || null,
      // The web console is online-only, so numbering stays authoritative on
      // the server. The optional override exists solely for offline APK replay.
      p_sample_number: null,
      p_timestamp_local: input.timestampLocal ?? null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo registrar la muestra de agua.');
    return data as WaterSample;
  },
};
