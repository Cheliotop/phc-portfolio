import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { catalogApi } from '../api/supabase-catalog';
import type { CatalogMaterial, CatalogVariant, MaterialType, MeasurementMethod } from '../types/productV2';
import { unitChangeWarning } from '../domain/unitChange';

interface MaterialFormState {
  id?: number;
  name: string;
  externalCode: string;
  materialType: MaterialType;
  unit: string;
  measurementMethod: MeasurementMethod;
  active: boolean;
}

interface VariantFormState {
  id?: number;
  materialId: number;
  displayName: string;
  externalCode: string;
  diameter: string;
  lengthM: string;
  dimensionText: string;
  active: boolean;
}

const MATERIAL_TYPES: Array<{ value: MaterialType; label: string }> = [
  { value: 'consumable', label: 'Consumible' },
  { value: 'tool', label: 'Herramienta' },
  { value: 'fuel', label: 'Combustible' },
  { value: 'food', label: 'Alimento' },
  { value: 'pipe', label: 'Cañería' },
  { value: 'cement', label: 'Cemento' },
  { value: 'cable', label: 'Cable' },
  { value: 'other', label: 'Otro' },
];

const MEASUREMENT_METHODS: Array<{ value: MeasurementMethod; label: string }> = [
  { value: 'quantity', label: 'Cantidad' },
  { value: 'volume', label: 'Volumen' },
  { value: 'weight', label: 'Peso' },
  { value: 'length', label: 'Longitud' },
  { value: 'diameter_length', label: 'Diámetro + longitud' },
];

const emptyMaterialForm = (): MaterialFormState => ({
  name: '',
  externalCode: '',
  materialType: 'consumable',
  unit: 'unidad',
  measurementMethod: 'quantity',
  active: true,
});

const formFromMaterial = (material: CatalogMaterial): MaterialFormState => ({
  id: material.id,
  name: material.name,
  externalCode: material.external_code || '',
  materialType: material.material_type,
  unit: material.unit,
  measurementMethod: material.measurement_method,
  active: material.active,
});

const emptyVariantForm = (materialId: number): VariantFormState => ({
  materialId,
  displayName: '',
  externalCode: '',
  diameter: '',
  lengthM: '',
  dimensionText: '',
  active: true,
});

const formFromVariant = (variant: CatalogVariant): VariantFormState => ({
  id: variant.id,
  materialId: variant.material_id,
  displayName: variant.display_name,
  externalCode: variant.external_code || '',
  diameter: variant.diameter || '',
  lengthM: variant.length_m != null ? String(variant.length_m) : '',
  dimensionText: variant.dimension_text || '',
  active: variant.active,
});

const typeLabel = (value: MaterialType) => MATERIAL_TYPES.find((item) => item.value === value)?.label || value;
const methodLabel = (value: MeasurementMethod) => MEASUREMENT_METHODS.find((item) => item.value === value)?.label || value;

