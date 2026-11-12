// GENERATED FILE — do not edit by hand.
//
// Exception, 2026-07-31: the `client_errors` block below was added by hand.
// Regenerating the whole file with the Supabase CLI now emits
// `__InternalSupabase.PostgrestVersion: "14.5"`, which the installed
// supabase-js (expecting "12") refuses, so a clean regeneration does not
// compile. Replace this block whenever the client and CLI agree again.
// The `rejected_work_reports` table and its two functions were added the same
// way on 2026-11-05, for the same reason.
// `shifts.reassigned_during_shift` was added the same way on 2026-11-06.
// Regenerate through the Supabase MCP connector (`generate_typescript_types`).
// The `npm run gen:types` CLI script currently fails with Unauthorized because
// its access token is expired, and its local-stack fallback also requires Docker.
//
// Ground truth for the production database schema, produced by the MCP connector.
// src/types/database.ts is hand-written and covers only a fraction of the schema
// (240 lines against 3300 here), which is how W-9 shipped: the client passed a
// `unit` that assign_catalog_material_to_project has no parameter for, so the
// server silently stored its default while the device kept the typed value.
// With these types wired into createClient<Database> that would be a compile error.
//
// Wired into createClient<Database> so table and RPC calls are checked against the
// production schema at compile time.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      rejected_work_reports: {
        Row: {
          applied: boolean
          client_entry_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          entity: string
          entity_id: string | null
          id: number
          op: string | null
          operator_id: string
          payload: Json
          project_id: number | null
          rejected_at: string | null
          rejection_reason: string | null
          reported_by: string
          sent_later_at: string | null
          status: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      client_errors: {
        Row: {
          actor_role: string | null
          app_version: string
          build_number: string | null
          client_entry_id: string
          component_stack: string | null
          id: number
          is_fatal: boolean
          message: string
          occurred_at: string
          os_version: string | null
          platform: string | null
          profile_id: string | null
          reported_at: string
          screen: string | null
          stack: string | null
        }
        Insert: {
          actor_role?: string | null
          app_version: string
          build_number?: string | null
          client_entry_id: string
          component_stack?: string | null
          id?: number
          is_fatal?: boolean
          message: string
          occurred_at: string
          os_version?: string | null
          platform?: string | null
          profile_id?: string | null
          reported_at?: string
          screen?: string | null
          stack?: string | null
        }
        Update: {
          actor_role?: string | null
          app_version?: string
          build_number?: string | null
          client_entry_id?: string
          component_stack?: string | null
          id?: number
          is_fatal?: boolean
          message?: string
          occurred_at?: string
          os_version?: string | null
          platform?: string | null
          profile_id?: string | null
          reported_at?: string
          screen?: string | null
          stack?: string | null
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          entity_id: string
          entity_type: string
          id: number
          metadata: Json
          project_id: number | null
          reason: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id: string
          entity_type: string
          id?: number
          metadata?: Json
          project_id?: number | null
          reason?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: number
          metadata?: Json
          project_id?: number | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_materials: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          external_code: string | null
          id: number
          material_type: string
          measurement_method: string
          name: string
          normalized_name: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          external_code?: string | null
          id?: number
          material_type?: string
          measurement_method?: string
          name: string
          normalized_name?: string | null
          unit: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          external_code?: string | null
          id?: number
          material_type?: string
          measurement_method?: string
          name?: string
          normalized_name?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_materials_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_variants: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          diameter: string | null
          dimension_text: string | null
          display_name: string
          external_code: string | null
          id: number
          length_m: number | null
          material_id: number
          normalized_name: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          diameter?: string | null
          dimension_text?: string | null
          display_name: string
          external_code?: string | null
          id?: number
          length_m?: number | null
          material_id: number
          normalized_name?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          diameter?: string | null
          dimension_text?: string | null
          display_name?: string
          external_code?: string | null
          id?: number
          length_m?: number | null
          material_id?: number
          normalized_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_variants_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "catalog_variants_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "catalog_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      completion_discrepancies: {
        Row: {
          completion_report_id: number | null
          created_at: string
          description: string
          id: number
          project_id: number
          reported_by: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          section: string
          status: string
        }
        Insert: {
          completion_report_id?: number | null
          created_at?: string
          description: string
          id?: number
          project_id: number
          reported_by: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          section: string
          status?: string
        }
        Update: {
          completion_report_id?: number | null
          created_at?: string
          description?: string
          id?: number
          project_id?: number
          reported_by?: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          section?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "completion_discrepancies_completion_report_id_fkey"
            columns: ["completion_report_id"]
            isOneToOne: false
            referencedRelation: "completion_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_discrepancies_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_discrepancies_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_discrepancies_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      completion_reports: {
        Row: {
          admin_signature: string | null
          bentonite_quantity: number | null
          blind_casing_m: number | null
          bottom_plug_details: string | null
          bucket_flow_rate: number | null
          casing_above_ground_m: number | null
          casing_layout: Json
          casing_total_m: number | null
          centralizer_count: number | null
          client_entry_id: string | null
          client_signature: string | null
          completion_checklist: string | null
          completion_notes: string | null
          compressor_hours: number | null
          created_at: string | null
          dynamic_level: number | null
          exploration_depth_m: number | null
          filter_casing_m: number | null
          finalized_at: string | null
          finalized_snapshot: Json | null
          flow_rate: number | null
          flow_unit: string | null
          format_version: number
          gravel_quantity: number | null
          hydraulic_mismatch: boolean
          id: number
          installed_meters: number | null
          last_resubmission_id: string | null
          materials_summary: string | null
          maximum_flow_rate: number | null
          operator_id: string
          operator_signature: string | null
          pdf_url: string | null
          perforated_meters: number | null
          project_id: number
          pump_depth_m: number | null
          pump_hours: number | null
          required_flow: number | null
          return_reason: string | null
          returned_at: string | null
          returned_by: string | null
          sediment_trap_m: number | null
          signed_pdf_attached_at: string | null
          specific_flow_overridden: boolean
          specific_flow_rate: number | null
          static_level: number | null
          status: string | null
          submission_payload: Json | null
          submitted_at: string | null
          updated_at: string | null
          water_quality: string | null
          widening_depth_m: number | null
        }
        Insert: {
          admin_signature?: string | null
          bentonite_quantity?: number | null
          blind_casing_m?: number | null
          bottom_plug_details?: string | null
          bucket_flow_rate?: number | null
          casing_above_ground_m?: number | null
          casing_layout?: Json
          casing_total_m?: number | null
          centralizer_count?: number | null
          client_entry_id?: string | null
          client_signature?: string | null
          completion_checklist?: string | null
          completion_notes?: string | null
          compressor_hours?: number | null
          created_at?: string | null
          dynamic_level?: number | null
          exploration_depth_m?: number | null
          filter_casing_m?: number | null
          finalized_at?: string | null
          finalized_snapshot?: Json | null
          flow_rate?: number | null
          flow_unit?: string | null
          format_version?: number
          gravel_quantity?: number | null
          hydraulic_mismatch?: boolean
          id?: number
          installed_meters?: number | null
          last_resubmission_id?: string | null
          materials_summary?: string | null
          maximum_flow_rate?: number | null
          operator_id?: string
          operator_signature?: string | null
          pdf_url?: string | null
          perforated_meters?: number | null
          project_id: number
          pump_depth_m?: number | null
          pump_hours?: number | null
          required_flow?: number | null
          return_reason?: string | null
          returned_at?: string | null
          returned_by?: string | null
          sediment_trap_m?: number | null
          signed_pdf_attached_at?: string | null
          specific_flow_overridden?: boolean
          specific_flow_rate?: number | null
          static_level?: number | null
          status?: string | null
          submission_payload?: Json | null
          submitted_at?: string | null
          updated_at?: string | null
          water_quality?: string | null
          widening_depth_m?: number | null
        }
        Update: {
          admin_signature?: string | null
          bentonite_quantity?: number | null
          blind_casing_m?: number | null
          bottom_plug_details?: string | null
          bucket_flow_rate?: number | null
          casing_above_ground_m?: number | null
          casing_layout?: Json
          casing_total_m?: number | null
          centralizer_count?: number | null
          client_entry_id?: string | null
          client_signature?: string | null
          completion_checklist?: string | null
          completion_notes?: string | null
          compressor_hours?: number | null
          created_at?: string | null
          dynamic_level?: number | null
          exploration_depth_m?: number | null
          filter_casing_m?: number | null
          finalized_at?: string | null
          finalized_snapshot?: Json | null
          flow_rate?: number | null
          flow_unit?: string | null
          format_version?: number
          gravel_quantity?: number | null
          hydraulic_mismatch?: boolean
          id?: number
          installed_meters?: number | null
          last_resubmission_id?: string | null
          materials_summary?: string | null
          maximum_flow_rate?: number | null
          operator_id?: string
          operator_signature?: string | null
          pdf_url?: string | null
          perforated_meters?: number | null
          project_id?: number
          pump_depth_m?: number | null
          pump_hours?: number | null
          required_flow?: number | null
          return_reason?: string | null
          returned_at?: string | null
          returned_by?: string | null
          sediment_trap_m?: number | null
          signed_pdf_attached_at?: string | null
          specific_flow_overridden?: boolean
          specific_flow_rate?: number | null
          static_level?: number | null
          status?: string | null
          submission_payload?: Json | null
          submitted_at?: string | null
          updated_at?: string | null
          water_quality?: string | null
          widening_depth_m?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "completion_reports_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_reports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_reports_returned_by_fkey"
            columns: ["returned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      drilling_bars: {
        Row: {
          bar_number: number
          client_entry_id: string | null
          created_at: string | null
          depth_end: number
          depth_start: number
          diameter: string | null
          duration_minutes: number | null
          end_time: string | null
          id: number
          length: number
          notes: string | null
          operator_id: string
          photo_paths: string | null
          project_id: number
          request_payload: Json | null
          shift_id: string | null
          soil_type: string
          start_time: string | null
          timestamp_local: string | null
          updated_at: string | null
          water_level: number | null
        }
        Insert: {
          bar_number: number
          client_entry_id?: string | null
          created_at?: string | null
          depth_end: number
          depth_start: number
          diameter?: string | null
          duration_minutes?: number | null
          end_time?: string | null
          id?: number
          length: number
          notes?: string | null
          operator_id?: string
          photo_paths?: string | null
          project_id: number
          request_payload?: Json | null
          shift_id?: string | null
          soil_type: string
          start_time?: string | null
          timestamp_local?: string | null
          updated_at?: string | null
          water_level?: number | null
        }
        Update: {
          bar_number?: number
          client_entry_id?: string | null
          created_at?: string | null
          depth_end?: number
          depth_start?: number
          diameter?: string | null
          duration_minutes?: number | null
          end_time?: string | null
          id?: number
          length?: number
          notes?: string | null
          operator_id?: string
          photo_paths?: string | null
          project_id?: number
          request_payload?: Json | null
          shift_id?: string | null
          soil_type?: string
          start_time?: string | null
          timestamp_local?: string | null
          updated_at?: string | null
          water_level?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "drilling_bars_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drilling_bars_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drilling_bars_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      material_consumption: {
        Row: {
          anomaly_flag: boolean
          approximate: boolean
          client_entry_id: string | null
          created_at: string | null
          date: string | null
          id: number
          material_id: number | null
          material_name: string
          notes: string | null
          operator_id: string
          project_id: number
          project_material_id: number | null
          quantity_used: number
          request_payload: Json | null
          shift_id: string | null
          unit: string | null
        }
        Insert: {
          anomaly_flag?: boolean
          approximate?: boolean
          client_entry_id?: string | null
          created_at?: string | null
          date?: string | null
          id?: number
          material_id?: number | null
          material_name: string
          notes?: string | null
          operator_id?: string
          project_id: number
          project_material_id?: number | null
          quantity_used: number
          request_payload?: Json | null
          shift_id?: string | null
          unit?: string | null
        }
        Update: {
          anomaly_flag?: boolean
          approximate?: boolean
          client_entry_id?: string | null
          created_at?: string | null
          date?: string | null
          id?: number
          material_id?: number | null
          material_name?: string
          notes?: string | null
          operator_id?: string
          project_id?: number
          project_material_id?: number | null
          quantity_used?: number
          request_payload?: Json | null
          shift_id?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_consumption_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_consumption_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_consumption_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_consumption_project_material_id_fkey"
            columns: ["project_material_id"]
            isOneToOne: false
            referencedRelation: "project_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_consumption_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      material_import_lines: {
        Row: {
          catalog_variant_id: number | null
          created_at: string
          description_snapshot: string
          external_code: string | null
          id: number
          import_id: number
          included: boolean
          layer: string
          line_number: number
          project_material_id: number | null
          quantity: number
          unit_snapshot: string
        }
        Insert: {
          catalog_variant_id?: number | null
          created_at?: string
          description_snapshot: string
          external_code?: string | null
          id?: number
          import_id: number
          included?: boolean
          layer?: string
          line_number: number
          project_material_id?: number | null
          quantity: number
          unit_snapshot: string
        }
        Update: {
          catalog_variant_id?: number | null
          created_at?: string
          description_snapshot?: string
          external_code?: string | null
          id?: number
          import_id?: number
          included?: boolean
          layer?: string
          line_number?: number
          project_material_id?: number | null
          quantity?: number
          unit_snapshot?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_import_lines_catalog_variant_id_fkey"
            columns: ["catalog_variant_id"]
            isOneToOne: false
            referencedRelation: "catalog_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_import_lines_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "material_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_import_lines_project_material_id_fkey"
            columns: ["project_material_id"]
            isOneToOne: false
            referencedRelation: "project_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      material_imports: {
        Row: {
          document_number: string
          id: number
          imported_at: string
          imported_by: string
          line_count: number
          project_id: number
          source_name: string | null
        }
        Insert: {
          document_number: string
          id?: number
          imported_at?: string
          imported_by: string
          line_count?: number
          project_id: number
          source_name?: string | null
        }
        Update: {
          document_number?: string
          id?: number
          imported_at?: string
          imported_by?: string
          line_count?: number
          project_id?: number
          source_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_imports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      material_reconciliations: {
        Row: {
          consumed_quantity: number
          created_at: string
          created_by: string
          id: number
          missing_quantity: number | null
          notes: string | null
          overconsumed_quantity: number | null
          project_id: number
          project_material_id: number
          returned_quantity: number
          sent_quantity: number
          updated_at: string
        }
        Insert: {
          consumed_quantity?: number
          created_at?: string
          created_by: string
          id?: number
          missing_quantity?: number | null
          notes?: string | null
          overconsumed_quantity?: number | null
          project_id: number
          project_material_id: number
          returned_quantity: number
          sent_quantity: number
          updated_at?: string
        }
        Update: {
          consumed_quantity?: number
          created_at?: string
          created_by?: string
          id?: number
          missing_quantity?: number | null
          notes?: string | null
          overconsumed_quantity?: number | null
          project_id?: number
          project_material_id?: number
          returned_quantity?: number
          sent_quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_reconciliations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_reconciliations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_reconciliations_project_material_id_fkey"
            columns: ["project_material_id"]
            isOneToOne: false
            referencedRelation: "project_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      material_transactions: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: number
          material_id: number
          notes: string | null
          project_id: number | null
          quantity: number
          transaction_type: string | null
          type: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: number
          material_id: number
          notes?: string | null
          project_id?: number | null
          quantity: number
          transaction_type?: string | null
          type?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: number
          material_id?: number
          notes?: string | null
          project_id?: number | null
          quantity?: number
          transaction_type?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_transactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      materials: {
        Row: {
          category: string
          cost_per_unit: number | null
          created_at: string | null
          current_stock: number | null
          description: string | null
          id: number
          min_quantity: number | null
          minimum_stock: number | null
          name: string
          quantity: number | null
          supplier: string | null
          type: string | null
          unit: string
          updated_at: string | null
        }
        Insert: {
          category: string
          cost_per_unit?: number | null
          created_at?: string | null
          current_stock?: number | null
          description?: string | null
          id?: number
          min_quantity?: number | null
          minimum_stock?: number | null
          name: string
          quantity?: number | null
          supplier?: string | null
          type?: string | null
          unit: string
          updated_at?: string | null
        }
        Update: {
          category?: string
          cost_per_unit?: number | null
          created_at?: string | null
          current_stock?: number | null
          description?: string | null
          id?: number
          min_quantity?: number | null
          minimum_stock?: number | null
          name?: string
          quantity?: number | null
          supplier?: string | null
          type?: string | null
          unit?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      notification_event_claims: {
        Row: {
          claimed_at: string
          claimed_by: string
          entity_id: number
          event_type: string
          sent_at: string | null
        }
        Insert: {
          claimed_at?: string
          claimed_by: string
          entity_id: number
          event_type: string
          sent_at?: string | null
        }
        Update: {
          claimed_at?: string
          claimed_by?: string
          entity_id?: number
          event_type?: string
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_event_claims_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string | null
          id: number
          is_read: boolean | null
          message: string
          related_material: number | null
          related_project: number | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: number
          is_read?: boolean | null
          message: string
          related_material?: number | null
          related_project?: number | null
          title: string
          type?: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: number
          is_read?: boolean | null
          message?: string
          related_material?: number | null
          related_project?: number | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_related_material_fkey"
            columns: ["related_material"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_related_project_fkey"
            columns: ["related_project"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_items: {
        Row: {
          approved_quantity: number | null
          catalog_variant_id: number | null
          client_entry_id: string | null
          closed_at: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_reason: string | null
          id: number
          incident_note: string | null
          layer: string
          material_name_snapshot: string
          pedido_id: number
          received_quantity: number
          requested_quantity: number
          state: string
          unit_snapshot: string
          updated_at: string
        }
        Insert: {
          approved_quantity?: number | null
          catalog_variant_id?: number | null
          client_entry_id?: string | null
          closed_at?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          id?: number
          incident_note?: string | null
          layer?: string
          material_name_snapshot: string
          pedido_id: number
          received_quantity?: number
          requested_quantity: number
          state?: string
          unit_snapshot?: string
          updated_at?: string
        }
        Update: {
          approved_quantity?: number | null
          catalog_variant_id?: number | null
          client_entry_id?: string | null
          closed_at?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          id?: number
          incident_note?: string | null
          layer?: string
          material_name_snapshot?: string
          pedido_id?: number
          received_quantity?: number
          requested_quantity?: number
          state?: string
          unit_snapshot?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedido_items_catalog_variant_id_fkey"
            columns: ["catalog_variant_id"]
            isOneToOne: false
            referencedRelation: "catalog_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_items_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_items_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_receipts: {
        Row: {
          client_entry_id: string
          confirmed_by: string
          created_at: string
          id: number
          incident_note: string | null
          outcome: string
          pedido_item_id: number
          quantity_received: number
        }
        Insert: {
          client_entry_id: string
          confirmed_by: string
          created_at?: string
          id?: number
          incident_note?: string | null
          outcome: string
          pedido_item_id: number
          quantity_received?: number
        }
        Update: {
          client_entry_id?: string
          confirmed_by?: string
          created_at?: string
          id?: number
          incident_note?: string | null
          outcome?: string
          pedido_item_id?: number
          quantity_received?: number
        }
        Relationships: [
          {
            foreignKeyName: "pedido_receipts_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_receipts_pedido_item_id_fkey"
            columns: ["pedido_item_id"]
            isOneToOne: false
            referencedRelation: "pedido_items"
            referencedColumns: ["id"]
          },
        ]
      }
      pedidos: {
        Row: {
          admin_notes: string | null
          approved_at: string | null
          approved_by: string | null
          client_entry_id: string | null
          closed_at: string | null
          closed_by: string | null
          closed_manually: boolean
          created_at: string | null
          id: number
          items: Json | null
          job_site: string | null
          justification: string | null
          kind: string
          material: string | null
          needed_by: string | null
          notes: string | null
          operator_id: string
          pdf_url: string | null
          pedido_number: string | null
          pedido_type: string | null
          priority: string | null
          project_id: number | null
          quantity: number | null
          reason: string | null
          rejection_reason: string | null
          request_payload: Json | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          admin_notes?: string | null
          approved_at?: string | null
          approved_by?: string | null
          client_entry_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_manually?: boolean
          created_at?: string | null
          id?: number
          items?: Json | null
          job_site?: string | null
          justification?: string | null
          kind?: string
          material?: string | null
          needed_by?: string | null
          notes?: string | null
          operator_id?: string
          pdf_url?: string | null
          pedido_number?: string | null
          pedido_type?: string | null
          priority?: string | null
          project_id?: number | null
          quantity?: number | null
          reason?: string | null
          rejection_reason?: string | null
          request_payload?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_notes?: string | null
          approved_at?: string | null
          approved_by?: string | null
          client_entry_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_manually?: boolean
          created_at?: string | null
          id?: number
          items?: Json | null
          job_site?: string | null
          justification?: string | null
          kind?: string
          material?: string | null
          needed_by?: string | null
          notes?: string | null
          operator_id?: string
          pdf_url?: string | null
          pedido_number?: string | null
          pedido_type?: string | null
          priority?: string | null
          project_id?: number | null
          quantity?: number | null
          reason?: string | null
          rejection_reason?: string | null
          request_payload?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          caption: string | null
          created_at: string | null
          evidence_kind: string
          file_size: number | null
          filename: string | null
          id: number
          mime_type: string | null
          original_name: string | null
          project_id: number | null
          report_id: number | null
          shift_id: string | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          evidence_kind?: string
          file_size?: number | null
          filename?: string | null
          id?: number
          mime_type?: string | null
          original_name?: string | null
          project_id?: number | null
          report_id?: number | null
          shift_id?: string | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          evidence_kind?: string
          file_size?: number | null
          filename?: string | null
          id?: number
          mime_type?: string | null
          original_name?: string | null
          project_id?: number | null
          report_id?: number | null
          shift_id?: string | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "photos_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "progress_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          is_active: boolean | null
          last_name: string | null
          phone: string | null
          role: string
          updated_at: string | null
          username: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id: string
          is_active?: boolean | null
          last_name?: string | null
          phone?: string | null
          role?: string
          updated_at?: string | null
          username: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean | null
          last_name?: string | null
          phone?: string | null
          role?: string
          updated_at?: string | null
          username?: string
        }
        Relationships: []
      }
      progress_reports: {
        Row: {
          created_at: string | null
          crew_size: number | null
          description: string | null
          hours_worked: number | null
          id: number
          issues: string | null
          next_steps: string | null
          progress_percentage: number | null
          project_id: number
          report_date: string | null
          reported_by: string
          status: string | null
          title: string | null
          updated_at: string | null
          weather_conditions: string | null
          work_description: string | null
        }
        Insert: {
          created_at?: string | null
          crew_size?: number | null
          description?: string | null
          hours_worked?: number | null
          id?: number
          issues?: string | null
          next_steps?: string | null
          progress_percentage?: number | null
          project_id: number
          report_date?: string | null
          reported_by?: string
          status?: string | null
          title?: string | null
          updated_at?: string | null
          weather_conditions?: string | null
          work_description?: string | null
        }
        Update: {
          created_at?: string | null
          crew_size?: number | null
          description?: string | null
          hours_worked?: number | null
          id?: number
          issues?: string | null
          next_steps?: string | null
          progress_percentage?: number | null
          project_id?: number
          report_date?: string | null
          reported_by?: string
          status?: string | null
          title?: string | null
          updated_at?: string | null
          weather_conditions?: string | null
          work_description?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "progress_reports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "progress_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_attachments: {
        Row: {
          filename: string | null
          id: number
          kind: string
          mime_type: string | null
          notes: string | null
          project_id: number
          storage_path: string
          uploaded_at: string
          uploaded_by: string
          water_sample_id: number | null
        }
        Insert: {
          filename?: string | null
          id?: number
          kind: string
          mime_type?: string | null
          notes?: string | null
          project_id: number
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
          water_sample_id?: number | null
        }
        Update: {
          filename?: string | null
          id?: number
          kind?: string
          mime_type?: string | null
          notes?: string | null
          project_id?: number
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
          water_sample_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "project_attachments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_attachments_water_sample_id_fkey"
            columns: ["water_sample_id"]
            isOneToOne: false
            referencedRelation: "water_samples"
            referencedColumns: ["id"]
          },
        ]
      }
      project_closing_assignments: {
        Row: {
          assigned_by: string
          created_at: string
          operator_id: string
          project_id: number
          updated_at: string
        }
        Insert: {
          assigned_by: string
          created_at?: string
          operator_id: string
          project_id: number
          updated_at?: string
        }
        Update: {
          assigned_by?: string
          created_at?: string
          operator_id?: string
          project_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_closing_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_closing_assignments_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_closing_assignments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_materials: {
        Row: {
          active: boolean
          assigned_date: string | null
          catalog_variant_id: number | null
          created_at: string | null
          current_quantity: number | null
          id: number
          initial_quantity: number | null
          layer: string
          material_id: number | null
          material_name: string
          notes: string | null
          project_id: number
          quantity_allocated: number | null
          unit: string | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean
          assigned_date?: string | null
          catalog_variant_id?: number | null
          created_at?: string | null
          current_quantity?: number | null
          id?: number
          initial_quantity?: number | null
          layer?: string
          material_id?: number | null
          material_name: string
          notes?: string | null
          project_id: number
          quantity_allocated?: number | null
          unit?: string | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean
          assigned_date?: string | null
          catalog_variant_id?: number | null
          created_at?: string | null
          current_quantity?: number | null
          id?: number
          initial_quantity?: number | null
          layer?: string
          material_id?: number | null
          material_name?: string
          notes?: string | null
          project_id?: number
          quantity_allocated?: number | null
          unit?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_materials_catalog_variant_id_fkey"
            columns: ["catalog_variant_id"]
            isOneToOne: false
            referencedRelation: "catalog_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_materials_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_materials_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_secondary_operators: {
        Row: {
          assigned_by: string | null
          created_at: string
          operator_id: string
          project_id: number
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string
          operator_id: string
          project_id: number
        }
        Update: {
          assigned_by?: string | null
          created_at?: string
          operator_id?: string
          project_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_secondary_operators_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_secondary_operators_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_secondary_operators_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          assigned_operator_id: string | null
          client: string | null
          coordinates: string | null
          created_at: string | null
          created_by: string | null
          default_bar_diameter: string | null
          default_bar_length: number | null
          description: string | null
          end_date: string | null
          estimated_completion: string | null
          id: number
          location: string | null
          name: string
          progress_percentage: number | null
          project_type: string | null
          start_date: string | null
          status: string | null
          target_depth: number | null
          type: string | null
          updated_at: string | null
          well_name: string | null
        }
        Insert: {
          assigned_operator_id?: string | null
          client?: string | null
          coordinates?: string | null
          created_at?: string | null
          created_by?: string | null
          default_bar_diameter?: string | null
          default_bar_length?: number | null
          description?: string | null
          end_date?: string | null
          estimated_completion?: string | null
          id?: number
          location?: string | null
          name: string
          progress_percentage?: number | null
          project_type?: string | null
          start_date?: string | null
          status?: string | null
          target_depth?: number | null
          type?: string | null
          updated_at?: string | null
          well_name?: string | null
        }
        Update: {
          assigned_operator_id?: string | null
          client?: string | null
          coordinates?: string | null
          created_at?: string | null
          created_by?: string | null
          default_bar_diameter?: string | null
          default_bar_length?: number | null
          description?: string | null
          end_date?: string | null
          estimated_completion?: string | null
          id?: number
          location?: string | null
          name?: string
          progress_percentage?: number | null
          project_type?: string | null
          start_date?: string | null
          status?: string | null
          target_depth?: number | null
          type?: string | null
          updated_at?: string | null
          well_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_assigned_operator_id_fkey"
            columns: ["assigned_operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      record_corrections: {
        Row: {
          corrected_by: string
          corrected_value: Json
          created_at: string
          entity_id: string
          entity_type: string
          field_name: string
          id: number
          original_value: Json
          project_id: number | null
          reason: string
        }
        Insert: {
          corrected_by: string
          corrected_value: Json
          created_at?: string
          entity_id: string
          entity_type: string
          field_name: string
          id?: number
          original_value: Json
          project_id?: number | null
          reason: string
        }
        Update: {
          corrected_by?: string
          corrected_value?: Json
          created_at?: string
          entity_id?: string
          entity_type?: string
          field_name?: string
          id?: number
          original_value?: Json
          project_id?: number | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "record_corrections_corrected_by_fkey"
            columns: ["corrected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "record_corrections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          id: number
          key: string
          updated_at: string | null
          value: string
        }
        Insert: {
          id?: number
          key: string
          updated_at?: string | null
          value: string
        }
        Update: {
          id?: number
          key?: string
          updated_at?: string | null
          value?: string
        }
        Relationships: []
      }
      shift_handovers: {
        Row: {
          client_entry_id: string | null
          confirmed_by: string
          created_at: string
          expected_quantity: number
          id: number
          note: string | null
          observed_quantity: number | null
          photo_path: string | null
          project_material_id: number
          shift_id: string
          status: string
        }
        Insert: {
          client_entry_id?: string | null
          confirmed_by: string
          created_at?: string
          expected_quantity: number
          id?: number
          note?: string | null
          observed_quantity?: number | null
          photo_path?: string | null
          project_material_id: number
          shift_id: string
          status: string
        }
        Update: {
          client_entry_id?: string | null
          confirmed_by?: string
          created_at?: string
          expected_quantity?: number
          id?: number
          note?: string | null
          observed_quantity?: number | null
          photo_path?: string | null
          project_material_id?: number
          shift_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_handovers_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_handovers_project_material_id_fkey"
            columns: ["project_material_id"]
            isOneToOne: false
            referencedRelation: "project_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_handovers_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          client_entry_id: string | null
          created_at: string
          device_time_flag: boolean
          end_device_time: string | null
          end_type: string | null
          ended_at: string | null
          handover_confirmed: boolean
          id: string
          notes: string | null
          operator_id: string
          project_id: number
          reassigned_during_shift: boolean
          request_payload: Json | null
          start_device_time: string | null
          started_at: string
          status: string
          updated_at: string
          usage_report_submitted: boolean
        }
        Insert: {
          client_entry_id?: string | null
          created_at?: string
          device_time_flag?: boolean
          end_device_time?: string | null
          end_type?: string | null
          ended_at?: string | null
          handover_confirmed?: boolean
          id?: string
          notes?: string | null
          operator_id: string
          project_id: number
          reassigned_during_shift?: boolean
          request_payload?: Json | null
          start_device_time?: string | null
          started_at?: string
          status?: string
          updated_at?: string
          usage_report_submitted?: boolean
        }
        Update: {
          client_entry_id?: string | null
          created_at?: string
          device_time_flag?: boolean
          end_device_time?: string | null
          end_type?: string | null
          ended_at?: string | null
          handover_confirmed?: boolean
          id?: string
          notes?: string | null
          operator_id?: string
          project_id?: number
          reassigned_during_shift?: boolean
          request_payload?: Json | null
          start_device_time?: string | null
          started_at?: string
          status?: string
          updated_at?: string
          usage_report_submitted?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "shifts_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      water_samples: {
        Row: {
          bottle_photo_path: string | null
          client_entry_id: string | null
          created_at: string
          depth_m: number | null
          device_time_flag: boolean
          id: number
          notes: string | null
          operator_id: string
          project_id: number
          request_payload: Json | null
          sample_number: number
          stage: string | null
          taken_at: string
          timestamp_local: string | null
        }
        Insert: {
          bottle_photo_path?: string | null
          client_entry_id?: string | null
          created_at?: string
          depth_m?: number | null
          device_time_flag?: boolean
          id?: number
          notes?: string | null
          operator_id: string
          project_id: number
          request_payload?: Json | null
          sample_number: number
          stage?: string | null
          taken_at: string
          timestamp_local?: string | null
        }
        Update: {
          bottle_photo_path?: string | null
          client_entry_id?: string | null
          created_at?: string
          depth_m?: number | null
          device_time_flag?: boolean
          id?: number
          notes?: string | null
          operator_id?: string
          project_id?: number
          request_payload?: Json | null
          sample_number?: number
          stage?: string | null
          taken_at?: string
          timestamp_local?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "water_samples_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_samples_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      report_rejected_work: {
        Args: {
          p_client_entry_id: string
          p_entity: string
          p_entity_id: string
          p_op: string
          p_operator_id: string
          p_payload: Json
          p_rejected_at?: string
          p_rejection_reason?: string
        }
        Returns: number
      }
      mark_rejected_work_sent: {
        Args: { p_client_entry_id: string }
        Returns: boolean
      }
      decide_rejected_work: {
        Args: { p_decision: string; p_note?: string; p_report_id: number }
        Returns: Database["public"]["Tables"]["rejected_work_reports"]["Row"]
      }
      force_close_shift: {
        Args: { p_reason: string; p_shift_id: string }
        Returns: Database["public"]["Tables"]["shifts"]["Row"]
      }
      adjust_material_stock: {
        Args: { p_material_id: number; p_quantity: number; p_reason?: string }
        Returns: {
          category: string
          cost_per_unit: number | null
          created_at: string | null
          current_stock: number | null
          description: string | null
          id: number
          min_quantity: number | null
          minimum_stock: number | null
          name: string
          quantity: number | null
          supplier: string | null
          type: string | null
          unit: string
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "materials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_pedido: {
        Args: {
          p_notes?: string
          p_pedido_id: number
          p_quantity_override?: number
        }
        Returns: {
          admin_notes: string | null
          approved_at: string | null
          approved_by: string | null
          client_entry_id: string | null
          closed_at: string | null
          closed_by: string | null
          closed_manually: boolean
          created_at: string | null
          id: number
          items: Json | null
          job_site: string | null
          justification: string | null
          kind: string
          material: string | null
          needed_by: string | null
          notes: string | null
          operator_id: string
          pdf_url: string | null
          pedido_number: string | null
          pedido_type: string | null
          priority: string | null
          project_id: number | null
          quantity: number | null
          reason: string | null
          rejection_reason: string | null
          request_payload: Json | null
          status: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "pedidos"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assign_catalog_material_to_project: {
        Args: {
          p_catalog_variant_id: number
          p_layer?: string
          p_notes?: string
          p_project_id: number
          p_quantity: number
        }
        Returns: {
          active: boolean
          assigned_date: string | null
          catalog_variant_id: number | null
          created_at: string | null
          current_quantity: number | null
          id: number
          initial_quantity: number | null
          layer: string
          material_id: number | null
          material_name: string
          notes: string | null
          project_id: number
          quantity_allocated: number | null
          unit: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "project_materials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assign_material_to_project: {
        Args: {
          p_material_name: string
          p_notes?: string
          p_project_id: number
          p_quantity: number
          p_unit?: string
        }
        Returns: {
          active: boolean
          assigned_date: string | null
          catalog_variant_id: number | null
          created_at: string | null
          current_quantity: number | null
          id: number
          initial_quantity: number | null
          layer: string
          material_id: number | null
          material_name: string
          notes: string | null
          project_id: number
          quantity_allocated: number | null
          unit: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "project_materials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      attach_completion_pdf: {
        Args: { p_report_id: number; p_storage_path: string }
        Returns: {
          admin_signature: string | null
          bentonite_quantity: number | null
          blind_casing_m: number | null
          bottom_plug_details: string | null
          bucket_flow_rate: number | null
          casing_above_ground_m: number | null
          casing_layout: Json
          casing_total_m: number | null
          centralizer_count: number | null
          client_entry_id: string | null
          client_signature: string | null
          completion_checklist: string | null
          completion_notes: string | null
          compressor_hours: number | null
          created_at: string | null
          dynamic_level: number | null
          exploration_depth_m: number | null
          filter_casing_m: number | null
          finalized_at: string | null
          finalized_snapshot: Json | null
          flow_rate: number | null
          flow_unit: string | null
          format_version: number
          gravel_quantity: number | null
          hydraulic_mismatch: boolean
          id: number
          installed_meters: number | null
          last_resubmission_id: string | null
          materials_summary: string | null
          maximum_flow_rate: number | null
          operator_id: string
          operator_signature: string | null
          pdf_url: string | null
          perforated_meters: number | null
          project_id: number
          pump_depth_m: number | null
          pump_hours: number | null
          required_flow: number | null
          return_reason: string | null
          returned_at: string | null
          returned_by: string | null
          sediment_trap_m: number | null
          signed_pdf_attached_at: string | null
          specific_flow_overridden: boolean
          specific_flow_rate: number | null
          static_level: number | null
          status: string | null
          submission_payload: Json | null
          submitted_at: string | null
          updated_at: string | null
          water_quality: string | null
          widening_depth_m: number | null
        }
        SetofOptions: {
          from: "*"
          to: "completion_reports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_notification_event: {
        Args: { p_actor_id: string; p_entity_id: number; p_event_type: string }
        Returns: boolean
      }
      close_pedido_manually: {
        Args: { p_pedido_id: number; p_reason: string }
        Returns: {
          admin_notes: string | null
          approved_at: string | null
          approved_by: string | null
          client_entry_id: string | null
          closed_at: string | null
          closed_by: string | null
          closed_manually: boolean
          created_at: string | null
          id: number
          items: Json | null
          job_site: string | null
          justification: string | null
          kind: string
          material: string | null
          needed_by: string | null
          notes: string | null
          operator_id: string
          pdf_url: string | null
          pedido_number: string | null
          pedido_type: string | null
          priority: string | null
          project_id: number | null
          quantity: number | null
          reason: string | null
          rejection_reason: string | null
          request_payload: Json | null
          status: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "pedidos"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      confirm_pedido_item_receipt: {
        Args: {
          p_client_entry_id: string
          p_incident_note?: string
          p_item_id: number
          p_outcome: string
          p_quantity_received?: number
        }
        Returns: Json
      }
      confirm_shift_handover: {
        Args: { p_items: Json; p_shift_id: string }
        Returns: {
          client_entry_id: string | null
          created_at: string
          device_time_flag: boolean
          end_device_time: string | null
          end_type: string | null
          ended_at: string | null
          handover_confirmed: boolean
          id: string
          notes: string | null
          operator_id: string
          project_id: number
          reassigned_during_shift: boolean
          request_payload: Json | null
          start_device_time: string | null
          started_at: string
          status: string
          updated_at: string
          usage_report_submitted: boolean
        }
        SetofOptions: {
          from: "*"
          to: "shifts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_drilling_bar: {
        Args: {
          p_client_entry_id?: string
          p_diameter?: string
          p_duration_minutes?: number
          p_end_time?: string
          p_length?: number
          p_notes?: string
          p_photo_paths?: string
          p_project_id: number
          p_shift_id?: string
          p_soil_type: string
          p_start_time?: string
          p_timestamp_local?: string
          p_water_level?: number
        }
        Returns: {
          bar_number: number
          client_entry_id: string | null
          created_at: string | null
          depth_end: number
          depth_start: number
          diameter: string | null
          duration_minutes: number | null
          end_time: string | null
          id: number
          length: number
          notes: string | null
          operator_id: string
          photo_paths: string | null
          project_id: number
          request_payload: Json | null
          shift_id: string | null
          soil_type: string
          start_time: string | null
          timestamp_local: string | null
          updated_at: string | null
          water_level: number | null
        }
        SetofOptions: {
          from: "*"
          to: "drilling_bars"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_pedido_v2: {
        Args: {
          p_client_entry_id: string
          p_items: Json
          p_justification?: string
          p_kind: string
          p_needed_by?: string
          p_notes?: string
          p_priority?: string
          p_project_id: number
        }
        Returns: Json
      }
      // Added by hand, like the client_errors block above: a full CLI
      // regeneration now emits PostgrestVersion "14.5", which the installed
      // supabase-js rejects. Mirrors 20260801120000_phc_delete_unused_operator.
      delete_unused_operator: {
        Args: { p_operator_id: string }
        Returns: Json
      }
      deactivate_project_material_assignment: {
        Args: { p_assignment_id: number; p_reason: string }
        Returns: {
          active: boolean
          assigned_date: string | null
          catalog_variant_id: number | null
          created_at: string | null
          current_quantity: number | null
          id: number
          initial_quantity: number | null
          layer: string
          material_id: number | null
          material_name: string
          notes: string | null
          project_id: number
          quantity_allocated: number | null
          unit: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "project_materials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decide_pedido_item: {
        Args: {
          p_approved_quantity?: number
          p_decision: string
          p_item_id: number
          p_layer?: string
          p_reason?: string
        }
        Returns: {
          approved_quantity: number | null
          catalog_variant_id: number | null
          client_entry_id: string | null
          closed_at: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_reason: string | null
          id: number
          incident_note: string | null
          layer: string
          material_name_snapshot: string
          pedido_id: number
          received_quantity: number
          requested_quantity: number
          state: string
          unit_snapshot: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "pedido_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      end_shift: {
        Args: {
          p_device_ended_at?: string
          p_end_type?: string
          p_notes?: string
          p_shift_id: string
          p_usage: Json
        }
        Returns: {
          client_entry_id: string | null
          created_at: string
          device_time_flag: boolean
          end_device_time: string | null
          end_type: string | null
          ended_at: string | null
          handover_confirmed: boolean
          id: string
          notes: string | null
          operator_id: string
          project_id: number
          reassigned_during_shift: boolean
          request_payload: Json | null
          start_device_time: string | null
          started_at: string
          status: string
          updated_at: string
          usage_report_submitted: boolean
        }
        SetofOptions: {
          from: "*"
          to: "shifts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_project_attachment_delete: {
        Args: {
          p_actor_id: string
          p_attachment_id: number
          p_expected_storage_path: string
          p_reason: string
        }
        Returns: boolean
      }
      get_admin_project_dossier: {
        Args: { p_project_id: number }
        Returns: Json
      }
      get_closing_ficha_preview: {
        Args: { p_project_id: number }
        Returns: Json
      }
      get_operator_accountability_metrics: {
        Args: { p_operator_id?: string }
        Returns: Json
      }
      import_project_materials: {
        Args: {
          p_document_number: string
          p_lines: Json
          p_project_id: number
          p_source_name?: string
        }
        Returns: Json
      }
      is_active_user: { Args: never; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_closing_operator: { Args: { p_project_id: number }; Returns: boolean }
      is_project_operator: { Args: { p_project_id: number }; Returns: boolean }
      is_project_secondary_operator: {
        Args: { p_project_id: number }
        Returns: boolean
      }
      is_project_team_member: {
        Args: { p_project_id: number }
        Returns: boolean
      }
      mark_notification_event_sent: {
        Args: { p_actor_id: string; p_entity_id: number; p_event_type: string }
        Returns: boolean
      }
      normalize_catalog_name: { Args: { p_value: string }; Returns: string }
      project_allows_closure_change: {
        Args: { p_project_id: number }
        Returns: boolean
      }
      project_allows_field_work: {
        Args: { p_project_id: number }
        Returns: boolean
      }
      project_allows_planning_change: {
        Args: { p_project_id: number }
        Returns: boolean
      }
      project_status_key: { Args: { p_status: string }; Returns: string }
      record_admin_correction: {
        Args: {
          p_corrected_value: Json
          p_entity_id: string
          p_entity_type: string
          p_field_name: string
          p_reason: string
        }
        Returns: {
          corrected_by: string
          corrected_value: Json
          created_at: string
          entity_id: string
          entity_type: string
          field_name: string
          id: number
          original_value: Json
          project_id: number | null
          reason: string
        }
        SetofOptions: {
          from: "*"
          to: "record_corrections"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_material_consumption: {
        Args: {
          p_approximate?: boolean
          p_client_entry_id?: string
          p_date?: string
          p_material_id?: number
          p_material_name?: string
          p_notes?: string
          p_project_id: number
          p_project_material_id?: number
          p_quantity_used: number
          p_shift_id?: string
          p_unit?: string
        }
        Returns: {
          anomaly_flag: boolean
          approximate: boolean
          client_entry_id: string | null
          created_at: string | null
          date: string | null
          id: number
          material_id: number | null
          material_name: string
          notes: string | null
          operator_id: string
          project_id: number
          project_material_id: number | null
          quantity_used: number
          request_payload: Json | null
          shift_id: string | null
          unit: string | null
        }
        SetofOptions: {
          from: "*"
          to: "material_consumption"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      register_project_attachment: {
        Args: {
          p_filename?: string
          p_kind: string
          p_mime_type?: string
          p_notes?: string
          p_project_id: number
          p_storage_path: string
          p_water_sample_id?: number
        }
        Returns: {
          filename: string | null
          id: number
          kind: string
          mime_type: string | null
          notes: string | null
          project_id: number
          storage_path: string
          uploaded_at: string
          uploaded_by: string
          water_sample_id: number | null
        }
        SetofOptions: {
          from: "*"
          to: "project_attachments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      register_water_sample: {
        Args: {
          p_bottle_photo_path?: string
          p_client_entry_id: string
          p_depth_m?: number
          p_notes?: string
          p_project_id: number
          p_sample_number?: number
          p_stage?: string
          p_taken_at: string
          p_timestamp_local?: string
        }
        Returns: {
          bottle_photo_path: string | null
          client_entry_id: string | null
          created_at: string
          depth_m: number | null
          device_time_flag: boolean
          id: number
          notes: string | null
          operator_id: string
          project_id: number
          request_payload: Json | null
          sample_number: number
          stage: string | null
          taken_at: string
          timestamp_local: string | null
        }
        SetofOptions: {
          from: "*"
          to: "water_samples"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reject_pedido: {
        Args: { p_pedido_id: number; p_reason?: string }
        Returns: {
          admin_notes: string | null
          approved_at: string | null
          approved_by: string | null
          client_entry_id: string | null
          closed_at: string | null
          closed_by: string | null
          closed_manually: boolean
          created_at: string | null
          id: number
          items: Json | null
          job_site: string | null
          justification: string | null
          kind: string
          material: string | null
          needed_by: string | null
          notes: string | null
          operator_id: string
          pdf_url: string | null
          pedido_number: string | null
          pedido_type: string | null
          priority: string | null
          project_id: number | null
          quantity: number | null
          reason: string | null
          rejection_reason: string | null
          request_payload: Json | null
          status: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "pedidos"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      release_notification_event_claim: {
        Args: { p_actor_id: string; p_entity_id: number; p_event_type: string }
        Returns: boolean
      }
      report_completion_discrepancy: {
        Args: {
          p_completion_report_id?: number
          p_description: string
          p_project_id: number
          p_section: string
        }
        Returns: {
          completion_report_id: number | null
          created_at: string
          description: string
          id: number
          project_id: number
          reported_by: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          section: string
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "completion_discrepancies"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resolve_completion_discrepancy: {
        Args: { p_discrepancy_id: number; p_resolution_note: string }
        Returns: {
          completion_report_id: number | null
          created_at: string
          description: string
          id: number
          project_id: number
          reported_by: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          section: string
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "completion_discrepancies"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resubmit_completion_v2: {
        Args: {
          p_client_entry_id: string
          p_completion_notes?: string
          p_final_fields: Json
          p_operator_signature: string
          p_pdf_url?: string
          p_report_id: number
        }
        Returns: {
          admin_signature: string | null
          bentonite_quantity: number | null
          blind_casing_m: number | null
          bottom_plug_details: string | null
          bucket_flow_rate: number | null
          casing_above_ground_m: number | null
          casing_layout: Json
          casing_total_m: number | null
          centralizer_count: number | null
          client_entry_id: string | null
          client_signature: string | null
          completion_checklist: string | null
          completion_notes: string | null
          compressor_hours: number | null
          created_at: string | null
          dynamic_level: number | null
          exploration_depth_m: number | null
          filter_casing_m: number | null
          finalized_at: string | null
          finalized_snapshot: Json | null
          flow_rate: number | null
          flow_unit: string | null
          format_version: number
          gravel_quantity: number | null
          hydraulic_mismatch: boolean
          id: number
          installed_meters: number | null
          last_resubmission_id: string | null
          materials_summary: string | null
          maximum_flow_rate: number | null
          operator_id: string
          operator_signature: string | null
          pdf_url: string | null
          perforated_meters: number | null
          project_id: number
          pump_depth_m: number | null
          pump_hours: number | null
          required_flow: number | null
          return_reason: string | null
          returned_at: string | null
          returned_by: string | null
          sediment_trap_m: number | null
          signed_pdf_attached_at: string | null
          specific_flow_overridden: boolean
          specific_flow_rate: number | null
          static_level: number | null
          status: string | null
          submission_payload: Json | null
          submitted_at: string | null
          updated_at: string | null
          water_quality: string | null
          widening_depth_m: number | null
        }
        SetofOptions: {
          from: "*"
          to: "completion_reports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      return_completion_v2: {
        Args: { p_reason: string; p_report_id: number }
        Returns: {
          admin_signature: string | null
          bentonite_quantity: number | null
          blind_casing_m: number | null
          bottom_plug_details: string | null
          bucket_flow_rate: number | null
          casing_above_ground_m: number | null
          casing_layout: Json
          casing_total_m: number | null
          centralizer_count: number | null
          client_entry_id: string | null
          client_signature: string | null
          completion_checklist: string | null
          completion_notes: string | null
          compressor_hours: number | null
          created_at: string | null
          dynamic_level: number | null
          exploration_depth_m: number | null
          filter_casing_m: number | null
          finalized_at: string | null
          finalized_snapshot: Json | null
          flow_rate: number | null
          flow_unit: string | null
          format_version: number
          gravel_quantity: number | null
          hydraulic_mismatch: boolean
          id: number
          installed_meters: number | null
          last_resubmission_id: string | null
          materials_summary: string | null
          maximum_flow_rate: number | null
          operator_id: string
          operator_signature: string | null
          pdf_url: string | null
          perforated_meters: number | null
          project_id: number
          pump_depth_m: number | null
          pump_hours: number | null
          required_flow: number | null
          return_reason: string | null
          returned_at: string | null
          returned_by: string | null
          sediment_trap_m: number | null
          signed_pdf_attached_at: string | null
          specific_flow_overridden: boolean
          specific_flow_rate: number | null
          static_level: number | null
          status: string | null
          submission_payload: Json | null
          submitted_at: string | null
          updated_at: string | null
          water_quality: string | null
          widening_depth_m: number | null
        }
        SetofOptions: {
          from: "*"
          to: "completion_reports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      safe_bigint: { Args: { p_value: string }; Returns: number }
      save_material_reconciliation: {
        Args: {
          p_notes?: string
          p_project_id: number
          p_project_material_id: number
          p_returned_quantity: number
        }
        Returns: {
          consumed_quantity: number
          created_at: string
          created_by: string
          id: number
          missing_quantity: number | null
          notes: string | null
          overconsumed_quantity: number | null
          project_id: number
          project_material_id: number
          returned_quantity: number
          sent_quantity: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "material_reconciliations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_project_closing_operator: {
        Args: { p_operator_id: string; p_project_id: number }
        Returns: {
          assigned_by: string
          created_at: string
          operator_id: string
          project_id: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "project_closing_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      sign_completion_report: {
        Args: {
          p_acknowledge_open_pedidos?: boolean
          p_admin_signature: string
          p_complete_project?: boolean
          p_report_id: number
        }
        Returns: {
          admin_signature: string | null
          bentonite_quantity: number | null
          blind_casing_m: number | null
          bottom_plug_details: string | null
          bucket_flow_rate: number | null
          casing_above_ground_m: number | null
          casing_layout: Json
          casing_total_m: number | null
          centralizer_count: number | null
          client_entry_id: string | null
          client_signature: string | null
          completion_checklist: string | null
          completion_notes: string | null
          compressor_hours: number | null
          created_at: string | null
          dynamic_level: number | null
          exploration_depth_m: number | null
          filter_casing_m: number | null
          finalized_at: string | null
          finalized_snapshot: Json | null
          flow_rate: number | null
          flow_unit: string | null
          format_version: number
          gravel_quantity: number | null
          hydraulic_mismatch: boolean
          id: number
          installed_meters: number | null
          last_resubmission_id: string | null
          materials_summary: string | null
          maximum_flow_rate: number | null
          operator_id: string
          operator_signature: string | null
          pdf_url: string | null
          perforated_meters: number | null
          project_id: number
          pump_depth_m: number | null
          pump_hours: number | null
          required_flow: number | null
          return_reason: string | null
          returned_at: string | null
          returned_by: string | null
          sediment_trap_m: number | null
          signed_pdf_attached_at: string | null
          specific_flow_overridden: boolean
          specific_flow_rate: number | null
          static_level: number | null
          status: string | null
          submission_payload: Json | null
          submitted_at: string | null
          updated_at: string | null
          water_quality: string | null
          widening_depth_m: number | null
        }
        SetofOptions: {
          from: "*"
          to: "completion_reports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_shift: {
        Args: {
          p_client_entry_id: string
          p_device_started_at?: string
          p_project_id: number
          p_shift_id: string
          p_started_at?: string
        }
        Returns: {
          client_entry_id: string | null
          created_at: string
          device_time_flag: boolean
          end_device_time: string | null
          end_type: string | null
          ended_at: string | null
          handover_confirmed: boolean
          id: string
          notes: string | null
          operator_id: string
          project_id: number
          reassigned_during_shift: boolean
          request_payload: Json | null
          start_device_time: string | null
          started_at: string
          status: string
          updated_at: string
          usage_report_submitted: boolean
        }
        SetofOptions: {
          from: "*"
          to: "shifts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      storage_project_id: { Args: { p_object_name: string }; Returns: number }
      submit_completion_v2: {
        Args: {
          p_client_entry_id: string
          p_completion_notes?: string
          p_final_fields: Json
          p_operator_signature: string
          p_pdf_url?: string
          p_project_id: number
        }
        Returns: {
          admin_signature: string | null
          bentonite_quantity: number | null
          blind_casing_m: number | null
          bottom_plug_details: string | null
          bucket_flow_rate: number | null
          casing_above_ground_m: number | null
          casing_layout: Json
          casing_total_m: number | null
          centralizer_count: number | null
          client_entry_id: string | null
          client_signature: string | null
          completion_checklist: string | null
          completion_notes: string | null
          compressor_hours: number | null
          created_at: string | null
          dynamic_level: number | null
          exploration_depth_m: number | null
          filter_casing_m: number | null
          finalized_at: string | null
          finalized_snapshot: Json | null
          flow_rate: number | null
          flow_unit: string | null
          format_version: number
          gravel_quantity: number | null
          hydraulic_mismatch: boolean
          id: number
          installed_meters: number | null
          last_resubmission_id: string | null
          materials_summary: string | null
          maximum_flow_rate: number | null
          operator_id: string
          operator_signature: string | null
          pdf_url: string | null
          perforated_meters: number | null
          project_id: number
          pump_depth_m: number | null
          pump_hours: number | null
          required_flow: number | null
          return_reason: string | null
          returned_at: string | null
          returned_by: string | null
          sediment_trap_m: number | null
          signed_pdf_attached_at: string | null
          specific_flow_overridden: boolean
          specific_flow_rate: number | null
          static_level: number | null
          status: string | null
          submission_payload: Json | null
          submitted_at: string | null
          updated_at: string | null
          water_quality: string | null
          widening_depth_m: number | null
        }
        SetofOptions: {
          from: "*"
          to: "completion_reports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_project_material_assignment: {
        Args: { p_assignment_id: number; p_new_total: number; p_notes?: string }
        Returns: {
          active: boolean
          assigned_date: string | null
          catalog_variant_id: number | null
          created_at: string | null
          current_quantity: number | null
          id: number
          initial_quantity: number | null
          layer: string
          material_id: number | null
          material_name: string
          notes: string | null
          project_id: number
          quantity_allocated: number | null
          unit: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "project_materials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_catalog_material: {
        Args: {
          p_active?: boolean
          p_external_code?: string
          p_material_id?: number
          p_material_type: string
          p_measurement_method: string
          p_name: string
          p_unit: string
        }
        Returns: {
          active: boolean
          created_at: string
          created_by: string | null
          external_code: string | null
          id: number
          material_type: string
          measurement_method: string
          name: string
          normalized_name: string | null
          unit: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "catalog_materials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_catalog_variant: {
        Args: {
          p_active?: boolean
          p_diameter?: string
          p_dimension_text?: string
          p_display_name: string
          p_external_code?: string
          p_length_m?: number
          p_material_id: number
          p_variant_id?: number
        }
        Returns: {
          active: boolean
          created_at: string
          created_by: string | null
          diameter: string | null
          dimension_text: string | null
          display_name: string
          external_code: string | null
          id: number
          length_m: number | null
          material_id: number
          normalized_name: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "catalog_variants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
