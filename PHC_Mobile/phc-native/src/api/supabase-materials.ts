import supabase from '../lib/supabase';

export const materialsApi = {
  async getProjectMaterials(projectId: number) {
    // Fetch the complete server state so the SQLite mirror can converge when an
    // assignment is deactivated. User-facing consumers filter active rows after
    // mirroring; filtering here would leave a stale local active=1 row forever.
    const { data, error } = await supabase
      .from('project_materials')
      .select('*')
      .eq('project_id', projectId);
    if (error) throw error;
    return { data: data || [] };
  },

  // Compatibility adapter for the older mobile-admin form. Assignment is
  // still catalog-backed and RPC-only: a typed name must resolve to an active
  // material/variant, and it is added to the "extras" layer. The full admin
  // interface exposes an explicit catalog picker and both layers.
  async assignToProject(projectId: number, data: { material_name: string; quantity: number; unit?: string; notes?: string }) {
    const normalized = (value: string) => value.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
    const { data: catalog, error: catalogError } = await supabase
      .from('catalog_materials')
      .select('id, name, catalog_variants(id, display_name, active)')
      .eq('active', true);
    if (catalogError) throw catalogError;
    const requested = normalized(data.material_name);
    let variantId: number | null = null;
    for (const material of catalog || []) {
      const variants = (material.catalog_variants || []).filter((variant: any) => variant.active);
      const match = variants.find((variant: any) => {
        const composite = normalized(variant.display_name) === 'estandar'
          ? material.name
          : `${material.name} · ${variant.display_name}`;
        return normalized(composite) === requested || normalized(variant.display_name) === requested;
      });
      // Only an exact label or variant match counts. A name-only match must not
      // fall back to the first variant: that could book a different presentation.
      if (match) {
        variantId = Number(match.id) || null;
        break;
      }
    }
    if (!variantId) {
      throw new Error('El material no existe en el catálogo activo. Créalo en Catálogo antes de asignarlo.');
    }
    const { data: result, error } = await supabase.rpc('assign_catalog_material_to_project', {
      p_project_id: projectId,
      p_catalog_variant_id: variantId,
      p_quantity: data.quantity,
      p_layer: 'extras',
      p_notes: data.notes ?? null,
    });
    if (error) throw error;
    return { data: result };
  },

  // Cross-project recent consumption for the admin dashboard activity feed —
  // the burn rate is the admin's main control signal (assigned vs. consumed),
  // so usage events belong in "Actividad Reciente" alongside progress,
  // pedidos and cierres. Mirrors the web admin.
  async getRecentConsumption(limit = 12) {
    const { data, error } = await supabase
      .from('material_consumption')
      .select('*, projects(name)')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { data: data || [] };
  },

  // Fix a typo in an assignment: sets the new TOTAL assigned quantity and
  // recomputes what's still available so already-logged consumption is
  // preserved (consumed = initial - current stays constant). Rejects totals
  // smaller than what the operator already consumed. Mirrors the web admin.
  async updateAssignedQuantity(assignmentId: number, newTotal: number) {
    const { data, error } = await supabase.rpc('update_project_material_assignment', {
      p_assignment_id: assignmentId,
      p_new_total: newTotal,
      // null keeps the allocation's existing notes (the server uses COALESCE).
      // The audit reason is recorded server-side; the notes must not be overwritten.
      p_notes: null,
    });
    if (error) throw error;
    return { data };
  },

  // Remove a wrongly-assigned material outright. RLS: admin-only DELETE
  // policy (added 2026-07-10). An RLS-filtered delete returns an empty
  // array — surface that instead of pretending it worked.
  async removeAssigned(assignmentId: number, reason = 'Asignación quitada por administración') {
    const { data, error } = await supabase.rpc('deactivate_project_material_assignment', {
      p_assignment_id: assignmentId,
      p_reason: reason,
    });
    if (error) throw error;
    if (!data) {
      throw new Error('No se pudo quitar el material (no encontrado o sin permiso).');
    }
    return { data };
  },

  async getProjectConsumption(projectId: number) {
    const { data, error } = await supabase
      .from('material_consumption')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data: data || [] };
  },

  // Atomic: verifies the operator can access the project, checks the
  // assigned quantity is sufficient, decrements project_materials.current_quantity,
  // and inserts the consumption record in one transaction. The old raw
  // insert() never decremented the allocation, so "material remaining on
  // this project" silently stopped updating when operators logged usage.
  // operator_id is no longer accepted from the client — the RPC always uses
  // the authenticated caller (auth.uid()), matching the old backend's
  // req.user.id behavior and closing off spoofing another operator's usage.
  async recordConsumption(projectId: number, data: {
    client_entry_id?: string;
    project_material_id?: number;
    material_id?: number;
    material_name?: string;
    quantity_used: number;
    unit?: string;
    date?: string;
    notes?: string;
    shift_id?: string;
    approximate?: boolean;
    enteredBy?: string | null;
  }) {
    const { data: result, error } = await supabase.rpc('record_material_consumption', {
      p_project_id: projectId,
      p_quantity_used: data.quantity_used,
      p_client_entry_id: data.client_entry_id ?? null,
      p_project_material_id: data.project_material_id ?? null,
      p_material_id: data.material_id ?? null,
      p_material_name: data.material_name ?? null,
      p_unit: data.unit ?? null,
      p_date: data.date ?? null,
      p_notes: data.notes ?? null,
      p_shift_id: data.shift_id ?? null,
      p_approximate: data.approximate ?? false,
      ...(data.enteredBy ? { p_entered_by: data.enteredBy } : {}),
    });
    if (error) throw error;
    return { data: result };
  },
};