export const Catalogo = () => {
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [materialForm, setMaterialForm] = useState<MaterialFormState | null>(null);
  const [variantForm, setVariantForm] = useState<VariantFormState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMaterials(await catalogApi.getAll(true));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar el catálogo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleMaterials = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es');
    return materials.filter((material) => {
      if (!showInactive && !material.active) return false;
      if (!term) return true;
      return [
        material.name,
        material.external_code,
        ...(material.catalog_variants || [])
          .filter((variant) => showInactive || variant.active)
          .flatMap((variant) => [variant.display_name, variant.external_code]),
      ].some((value) => value?.toLocaleLowerCase('es').includes(term));
    });
  }, [materials, search, showInactive]);

  const saveMaterial = async (event: FormEvent) => {
    event.preventDefault();
    if (!materialForm) return;
    if (materialForm.name.trim().length < 2 || !materialForm.unit.trim()) {
      setError('Nombre y unidad son obligatorios.');
      return;
    }
    // A unit change does not convert what wells already hold (audit ADM-5): ask first.
    const previous = materialForm.id ? materials.find((material) => material.id === materialForm.id) : undefined;
    const warning = previous ? unitChangeWarning(previous.unit, materialForm.unit) : null;
    if (warning && !window.confirm(warning)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await catalogApi.saveMaterial(materialForm);
      setNotice(materialForm.id ? 'Material actualizado.' : 'Material creado con su variante Estándar.');
      setExpandedId(saved.id);
      setMaterialForm(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar el material.');
    } finally {
      setBusy(false);
    }
  };

  const toggleMaterial = async (material: CatalogMaterial) => {
    const nextActive = !material.active;
    if (!nextActive && !window.confirm(`¿Desactivar "${material.name}"? Seguirá visible en el historial, pero no podrá elegirse en nuevas asignaciones.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await catalogApi.saveMaterial({
        ...formFromMaterial(material),
        active: nextActive,
      });
      setNotice(nextActive ? 'Material reactivado.' : 'Material desactivado sin borrar su historial.');
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'No se pudo cambiar el estado del material.');
    } finally {
      setBusy(false);
    }
  };

  const saveVariant = async (event: FormEvent) => {
    event.preventDefault();
    if (!variantForm) return;
    const parsedLength = variantForm.lengthM ? Number(variantForm.lengthM) : undefined;
    if (!variantForm.displayName.trim()) {
      setError('El nombre de la variante es obligatorio.');
      return;
    }
    if (parsedLength !== undefined && !(parsedLength > 0)) {
      setError('La longitud debe ser mayor que cero.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await catalogApi.saveVariant({
        id: variantForm.id,
        materialId: variantForm.materialId,
        displayName: variantForm.displayName,
        externalCode: variantForm.externalCode,
        diameter: variantForm.diameter,
        lengthM: parsedLength,
        dimensionText: variantForm.dimensionText,
        active: variantForm.active,
      });
      setNotice(variantForm.id ? 'Variante actualizada.' : 'Variante agregada al catálogo.');
      setExpandedId(variantForm.materialId);
      setVariantForm(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar la variante.');
    } finally {
      setBusy(false);
    }
  };

  const toggleVariant = async (variant: CatalogVariant) => {
    const nextActive = !variant.active;
    if (!nextActive && !window.confirm(`¿Desactivar la variante "${variant.display_name}"?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await catalogApi.saveVariant({
        ...formFromVariant(variant),
        materialId: variant.material_id,
        displayName: variant.display_name,
        lengthM: variant.length_m ?? undefined,
        active: nextActive,
      });
      setNotice(nextActive ? 'Variante reactivada.' : 'Variante desactivada.');
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'No se pudo cambiar el estado de la variante.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card-header management-toolbar">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Catálogo de Materiales</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>Materiales permanentes, unidades y variantes reutilizables</p>
        </div>
        <button className="btn-primary button-auto" onClick={() => { setMaterialForm(emptyMaterialForm()); setVariantForm(null); }}>
          + Nuevo material
        </button>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}
      {notice && <div className="success-message" role="status">{notice}</div>}

      <div className="card catalog-controls">
        <input
          className="field-input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar por material, variante o código"
          aria-label="Buscar en el catálogo"
        />
        <label className="checkbox-row">
          <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
          Mostrar desactivados
        </label>
        <button className="btn-secondary" disabled={loading} onClick={() => void load()}>Actualizar</button>
      </div>

      {materialForm && (
        <form className="card management-form" onSubmit={saveMaterial}>
          <div className="card-title">{materialForm.id ? 'Editar material' : 'Nuevo material'}</div>
          <div className="responsive-form-grid">
            <div>
              <label className="field-label" htmlFor="catalog-material-name">Nombre *</label>
              <input id="catalog-material-name" className="field-input" value={materialForm.name} onChange={(event) => setMaterialForm({ ...materialForm, name: event.target.value })} />
            </div>
            <div>
              <label className="field-label" htmlFor="catalog-material-code">Código externo</label>
              <input id="catalog-material-code" className="field-input" value={materialForm.externalCode} onChange={(event) => setMaterialForm({ ...materialForm, externalCode: event.target.value })} />
            </div>
            <div>
              <label className="field-label" htmlFor="catalog-material-type">Tipo *</label>
              <select id="catalog-material-type" className="field-input" value={materialForm.materialType} onChange={(event) => setMaterialForm({ ...materialForm, materialType: event.target.value as MaterialType })}>
                {MATERIAL_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="catalog-material-unit">Unidad *</label>
              <input id="catalog-material-unit" className="field-input" value={materialForm.unit} onChange={(event) => setMaterialForm({ ...materialForm, unit: event.target.value })} placeholder="unidad, kg, L, m…" />
            </div>
            <div>
              <label className="field-label" htmlFor="catalog-measurement-method">Método de medición *</label>
              <select id="catalog-measurement-method" className="field-input" value={materialForm.measurementMethod} onChange={(event) => setMaterialForm({ ...materialForm, measurementMethod: event.target.value as MeasurementMethod })}>
                {MEASUREMENT_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn-primary button-auto" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar material'}</button>
            <button className="btn-secondary" type="button" disabled={busy} onClick={() => setMaterialForm(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="loading-screen">Cargando catálogo…</div>
      ) : visibleMaterials.length === 0 ? (
        <div className="card empty-state">No hay materiales que coincidan con los filtros.</div>
      ) : (
        <div className="catalog-list">
          {visibleMaterials.map((material) => {
            const variants = (material.catalog_variants || []).filter((variant) => showInactive || variant.active);
            const expanded = expandedId === material.id;
            return (
              <section key={material.id} className={`card catalog-material-card ${material.active ? '' : 'is-inactive'}`}>
                <div className="catalog-item-header">
                  <div>
                    <div className="catalog-title-row">
                      <span className="card-title">{material.name}</span>
                      <span className={`badge ${material.active ? 'badge-success' : 'badge-neutral'}`}>{material.active ? 'Activo' : 'Desactivado'}</span>
                    </div>
                    <div className="catalog-meta">
                      {typeLabel(material.material_type)} · {material.unit} · {methodLabel(material.measurement_method)}
                      {material.external_code ? ` · Código ${material.external_code}` : ''}
                    </div>
                  </div>
                  <div className="form-actions compact-actions">
                    <button className="btn-secondary" onClick={() => setExpandedId(expanded ? null : material.id)}>{expanded ? 'Ocultar variantes' : `Variantes (${variants.length})`}</button>
                    <button className="btn-secondary" onClick={() => { setMaterialForm(formFromMaterial(material)); setVariantForm(null); }}>Editar</button>
                    <button className={material.active ? 'btn-danger' : 'btn-success'} disabled={busy} onClick={() => void toggleMaterial(material)}>{material.active ? 'Desactivar' : 'Reactivar'}</button>
                  </div>
                </div>

                {expanded && (
                  <div className="catalog-variants">
                    <div className="subsection-header">
                      <strong>Variantes</strong>
                      <button className="btn-secondary" disabled={!material.active} onClick={() => { setVariantForm(emptyVariantForm(material.id)); setMaterialForm(null); }}>
                        + Agregar variante
                      </button>
                    </div>

                    {variantForm?.materialId === material.id && (
                      <form className="variant-form" onSubmit={saveVariant}>
                        <div className="responsive-form-grid">
                          <div>
                            <label className="field-label" htmlFor="variant-name">Nombre *</label>
                            <input id="variant-name" className="field-input" value={variantForm.displayName} onChange={(event) => setVariantForm({ ...variantForm, displayName: event.target.value })} />
                          </div>
                          <div>
                            <label className="field-label" htmlFor="variant-code">Código externo</label>
                            <input id="variant-code" className="field-input" value={variantForm.externalCode} onChange={(event) => setVariantForm({ ...variantForm, externalCode: event.target.value })} />
                          </div>
                          <div>
                            <label className="field-label" htmlFor="variant-diameter">Diámetro</label>
                            <input id="variant-diameter" className="field-input" value={variantForm.diameter} onChange={(event) => setVariantForm({ ...variantForm, diameter: event.target.value })} />
                          </div>
                          <div>
                            <label className="field-label" htmlFor="variant-length">Longitud (m)</label>
                            <input id="variant-length" className="field-input" type="number" min="0" step="any" value={variantForm.lengthM} onChange={(event) => setVariantForm({ ...variantForm, lengthM: event.target.value })} />
                          </div>
                          <div className="grid-span-full">
                            <label className="field-label" htmlFor="variant-dimensions">Especificación / dimensiones</label>
                            <input id="variant-dimensions" className="field-input" value={variantForm.dimensionText} onChange={(event) => setVariantForm({ ...variantForm, dimensionText: event.target.value })} />
                          </div>
                        </div>
                        <div className="form-actions">
                          <button className="btn-success" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar variante'}</button>
                          <button className="btn-secondary" type="button" disabled={busy} onClick={() => setVariantForm(null)}>Cancelar</button>
                        </div>
                      </form>
                    )}

                    {variants.length === 0 ? (
                      <p className="text-muted">No hay variantes visibles.</p>
                    ) : variants.map((variant) => (
                      <div className={`variant-row ${variant.active ? '' : 'is-inactive'}`} key={variant.id}>
                        <div>
                          <strong>{variant.display_name}</strong>
                          <div className="catalog-meta">
                            {[variant.external_code && `Código ${variant.external_code}`, variant.diameter && `Ø ${variant.diameter}`, variant.length_m != null && `${variant.length_m} m`, variant.dimension_text].filter(Boolean).join(' · ') || 'Sin dimensiones adicionales'}
                          </div>
                        </div>
                        <div className="form-actions compact-actions">
                          <span className={`badge ${variant.active ? 'badge-success' : 'badge-neutral'}`}>{variant.active ? 'Activa' : 'Desactivada'}</span>
                          <button className="btn-secondary" onClick={() => { setVariantForm(formFromVariant(variant)); setMaterialForm(null); }}>Editar</button>
                          <button className={variant.active ? 'btn-danger' : 'btn-success'} disabled={busy || !material.active} onClick={() => void toggleVariant(variant)}>{variant.active ? 'Desactivar' : 'Reactivar'}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
