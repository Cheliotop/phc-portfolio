import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { projectsApi } from '../api/supabase-projects';
import { operatorsApi } from '../api/supabase-operators';
import { catalogApi } from '../api/supabase-catalog';
import { productProjectsApi } from '../api/supabase-product-projects';
import { StatusBadge } from './StatusBadge';
import { normalizeStatus, statusLabel } from '../domain/projectStatus';
import { friendlyApiError } from '../api/supabase-api-errors';
import { parseDecimal } from '../utils/parseDecimal';
import { supabase } from '../lib/supabase';
import { operatorTeamLabel } from '../domain/operatorTeam';
import { parseBudgetText, type BudgetVariant, type RejectedBudgetLine } from '../domain/budgetImport';
import { materialTotalFromInput, projectEditTextFields, reactivationWarning } from '../domain/projectEdit';
import type {
  CatalogMaterial,
  MaterialLayer,
  MaterialReconciliation,
  OperatorDirectoryEntry,
  ProjectClosingAssignment,
  ProjectMaterialAssignment,
} from '../types/productV2';

interface ProjectRow {
  id: number;
  name: string;
  location?: string | null;
  well_name?: string | null;
  client?: string | null;
  coordinates?: string | null;
  assigned_operator_id?: string | null;
  target_depth?: number | null;
  default_bar_length?: number | null;
  default_bar_diameter?: string | null;
  progress_percentage?: number | null;
  status?: string | null;
}

interface ProjectForm {
  name: string;
  location: string;
  wellName: string;
  client: string;
  coordinates: string;
  assignedOperator: string;
  secondaryOperator: string;
  targetDepth: string;
  barLength: string;
  barDiameter: string;
}

interface ImportDraftLine {
  id: string;
  lineNumber: number;
  externalCode?: string;
  description: string;
  // null until the admin picks one reading of an ambiguous quantity such as "1.200".
  quantity: number | null;
  quantityChoices?: [number, number];
  unit: string;
  included: boolean;
  layer: MaterialLayer;
  catalogVariantId?: number;
  createNew: boolean;
}

type VariantOption = BudgetVariant;

const emptyProjectForm = (): ProjectForm => ({
  name: '', location: '', wellName: '', client: '', coordinates: '',
  assignedOperator: '', secondaryOperator: '', targetDepth: '', barLength: '6', barDiameter: '',
});

