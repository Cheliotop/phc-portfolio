import supabase from '../lib/supabase';
import type { WaterSample } from '../types/productV2';

export const waterSamplesApi = {
  async getAll(projectId?: number): Promise<WaterSample[]> {
    let query = supabase
      .from('water_samples')
      .select('*, projects(name), profiles!water_samples_operator_id_fkey(username, full_name)')
      .order('taken_at', { ascending: false });
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []) as WaterSample[];
  },

  async register(input: {
    clientEntryId: string;
    projectId: number;
    takenAt: string;
    depthM?: number;
    stage?: string;
    notes?: string;
    bottlePhotoPath?: string;
    sampleNumber?: number;
    timestampLocal?: string;
    enteredBy?: string | null;
  }): Promise<WaterSample> {
    const { data, error } = await supabase.rpc('register_water_sample', {
      p_project_id: input.projectId,
      p_client_entry_id: input.clientEntryId,
      p_taken_at: input.takenAt,
      p_depth_m: input.depthM ?? null,
      p_stage: input.stage ?? null,
      p_notes: input.notes ?? null,
      p_bottle_photo_path: input.bottlePhotoPath ?? null,
      p_sample_number: input.sampleNumber ?? null,
      p_timestamp_local: input.timestampLocal ?? null,
      ...(input.enteredBy ? { p_entered_by: input.enteredBy } : {}),
    });
    if (error) throw error;
    return data as WaterSample;
  },
};
