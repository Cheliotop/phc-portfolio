import { supabase } from '../lib/supabase';
import type { CatalogMaterial, CatalogVariant, MaterialType, MeasurementMethod } from '../types/productV2';
import { friendlyApiError } from './supabase-api-errors';

export interface SaveCatalogMaterialInput {
  id?: number;
  name: string;
  unit: string;
  materialType: MaterialType;
  measurementMethod: MeasurementMethod;
  externalCode?: string;
  active?: boolean;
}

export interface SaveCatalogVariantInput {
  id?: number;
  materialId: number;
  displayName: string;
  externalCode?: string;
  diameter?: string;
  lengthM?: number;
  dimensionText?: string;
  active?: boolean;
}

export const catalogApi = {
  async getAll(includeInactive = true): Promise<CatalogMaterial[]> {
    let query = supabase
      .from('catalog_materials')
      .select('id, name, external_code, material_type, unit, measurement_method, active, catalog_variants(id, material_id, display_name, external_code, diameter, length_m, dimension_text, active)')
      .order('name', { ascending: true });
    if (!includeInactive) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw friendlyApiError(error, 'No se pudo cargar el catálogo.');
    return ((data || []) as CatalogMaterial[]).map((material) => ({
      ...material,
      catalog_variants: [...(material.catalog_variants || [])].sort((a, b) =>
        a.display_name.localeCompare(b.display_name, 'es'),
      ),
    }));
  },

  async saveMaterial(input: SaveCatalogMaterialInput): Promise<CatalogMaterial> {
    const { data, error } = await supabase.rpc('upsert_catalog_material', {
      p_name: input.name.trim(),
      p_unit: input.unit.trim(),
      p_material_type: input.materialType,
      p_measurement_method: input.measurementMethod,
      p_external_code: input.externalCode?.trim() || null,
      p_active: input.active ?? true,
      p_material_id: input.id ?? null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo guardar el material.');
    return data as CatalogMaterial;
  },

  async saveVariant(input: SaveCatalogVariantInput): Promise<CatalogVariant> {
    const { data, error } = await supabase.rpc('upsert_catalog_variant', {
      p_material_id: input.materialId,
      p_display_name: input.displayName.trim(),
      p_external_code: input.externalCode?.trim() || null,
      p_diameter: input.diameter?.trim() || null,
      p_length_m: input.lengthM ?? null,
      p_dimension_text: input.dimensionText?.trim() || null,
      p_active: input.active ?? true,
      p_variant_id: input.id ?? null,
    });
    if (error) throw friendlyApiError(error, 'No se pudo guardar la variante.');
    return data as CatalogVariant;
  },
};
