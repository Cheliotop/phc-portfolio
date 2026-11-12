import { execute } from '../index';

/**
 * The ONE place that creates a local `completion_reports_local` row in SQLite.
 *
 * Why this module exists
 * ---------------------
 * This table was checked for the W-10 replacement/omission and Task 3
 * identity-inversion defect classes and found sound: its sole creator uses a
 * plain INSERT, keeps the client-generated local `id` and idempotency key
 * separate from `server_id`, and writes every locally owned closure-state
 * field. Centralizing that statement prevents a partial mirror from replacing
 * an unsynced Ficha and corrupting a billing and legal artifact.
 */

/** Values captured for a new offline Ficha v2 submission. */
export interface LocalCompletionReport {
  id: string;
  client_entry_id: string;
  project_id: number;
  operator_id: string;
  static_level: number;
  dynamic_level: number;
  flow_rate: number;
  specific_flow_rate: number;
  maximum_flow_rate: number;
  pump_depth_m: number;
  specific_flow_overridden: number;
  hydraulic_mismatch: number;
  exploration_depth_m: number;
  widening_depth_m: number;
  casing_total_m: number | null;
  casing_above_ground_m: number | null;
  blind_casing_m: number | null;
  filter_casing_m: number | null;
  sediment_trap_m: number | null;
  centralizer_count: number | null;
  bottom_plug_details: string | null;
  bentonite_quantity: number | null;
  gravel_quantity: number | null;
  casing_layout: string;
  compressor_hours: number | null;
  pump_hours: number | null;
  water_quality: string | null;
  installed_meters: number | null;
  perforated_meters: number | null;
  completion_notes: string | null;
  operator_signature: string;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

/** Insert one offline Ficha while retaining its local idempotency identity. */
export const insertCompletionReport = async (
  report: LocalCompletionReport,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO completion_reports_local (
             id, client_entry_id, project_id, operator_id, format_version,
             static_level, dynamic_level, flow_rate, specific_flow_rate,
             maximum_flow_rate, pump_depth_m, specific_flow_overridden,
             hydraulic_mismatch, exploration_depth_m, widening_depth_m,
             casing_total_m, casing_above_ground_m, blind_casing_m,
             filter_casing_m, sediment_trap_m, centralizer_count,
             bottom_plug_details, bentonite_quantity, gravel_quantity,
             casing_layout, compressor_hours, pump_hours, water_quality,
             installed_meters, perforated_meters, completion_notes,
             operator_signature, status, sync_status, submitted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'pending', ?, ?, ?)`,
    [
      report.id, report.client_entry_id, report.project_id, report.operator_id,
      report.static_level, report.dynamic_level, report.flow_rate,
      report.specific_flow_rate,
      report.maximum_flow_rate, report.pump_depth_m,
      report.specific_flow_overridden, report.hydraulic_mismatch,
      report.exploration_depth_m, report.widening_depth_m,
      report.casing_total_m, report.casing_above_ground_m,
      report.blind_casing_m, report.filter_casing_m,
      report.sediment_trap_m, report.centralizer_count,
      report.bottom_plug_details, report.bentonite_quantity,
      report.gravel_quantity, report.casing_layout,
      report.compressor_hours, report.pump_hours,
      report.water_quality, report.installed_meters,
      report.perforated_meters, report.completion_notes,
      report.operator_signature, report.submitted_at, report.created_at,
      report.updated_at,
    ],
  );
};