const normalize = (value?: string | null) => (value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLocaleLowerCase('es');

const operatorName = (operator?: OperatorDirectoryEntry | null) =>
  operator?.full_name || operator?.username || '—';

export const Proyectos = () => {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [operators, setOperators] = useState<OperatorDirectoryEntry[]>([]);
  const [secondaryOperatorsByProject, setSecondaryOperatorsByProject] = useState<Record<number, string[]>>({});
  const [catalog, setCatalog] = useState<CatalogMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectForm>(emptyProjectForm());
  const [editingProject, setEditingProject] = useState<ProjectRow | null>(null);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [materials, setMaterials] = useState<ProjectMaterialAssignment[]>([]);
  const [reconciliations, setReconciliations] = useState<MaterialReconciliation[]>([]);
  const [closingAssignment, setClosingAssignment] = useState<ProjectClosingAssignment | null>(null);
  const [closingOperator, setClosingOperator] = useState('');

  const [variantId, setVariantId] = useState('');
  const [assignQuantity, setAssignQuantity] = useState('');
  const [assignLayer, setAssignLayer] = useState<MaterialLayer>('presupuesto');
  const [assignNotes, setAssignNotes] = useState('');
  const [editMaterialId, setEditMaterialId] = useState<number | null>(null);
  const [editMaterialTotal, setEditMaterialTotal] = useState('');
  const [editMaterialNotes, setEditMaterialNotes] = useState('');
  const [returnDraft, setReturnDraft] = useState<Record<number, string>>({});
  const [reconcileNotes, setReconcileNotes] = useState<Record<number, string>>({});

  const [showImport, setShowImport] = useState(false);
  const [documentNumber, setDocumentNumber] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [importText, setImportText] = useState('');
  const [importLines, setImportLines] = useState<ImportDraftLine[]>([]);
  const [rejectedLines, setRejectedLines] = useState<RejectedBudgetLine[]>([]);

  const variants = useMemo<VariantOption[]>(() => catalog.flatMap((material) =>
    (material.catalog_variants || []).filter((variant) => material.active && variant.active).map((variant) => ({
      id: variant.id,
      label: normalize(variant.display_name) === 'estandar' ? material.name : `${material.name} · ${variant.display_name}`,
      code: variant.external_code || material.external_code,
      unit: material.unit,
    })),
  ), [catalog]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectRows, operatorRows, catalogRows] = await Promise.all([
        projectsApi.getAll({ orderBy: 'created_at', orderDir: 'desc' }) as Promise<ProjectRow[]>,
        operatorsApi.getAll(),
        catalogApi.getAll(false),
      ]);
      setProjects(projectRows);
      setOperators((operatorRows || []).filter((profile: any) => profile.role === 'operator') as OperatorDirectoryEntry[]);
      setCatalog(catalogRows);
      const projectIds = projectRows.map((project) => project.id);
      if (projectIds.length) {
        const { data: secondaryRows, error: secondaryError } = await supabase
          .from('project_secondary_operators')
          .select('project_id, operator_id')
          .in('project_id', projectIds);
        if (secondaryError) throw secondaryError;
        const grouped: Record<number, string[]> = {};
        for (const row of secondaryRows || []) {
          grouped[row.project_id] = [...(grouped[row.project_id] || []), row.operator_id];
        }
        setSecondaryOperatorsByProject(grouped);
      } else {
        setSecondaryOperatorsByProject({});
      }
    } catch (loadError) {
      setError(friendlyApiError(loadError, 'Error al cargar proyectos').message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The project the detail panel is showing. A slower reply for the one opened before
  // must not land here, where "Ajustar total" or "Desactivar" would act on that
  // project's materials (code read W10).
  const detailFor = useRef<number | null>(null);
  const loadDetail = useCallback(async (projectId: number) => {
    detailFor.current = projectId;
    setMaterials([]);
    setClosingAssignment(null);
    setClosingOperator('');
    setDetailLoading(true);
    setError(null);
    try {
      const [assignmentRows, reconciliationRows, closerRows] = await Promise.all([
        productProjectsApi.getMaterialAssignments(projectId, true),
        productProjectsApi.getReconciliations(projectId),
        productProjectsApi.getClosingAssignments(projectId),
      ]);
      if (detailFor.current !== projectId) return;
      setMaterials(assignmentRows);
      setReconciliations(reconciliationRows);
      setClosingAssignment(closerRows[0] || null);
      setClosingOperator(closerRows[0]?.operator_id || '');
      setReturnDraft(Object.fromEntries(reconciliationRows.map((row) => [row.project_material_id, String(row.returned_quantity)])));
      setReconcileNotes(Object.fromEntries(reconciliationRows.map((row) => [row.project_material_id, row.notes || ''])));
    } catch (detailError) {
      if (detailFor.current === projectId) setError(friendlyApiError(detailError, 'No se pudo cargar el proyecto').message);
    } finally {
      // Only the newest request may clear the loading state (a slower older reply must not).
      if (detailFor.current === projectId) setDetailLoading(false);
    }
  }, []);

  const toggleExpand = async (projectId: number) => {
    if (expandedId === projectId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(projectId);
    setVariantId(''); setAssignQuantity(''); setAssignNotes(''); setShowImport(false);
    await loadDetail(projectId);
  };

  const saveProject = async () => {
    const targetDepth = parseDecimal(projectForm.targetDepth);
    const barLength = parseDecimal(projectForm.barLength);
    if (projectForm.name.trim().length < 2) {
      setError('El nombre del proyecto es obligatorio.');
      return;
    }
    if (targetDepth !== undefined && (!Number.isFinite(targetDepth) || targetDepth <= 0)) {
      setError('La profundidad objetivo debe ser mayor que cero.');
      return;
    }
    if (barLength !== undefined && (!Number.isFinite(barLength) || barLength <= 0)) {
      setError('La longitud de barra debe ser mayor que cero.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: projectForm.name.trim(),
        location: projectForm.location.trim() || undefined,
        well_name: projectForm.wellName.trim() || undefined,
        client: projectForm.client.trim() || undefined,
        coordinates: projectForm.coordinates.trim() || undefined,
        assigned_operator_id: projectForm.assignedOperator || undefined,
        target_depth: targetDepth,
        default_bar_length: barLength,
        default_bar_diameter: projectForm.barDiameter.trim() || undefined,
      };
      if (editingProject) {
        await projectsApi.update(editingProject.id, {
          name: payload.name,
          ...projectEditTextFields(projectForm),
          // A cleared target depth is saved as empty; a cleared bar length keeps the old value.
          target_depth: targetDepth ?? null,
          ...(barLength !== undefined ? { default_bar_length: barLength } : {}),
          assigned_operator_id: projectForm.assignedOperator || null,
        });
        // Operador 2 changes in one server transaction (set_project_equipo), never as
        // separate writes that could stop halfway. Picking a new operador 2 replaces the
        // old one; making operador 2 the new operador 1 drops them as operador 2.
        const currentPartners = secondaryOperatorsByProject[editingProject.id] || [];
        const keptPartner = currentPartners.find((operatorId) => operatorId !== projectForm.assignedOperator) || null;
        if (projectForm.secondaryOperator || currentPartners.includes(projectForm.assignedOperator)) {
          await setProjectEquipo(editingProject.id, projectForm.assignedOperator || null, projectForm.secondaryOperator || keptPartner);
        }
        setNotice('Proyecto actualizado. Los cambios quedaron registrados en auditoría.');
      } else {
        const created = await projectsApi.create(payload);
        if (projectForm.secondaryOperator && projectForm.secondaryOperator !== projectForm.assignedOperator) {
          await setProjectEquipo(created.project_id, projectForm.assignedOperator || null, projectForm.secondaryOperator);
        }
        setNotice('Proyecto creado. Ahora podés asignar materiales del catálogo o importar el presupuesto.');
      }
      setShowCreate(false);
      setEditingProject(null);
      setProjectForm(emptyProjectForm());
      await load();
    } catch (saveError) {
      setError(friendlyApiError(saveError, 'No se pudo guardar el proyecto').message);
    } finally {
      setSaving(false);
    }
  };

  const setProjectEquipo = async (projectId: number, operatorId: string | null, partnerId: string | null) => {
    const { error: equipoError } = await supabase.rpc('set_project_equipo', {
      p_project_id: projectId, p_operator_id: operatorId, p_partner_id: partnerId,
    });
    if (equipoError) throw equipoError;
  };

  const startEditProject = (project: ProjectRow) => {
    setEditingProject(project);
    setProjectForm({
      name: project.name,
      location: project.location || '',
      wellName: project.well_name || '',
      client: project.client || '',
      coordinates: project.coordinates || '',
      assignedOperator: project.assigned_operator_id || '',
      secondaryOperator: '',
      targetDepth: project.target_depth != null ? String(project.target_depth) : '',
      barLength: project.default_bar_length != null ? String(project.default_bar_length) : '6',
      barDiameter: project.default_bar_diameter || '',
    });
    setShowCreate(true);
  };

  const removeSecondaryOperator = async (projectId: number, operatorId: string) => {
    setSaving(true);
    setError(null);
    try {
      const { error: deleteError } = await supabase.from('project_secondary_operators')
        .delete().eq('project_id', projectId).eq('operator_id', operatorId);
      if (deleteError) throw deleteError;
      setNotice('Operador quitado del equipo.');
      await load();
    } catch (removeError) {
      setError(friendlyApiError(removeError, 'No se pudo quitar el operador del equipo').message);
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (project: ProjectRow, status: string) => {
    let warning = status === 'cancelled' && normalizeStatus(project.status) === 'closure_submitted'
      ? ' Su Ficha ya fue enviada y queda sin firmar.'
      : '';
    if (status === 'active' && normalizeStatus(project.status) === 'cancelled') {
      const { count } = await supabase.from('completion_reports')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project.id)
        .eq('status', 'submitted');
      warning = reactivationWarning((count ?? 0) > 0);
    }
    if (!window.confirm(`¿Cambiar el estado de “${project.name}” a “${statusLabel(status)}”?${warning}`)) return;
    setSaving(true);
    setError(null);
    try {
      await projectsApi.update(project.id, { status });
      setNotice('Estado del proyecto actualizado.');
      await load();
    } catch (statusError) {
      setError(friendlyApiError(statusError, 'No se pudo cambiar el estado').message);
    } finally {
      setSaving(false);
    }
  };

  const saveCloser = async (projectId: number) => {
    if (!closingOperator) {
      setError('Seleccioná el operador responsable del cierre.');
      return;
    }
    setSaving(true);
    try {
      await productProjectsApi.setClosingOperator(projectId, closingOperator);
      setNotice('Responsable de Ficha asignado en el registro protegido.');
      await loadDetail(projectId);
    } catch (closerError) {
      setError(friendlyApiError(closerError, 'No se pudo asignar el cierre').message);
    } finally {
      setSaving(false);
    }
  };

  const assignMaterial = async (projectId: number) => {
    const quantity = Number(assignQuantity);
    if (!variantId || !(quantity > 0)) {
      setError('Seleccioná una variante del catálogo y una cantidad válida.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await productProjectsApi.assignCatalogMaterial({
        projectId,
        variantId: Number(variantId),
        quantity,
        layer: assignLayer,
        notes: assignNotes,
      });
      setVariantId(''); setAssignQuantity(''); setAssignNotes('');
      setNotice('Material asignado en la capa seleccionada.');
      await loadDetail(projectId);
    } catch (assignError) {
      setError(friendlyApiError(assignError, 'No se pudo asignar el material').message);
    } finally {
      setSaving(false);
    }
  };

  const updateAssignment = async (projectId: number, assignment: ProjectMaterialAssignment) => {
    const total = materialTotalFromInput(editMaterialTotal);
    if (total === null) {
      setError('Ingresá un total válido.');
      return;
    }
    setSaving(true);
    try {
      await productProjectsApi.updateMaterialAssignment(assignment.id, total, editMaterialNotes);
      setEditMaterialId(null); setEditMaterialTotal(''); setEditMaterialNotes('');
      setNotice('Total ajustado sin borrar el consumo histórico.');
      await loadDetail(projectId);
    } catch (updateError) {
      setError(friendlyApiError(updateError, 'No se pudo ajustar el material').message);
    } finally {
      setSaving(false);
    }
  };

  const deactivateAssignment = async (projectId: number, assignment: ProjectMaterialAssignment) => {
    const reason = window.prompt(`Motivo para desactivar “${assignment.material_name}” (no se borrará el historial):`);
    if (reason == null) return;
    if (reason.trim().length < 3) {
      setError('La desactivación requiere un motivo.');
      return;
    }
    setSaving(true);
    try {
      await productProjectsApi.deactivateMaterialAssignment(assignment.id, reason);
      setNotice('Asignación desactivada; historial preservado.');
      await loadDetail(projectId);
    } catch (removeError) {
      setError(friendlyApiError(removeError, 'No se pudo desactivar el material').message);
    } finally {
      setSaving(false);
    }
  };

  const saveReconciliation = async (projectId: number, assignment: ProjectMaterialAssignment) => {
    const returned = Number(returnDraft[assignment.id] || 0);
    if (!(returned >= 0)) {
      setError('La devolución debe ser cero o mayor.');
      return;
    }
    setSaving(true);
    try {
      await productProjectsApi.saveReconciliation({
        projectId,
        projectMaterialId: assignment.id,
        returnedQuantity: returned,
        notes: reconcileNotes[assignment.id],
      });
      setNotice('Reconciliación guardada; faltantes calculados por el servidor.');
      await loadDetail(projectId);
    } catch (reconcileError) {
      setError(friendlyApiError(reconcileError, 'No se pudo reconciliar').message);
    } finally {
      setSaving(false);
    }
  };

  const parseImport = () => {
    const result = parseBudgetText(importText, variants);
    setRejectedLines(result.rejected);
    if (!result.lines.length) {
      setImportLines([]);
      setError(result.rejected.length
        ? `Ninguna línea se pudo importar. Revisá las ${result.rejected.length} línea(s) rechazadas abajo.`
        : 'No se detectaron líneas. Usá: código, descripción, cantidad, unidad. Las columnas posteriores se ignoran.');
      return;
    }
    setImportLines(result.lines.map((line) => ({ ...line, included: true, layer: 'presupuesto' as const })));
    setError(null);
  };

  const loadImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSourceName(file.name);
    setImportText(await file.text());
    setImportLines([]);
    setRejectedLines([]);
  };

  const updateImportLine = (id: string, patch: Partial<ImportDraftLine>) => {
    setImportLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const submitImport = async (projectId: number) => {
    if (documentNumber.trim().length < 2 || !importLines.some((line) => line.included)) {
      setError('Indicá el número de documento e incluí al menos una línea.');
      return;
    }
    const invalid = importLines.find((line) => line.included && !line.catalogVariantId && !line.createNew);
    if (invalid) {
      setError(`Mapeá “${invalid.description}” al catálogo o marcá “crear nuevo”.`);
      return;
    }
    const unresolved = importLines.find((line) => line.quantity === null);
    if (unresolved) {
      setError(`Elegí la cantidad de “${unresolved.description}” (línea ${unresolved.lineNumber}): el número es ambiguo.`);
      return;
    }
    setSaving(true);
    try {
      await productProjectsApi.importMaterials({
        projectId,
        documentNumber,
        sourceName,
        lines: importLines.map((line) => ({
          externalCode: line.externalCode,
          description: line.description,
          quantity: line.quantity as number,
          unit: line.unit,
          included: line.included,
          layer: line.layer,
          catalogVariantId: line.catalogVariantId,
          createNew: line.createNew,
          materialType: 'other' as const,
          measurementMethod: 'quantity' as const,
        })),
      });
      setNotice('Presupuesto importado sin precios. La trazabilidad del documento y las líneas quedó guardada.');
      setShowImport(false); setDocumentNumber(''); setSourceName(''); setImportText(''); setImportLines([]); setRejectedLines([]);
      await loadDetail(projectId);
      await load();
    } catch (importError) {
      setError(friendlyApiError(importError, 'No se pudo importar el presupuesto').message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="card-header management-toolbar">
        <div>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Proyectos</h2>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>Pozos, responsables, presupuesto, extras y reconciliación</p>
        </div>
        <button className="btn-primary button-auto" onClick={() => { setEditingProject(null); setProjectForm(emptyProjectForm()); setShowCreate(true); }}>+ Nuevo proyecto</button>
      </div>
      {error && <div className="login-error" role="alert">{error}</div>}
      {notice && <div className="success-message" role="status">{notice}</div>}

      {loading ? <div className="loading-screen">Cargando proyectos…</div> : projects.length === 0 ? (
        <div className="card"><p className="text-muted">No hay proyectos.</p></div>
      ) : (
        <div className="project-v2-list">
          {projects.map((project) => {
            const status = normalizeStatus(project.status);
            const closer = closingAssignment?.project_id === project.id
              ? operators.find((operator) => operator.id === closingAssignment.operator_id)
              : null;
            return (
              <article className="card project-v2-card" key={project.id}>
                <div className="section-title-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="well-icon"><svg viewBox="0 0 24 24"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/></svg></div>
                    <div>
                      <div className="card-title">{project.well_name || project.name}</div>
                      <div className="card-subtitle">{project.location || 'Sin ubicación'} · {project.client || 'Sin cliente'}</div>
                    </div>
                  </div>
                  <div className="flag-summary"><StatusBadge status={project.status || 'active'} /><span className="badge badge-neutral">{project.progress_percentage || 0}%</span></div>
                </div>
                <div className="project-summary-grid">
                  <span><strong>Equipo:</strong> {operatorTeamLabel(project.assigned_operator_id, secondaryOperatorsByProject[project.id] || [], operators)}</span>
                  <span><strong>Objetivo:</strong> {project.target_depth ?? '—'} m</span>
                  <span><strong>Barra:</strong> {project.default_bar_length ?? '—'} m · {project.default_bar_diameter || 'sin diámetro'}</span>
                  <span><strong>Coordenadas:</strong> {project.coordinates || '—'}</span>
                </div>
                <div className="form-actions">
                  <button className="btn-secondary" onClick={() => void toggleExpand(project.id)}>{expandedId === project.id ? 'Ocultar operación' : 'Gestionar operación'}</button>
                  {status !== 'completed' ? <button className="btn-secondary" onClick={() => startEditProject(project)}>Editar proyecto</button> : null}
                  {status === 'cancelled' ? <button className="btn-success" disabled={saving} onClick={() => void setStatus(project, 'active')}>Reactivar</button> : status === 'planning' ? <><button className="btn-success" disabled={saving} onClick={() => void setStatus(project, 'active')}>Iniciar proyecto</button><button className="btn-danger" disabled={saving} onClick={() => void setStatus(project, 'cancelled')}>Cancelar</button></> : status !== 'completed' ? <button className="btn-danger" disabled={saving} onClick={() => void setStatus(project, 'cancelled')}>Cancelar</button> : null}
                </div>

                {expandedId === project.id && (
                  <div className="project-detail">
                    <p className="text-muted"><strong>Equipo:</strong> {operatorTeamLabel(project.assigned_operator_id, secondaryOperatorsByProject[project.id] || [], operators)}</p>
                    {detailLoading ? <div className="loading-screen">Cargando operación…</div> : (
                      <>
                        <section className="project-subsection">
                          <div className="subsection-header"><div><h3>Responsable de Ficha</h3><p className="text-muted">Registro protegido; no se expone a otros operadores.</p></div>{closer && <span className="badge badge-active">Actual: {operatorName(closer)}</span>}</div>
                          <div className="form-row"><select className="field-input" value={closingOperator} onChange={(event) => setClosingOperator(event.target.value)}><option value="">Seleccionar operador…</option>{operators.filter((operator) => operator.is_active).map((operator) => <option key={operator.id} value={operator.id}>{operatorName(operator)}</option>)}</select><button className="btn-primary button-auto" disabled={saving} onClick={() => void saveCloser(project.id)}>Asignar cierre</button></div>
                        </section>

                        <section className="project-subsection">
                          <div className="subsection-header"><div><h3>Materiales del proyecto</h3><p className="text-muted">Dos capas independientes: presupuesto y extras.</p></div><button className="btn-secondary" onClick={() => setShowImport((current) => !current)}>Importar presupuesto</button></div>
                          {variants.length === 0 ? (
                            <p className="text-muted">Todavía no hay materiales en el catálogo. Andá a la pestaña Catálogo y agregá uno antes de asignar. <a href="#/catalogo">Ir a Catálogo</a></p>
                          ) : (
                            <>
                              <div className="responsive-form-grid material-assign-form">
                                <div className="grid-span-full"><label className="field-label">Variante del catálogo</label><select className="field-input" value={variantId} onChange={(event) => setVariantId(event.target.value)}><option value="">Seleccionar…</option>{variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}{variant.code ? ` · ${variant.code}` : ''}</option>)}</select></div>
                                <div><label className="field-label">Cantidad</label><input className="field-input" type="number" min="0" step="any" value={assignQuantity} onChange={(event) => setAssignQuantity(event.target.value)} /></div>
                                <div><label className="field-label">Capa</label><select className="field-input" value={assignLayer} onChange={(event) => setAssignLayer(event.target.value as MaterialLayer)}><option value="presupuesto">Presupuesto</option><option value="extras">Extras</option></select></div>
                                <div className="grid-span-full"><label className="field-label">Nota</label><input className="field-input" value={assignNotes} onChange={(event) => setAssignNotes(event.target.value)} /></div>
                              </div>
                              <button className="btn-primary button-auto" disabled={saving} onClick={() => void assignMaterial(project.id)}>Asignar material</button>
                            </>
                          )}

                          {showImport && (
                            <div className="import-panel">
                              <div className="responsive-form-grid"><div><label className="field-label">N.º de documento *</label><input className="field-input" value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} /></div><div><label className="field-label">Archivo de origen</label><input className="field-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(event) => void loadImportFile(event)} /></div></div>
                              <label className="field-label">Líneas: código, descripción, cantidad, unidad</label>
                              <textarea className="field-input import-text" value={importText} onChange={(event) => { setImportText(event.target.value); setImportLines([]); setRejectedLines([]); }} placeholder={'MAT-01;Tubería PVC 6";100;m\nMAT-02;Cemento;20;bolsa'} />
                              <p className="text-muted">Columnas de precio, impuestos y saldos posteriores a la unidad se descartan y nunca se envían. Los números usan el formato paraguayo: 1.234,56 es 1234,56.</p>
                              <button className="btn-secondary" onClick={parseImport}>Revisar y mapear líneas</button>
                              {rejectedLines.length > 0 && (
                                <div className="login-error" role="alert">
                                  <strong>{rejectedLines.length} línea(s) no se importaron:</strong>
                                  <ul>{rejectedLines.map((rejected) => <li key={rejected.lineNumber}>Línea {rejected.lineNumber}: {rejected.reason} <span className="catalog-meta">«{rejected.raw}»</span></li>)}</ul>
                                </div>
                              )}
                              {importLines.map((line) => <div className="import-line" key={line.id}><label className="checkbox-row"><input type="checkbox" checked={line.included} onChange={(event) => updateImportLine(line.id, { included: event.target.checked })} /> Incluir</label><strong>{line.description}</strong>{line.quantity !== null ? <span>{line.quantity} {line.unit} · {line.externalCode || 'sin código'}</span> : <span className="login-error">Línea {line.lineNumber}: elegí la cantidad. Puede ser {line.quantityChoices?.[0]} o {String(line.quantityChoices?.[1]).replace('.', ',')} {line.unit}.</span>}{line.quantity === null && <select className="field-input" value="" onChange={(event) => updateImportLine(line.id, { quantity: Number(event.target.value) })}><option value="">Elegí la cantidad…</option>{line.quantityChoices?.map((choice) => <option key={choice} value={choice}>{choice} {line.unit}</option>)}</select>}<select className="field-input" value={line.catalogVariantId || ''} onChange={(event) => updateImportLine(line.id, { catalogVariantId: event.target.value ? Number(event.target.value) : undefined, createNew: !event.target.value })}><option value="">Crear material nuevo</option>{variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}</select><select className="field-input" value={line.layer} onChange={(event) => updateImportLine(line.id, { layer: event.target.value as MaterialLayer })}><option value="presupuesto">Presupuesto</option><option value="extras">Extras</option></select></div>)}
                              {importLines.length > 0 && <button className="btn-success" disabled={saving} onClick={() => void submitImport(project.id)}>Confirmar importación sin precios</button>}
                            </div>
                          )}

                          {materials.length === 0 ? <p className="text-muted">Sin materiales asignados.</p> : (
                            <div className="table-scroll"><table><thead><tr><th>Material</th><th>Capa</th><th>Enviado</th><th>Consumido</th><th>Saldo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{materials.map((assignment) => {
                              const sent = Number(assignment.initial_quantity ?? assignment.quantity_allocated ?? 0);
                              const current = Number(assignment.current_quantity || 0);
                              const consumed = sent - current;
                              return <tr key={assignment.id} className={assignment.active ? '' : 'inactive-row'}><td>{assignment.material_name}<div className="catalog-meta">{assignment.unit || 'unidad'}</div></td><td><span className={`badge ${assignment.layer === 'presupuesto' ? 'badge-active' : 'badge-warning'}`}>{assignment.layer}</span></td><td>{sent}</td><td>{consumed}</td><td className={current < 0 ? 'danger-text' : ''}>{current}</td><td>{assignment.active ? 'Activo' : 'Desactivado'}</td><td>{assignment.active && (editMaterialId === assignment.id ? <div className="assignment-edit"><input className="field-input" type="number" step="any" value={editMaterialTotal} onChange={(event) => setEditMaterialTotal(event.target.value)} /><input className="field-input" value={editMaterialNotes} onChange={(event) => setEditMaterialNotes(event.target.value)} placeholder="Motivo/nota" /><button className="btn-success" onClick={() => void updateAssignment(project.id, assignment)}>Guardar</button><button className="btn-secondary" onClick={() => setEditMaterialId(null)}>Cancelar</button></div> : <div className="actions-cell"><button className="btn-secondary" onClick={() => { setEditMaterialId(assignment.id); setEditMaterialTotal(String(sent)); setEditMaterialNotes(assignment.notes || ''); }}>Ajustar total</button><button className="btn-danger" onClick={() => void deactivateAssignment(project.id, assignment)}>Desactivar</button></div>)}</td></tr>;
                            })}</tbody></table></div>
                          )}
                        </section>

                        <section className="project-subsection">
                          <h3>Reconciliación para cierre</h3>
                          <p className="text-muted">Enviado − consumido − devuelto = faltante. La firma se bloquea hasta reconciliar cada material activo.</p>
                          {materials.filter((item) => item.active).map((assignment) => {
                            const existing = reconciliations.find((row) => row.project_material_id === assignment.id);
                            return <div className="reconcile-row" key={assignment.id}><div><strong>{assignment.material_name}</strong><div className="catalog-meta">Enviado {assignment.initial_quantity} · saldo {assignment.current_quantity} {assignment.unit || ''}{existing ? ` · faltante ${existing.missing_quantity}` : ' · pendiente'}</div></div><input className="field-input" type="number" min="0" step="any" value={returnDraft[assignment.id] || ''} onChange={(event) => setReturnDraft({ ...returnDraft, [assignment.id]: event.target.value })} placeholder="Devuelto" /><input className="field-input" value={reconcileNotes[assignment.id] || ''} onChange={(event) => setReconcileNotes({ ...reconcileNotes, [assignment.id]: event.target.value })} placeholder="Nota" /><button className="btn-secondary" onClick={() => void saveReconciliation(project.id, assignment)}>Guardar</button></div>;
                          })}
                        </section>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
          <div className="modal-card project-modal">
            <h3 id="project-form-title" className="card-title">{editingProject ? 'Editar proyecto' : 'Nuevo proyecto'}</h3>
            <div className="responsive-form-grid">
              <div><label className="field-label">Nombre *</label><input className="field-input" value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} /></div>
              <div><label className="field-label">Nombre del pozo</label><input className="field-input" value={projectForm.wellName} onChange={(event) => setProjectForm({ ...projectForm, wellName: event.target.value })} /></div>
              <div><label className="field-label">Ubicación</label><input className="field-input" value={projectForm.location} onChange={(event) => setProjectForm({ ...projectForm, location: event.target.value })} /></div>
              <div><label className="field-label">Cliente</label><input className="field-input" value={projectForm.client} onChange={(event) => setProjectForm({ ...projectForm, client: event.target.value })} /></div>
              <div><label className="field-label">Coordenadas</label><input className="field-input" value={projectForm.coordinates} onChange={(event) => setProjectForm({ ...projectForm, coordinates: event.target.value })} /></div>
              <div><label className="field-label">Operador 1</label><select className="field-input" value={projectForm.assignedOperator} onChange={(event) => setProjectForm({ ...projectForm, assignedOperator: event.target.value, secondaryOperator: event.target.value === projectForm.secondaryOperator ? '' : projectForm.secondaryOperator })}><option value="">Sin asignar</option>{operators.filter((operator) => operator.is_active || operator.id === projectForm.assignedOperator).map((operator) => <option key={operator.id} value={operator.id}>{operatorName(operator)}{operator.is_active ? '' : ' (inactivo)'}</option>)}</select></div>
              <div>
                <label className="field-label">Operador 2 (equipo)</label>
                <select className="field-input" value={projectForm.secondaryOperator} onChange={(event) => setProjectForm({ ...projectForm, secondaryOperator: event.target.value })}>
                  <option value="">{editingProject && (secondaryOperatorsByProject[editingProject.id] || []).length ? 'Sin cambios' : 'Sin operador 2'}</option>
                  {operators.filter((operator) => operator.is_active && operator.id !== projectForm.assignedOperator
                    && !(editingProject && (secondaryOperatorsByProject[editingProject.id] || []).includes(operator.id)))
                    .map((operator) => <option key={operator.id} value={operator.id}>{operatorName(operator)}</option>)}
                </select>
                {editingProject && (secondaryOperatorsByProject[editingProject.id] || []).map((operatorId) => (
                  <div className="catalog-title-row" key={operatorId} style={{ marginTop: 8 }}>
                    <span>{operatorName(operators.find((operator) => operator.id === operatorId))}</span>
                    <button type="button" className="btn-danger" disabled={saving} onClick={() => void removeSecondaryOperator(editingProject.id, operatorId)}>Quitar</button>
                  </div>
                ))}
              </div>
              <div><label className="field-label">Profundidad objetivo (m)</label><input className="field-input" type="number" min="0" step="any" value={projectForm.targetDepth} onChange={(event) => setProjectForm({ ...projectForm, targetDepth: event.target.value })} /></div>
              <div><label className="field-label">Longitud de barra (m)</label><input className="field-input" type="number" min="0" step="any" value={projectForm.barLength} onChange={(event) => setProjectForm({ ...projectForm, barLength: event.target.value })} /></div>
              <div><label className="field-label">Diámetro de barra</label><input className="field-input" value={projectForm.barDiameter} onChange={(event) => setProjectForm({ ...projectForm, barDiameter: event.target.value })} /></div>
            </div>
            <div className="form-actions"><button className="btn-secondary" onClick={() => { setShowCreate(false); setEditingProject(null); }}>Cancelar</button><button className="btn-primary button-auto" disabled={saving} onClick={() => void saveProject()}>{saving ? 'Guardando…' : 'Guardar proyecto'}</button></div>
          </div>
        </div>
      )}
    </div>
  );
};
