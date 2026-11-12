import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { execute, query, runInTransaction } from '../../db/db';
import { materialsApi } from '../../api/supabase-materials';
import { operatorsApi } from '../../api/supabase-operators';
import { projectsApi } from '../../api/supabase-projects';
import { normalizeStatus, statusLabel } from '../../domain/projectStatus';
import { adminErrorText } from '../../domain/adminErrors';
import { drillingBarsApi } from '../../api/supabase-drilling-bars';
import { productV2Api } from '../../api/supabase-product-v2';
import { shiftsApi } from '../../api/supabase-shifts';
import { operator2ErrorMessage } from './operatorMessages';
import { mirrorProjectMaterial, mirrorProjectMaterials } from '../../db/repositories/projectMaterials';
import { mirrorProjects } from '../../db/repositories/projects';
import { ensureOperatorStub, mirrorOperator } from '../../db/repositories/operators';
import { mirrorMaterialConsumptions } from '../../db/repositories/materialConsumption';
import { ADMIN_LIST_PAGE_SIZE, adminSharedStyles } from './adminSharedStyles';
import type { AdminTabNavigationProp } from '../../navigation/types';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { showSheet } from '../shared/Sheet';
import ProjectPhotosModal from './ProjectPhotosModal';

// Projects Tab Component
const ProjectsTab = () => {
  const navigation = useNavigation<AdminTabNavigationProp<'Projects'>>();
  const [projects, setProjects] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<any | null>(null);
  // Held separately from selectedProject: the gallery is read-only and must not
  // disturb the material/edit modals, which share that slot.
  const [photosProject, setPhotosProject] = useState<any | null>(null);
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [operators, setOperators] = useState<any[]>([]);
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const [materialAssignments, setMaterialAssignments] = useState<any[]>([]);
  const [consumptionHistory, setConsumptionHistory] = useState<any[]>([]);
  const [projectForm, setProjectForm] = useState({
    name: '',
    wellName: '',
    client: '',
    location: '',
    coordinates: '',
    assignedOperator: '',
    targetDepth: '',
    defaultBarLength: '3',
    defaultBarDiameter: '',
  });
  const [assignmentForm, setAssignmentForm] = useState({
    materialName: '',
    quantity: '',
    notes: ''
  });
  // Catalog unit per option label. The server books the assignment in this unit;
  // the phone shows it and never sends its own.
  const [catalogUnits, setCatalogUnits] = useState<Record<string, string>>({});
  const [editingProject, setEditingProject] = useState<any | null>(null);
  const [editProjectForm, setEditProjectForm] = useState({
    name: '',
    location: '',
    assignedOperator: '',
    targetDepth: '',
  });
  const [savingProjectEdit, setSavingProjectEdit] = useState(false);
  // Errors raised while the edit sheet is open are shown inside it: a banner on the
  // screen underneath would be hidden by the modal.
  const [editError, setEditError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [materialError, setMaterialError] = useState<string | null>(null);
  // Closing operator ("Ficha técnica"). Until this is assigned the operator's
  // Cierre tab reads "Sin cierres asignados" and the well can never be closed —
  // and the only UI for it lived in the web admin, so a well drilled on mobile
  // could not be finished on mobile.
  const [closingOperator, setClosingOperator] = useState('');
  // The equipo (operador 2 and closer) loads with the well. Until it has loaded,
  // saving is refused: a save that did not know the current operador 2 would drop it.
  const [equipoReady, setEquipoReady] = useState(false);
  const [equipoLoadError, setEquipoLoadError] = useState(false);
  // What the server holds for this well; "Guardar cambios" writes only what differs.
  const editBaselineRef = useRef({ operator: '', partner: '', closer: '', name: '', location: '', targetDepth: '' });
  const [catalogOptions, setCatalogOptions] = useState<string[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  // Secondary rows represent additional members of the well's crew.
  const [secondaryOperators, setSecondaryOperators] = useState<string[]>([]);
  const [editingAssignmentId, setEditingAssignmentId] = useState<number | null>(null);
  // A second tap while a create or an assignment is on its way would create a second
  // well, or book the material twice: the server adds to an active row.
  const [creatingProject, setCreatingProject] = useState(false);
  const [assigningMaterial, setAssigningMaterial] = useState(false);
  // The well the materials modal is showing. A slower reply for the previous well
  // must not land under this one, where "Quitar" or a new total would act on it.
  const materialModalProjectId = useRef<number | string | null>(null);
  const editingProjectId = useRef<number | string | null>(null);
  const [editAssignmentTotal, setEditAssignmentTotal] = useState('');
  const [projectPage, setProjectPage] = useState(1);
  const [hasMoreProjects, setHasMoreProjects] = useState(true);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);

  // Android's <Modal> is implemented as a separate Dialog created with
  // FLAG_NOT_FOCUSABLE, cleared only after the dialog is shown
  // (ReactModalHostView.kt). Instrumented on-device testing (timestamped
  // onFocus/onBlur logs read back from logcat) showed this produces a
  // ONE-TIME native focus-reassignment event roughly 200-500ms after the
  // FIRST TextInput inside the modal gains focus — not a fixed delay after
  // the modal appears, and not specific to programmatic vs touch-originated
  // focus, or to a freshly-mounted vs previously-existing widget. It blurs
  // whatever is focused at that moment with no onChangeText, no remount, no
  // state transition.
  //
  // Fix, in two parts:
  //  1. A brief same-sized placeholder renders before the real TextInput
  //     mounts, so the field's first-ever focus (and therefore the one-time
  //     blur race it triggers) happens on a predictable schedule early in
  //     the modal's lifecycle, well before a realistic user's first
  //     keystroke (~800ms-1s).
  //  2. A single plain `.focus()` recovery — deliberately NOT touching
  //     `setNativeProps`/`selection`, which earlier attempts showed
  //     corrupts in-flight characters — fires once if that blur happens.
  //     On-device testing confirmed the field is then stable indefinitely
  //     (no further blurs). The recovery is time-boxed to a window after
  //     the field's first focus and fires at most once per modal-open, so
  //     it never fights a deliberate later blur (e.g. the user tabbing to
  //     another field).
  const MODAL_FIELD_SETTLE_MS = 100;
  const RECOVERY_WINDOW_MS = 900;

  const [createProjectFieldReady, setCreateProjectFieldReady] = useState(false);
  const createProjectNameInputRef = useRef<TextInput | null>(null);
  const createProjectLifecycleRef = useRef(0);
  const createProjectFocusedAtRef = useRef<number | null>(null);
  const createProjectRecoveredRef = useRef(false);

  const [editProjectFieldReady, setEditProjectFieldReady] = useState(false);
  const [editProjectSelection, setEditProjectSelection] = useState<
    { start: number; end: number } | undefined
  >(undefined);
  const editProjectNameInputRef = useRef<TextInput | null>(null);
  const editProjectLifecycleRef = useRef(0);
  const editProjectInitialNameRef = useRef('');
  const editProjectFocusedAtRef = useRef<number | null>(null);
  const editProjectRecoveredRef = useRef(false);


  useEffect(() => {
    if (createProjectFieldReady) createProjectNameInputRef.current?.focus();
  }, [createProjectFieldReady]);

  useEffect(() => {
    if (!editProjectFieldReady) return;
    editProjectNameInputRef.current?.focus();
    // Android does not reliably honor the `selection` prop on a TextInput's
    // very first render (a known RN/Android quirk: there is no previous
    // selection to diff against, so the initial caret position can be
    // silently ignored and default to 0). Keep `selection` CONTROLLED
    // (unchanging, still pointing at end-of-text) for a short fixed window
    // after mount so native has multiple render passes to actually apply
    // it, then release control back to normal user-driven cursor movement.
    // Nothing has been typed yet during this window, so there is no
    // in-flight onChangeText to race with (the corruption seen in earlier
    // attempts came from touching selection AFTER the user started typing).
    const lifecycle = editProjectLifecycleRef.current;
    const releaseTimer = setTimeout(() => {
      if (editProjectLifecycleRef.current === lifecycle) {
        setEditProjectSelection(undefined);
      }
    }, 300);
    return () => clearTimeout(releaseTimer);
  }, [editProjectFieldReady]);

  const handleCreateProjectFieldFocus = () => {
    if (createProjectFocusedAtRef.current === null) createProjectFocusedAtRef.current = Date.now();
  };

  const handleCreateProjectFieldBlur = () => {
    const focusedAt = createProjectFocusedAtRef.current;
    if (
      createProjectRecoveredRef.current ||
      focusedAt === null ||
      Date.now() - focusedAt > RECOVERY_WINDOW_MS
    ) return;
    createProjectRecoveredRef.current = true;
    const lifecycle = createProjectLifecycleRef.current;
    setTimeout(() => {
      if (createProjectLifecycleRef.current === lifecycle) {
        createProjectNameInputRef.current?.focus();
      }
    }, 60);
  };

  const handleEditProjectFieldFocus = () => {
    if (editProjectFocusedAtRef.current === null) editProjectFocusedAtRef.current = Date.now();
  };

  const handleEditProjectFieldBlur = () => {
    const focusedAt = editProjectFocusedAtRef.current;
    if (
      editProjectRecoveredRef.current ||
      focusedAt === null ||
      Date.now() - focusedAt > RECOVERY_WINDOW_MS
    ) return;
    editProjectRecoveredRef.current = true;
    const lifecycle = editProjectLifecycleRef.current;
    setTimeout(() => {
      if (editProjectLifecycleRef.current === lifecycle) {
        editProjectNameInputRef.current?.focus();
      }
    }, 60);
  };

  const updateProjectFormField = (field: keyof typeof projectForm, text: string) => {
    setProjectForm((form) => ({ ...form, [field]: text }));
  };

  const closeProjectModal = () => {
    createProjectLifecycleRef.current += 1;
    setCreateProjectFieldReady(false);
    setShowProjectModal(false);
  };

  const armCreateProjectField = () => {
    createProjectLifecycleRef.current += 1;
    setCreateProjectFieldReady(false);
    createProjectFocusedAtRef.current = null;
    createProjectRecoveredRef.current = false;
  };

  const handleCreateProjectModalShow = () => {
    const lifecycle = createProjectLifecycleRef.current;
    setTimeout(() => {
      if (createProjectLifecycleRef.current === lifecycle) {
        setCreateProjectFieldReady(true);
      }
    }, MODAL_FIELD_SETTLE_MS);
  };

  const closeEditProjectModal = () => {
    setEditError(null);
    editProjectLifecycleRef.current += 1;
    setEditProjectFieldReady(false);
    setEditProjectSelection(undefined);
    setEditingProject(null);
  };

  const armEditProjectField = () => {
    editProjectLifecycleRef.current += 1;
    setEditProjectFieldReady(false);
    setEditProjectSelection(undefined);
    editProjectFocusedAtRef.current = null;
    editProjectRecoveredRef.current = false;
  };

  const handleEditProjectModalShow = () => {
    const lifecycle = editProjectLifecycleRef.current;
    setTimeout(() => {
      if (editProjectLifecycleRef.current === lifecycle) {
        const end = editProjectInitialNameRef.current.length;
        setEditProjectSelection({ start: end, end });
        setEditProjectFieldReady(true);
      }
    }, MODAL_FIELD_SETTLE_MS);
  };

  const closeMaterialModal = () => {
    setShowMaterialModal(false);
  };

  const openCatalog = () => {
    closeMaterialModal();
    navigation.navigate('Catalog');
  };

  const loadProjects = async (page = 1, append = false) => {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        let serverProjects: any[] | null = null;
        const token = await AsyncStorage.getItem('authToken');
        if (token) {
          try {
            serverProjects = await projectsApi.getAll({
              page,
              pageSize: ADMIN_LIST_PAGE_SIZE,
              orderBy: 'updated_at',
              orderDir: 'desc',
            });
            const currentTime = new Date().toISOString();
            await runInTransaction(async (transaction) => {
              await mirrorProjects(serverProjects, currentTime, transaction.execute);
            });
            setProjectPage(page);
            setHasMoreProjects(serverProjects.length === ADMIN_LIST_PAGE_SIZE);
          } catch (error) {
            console.warn('[PHC] Could not refresh projects from server:', error);
          }
        }

        const pageIds = serverProjects?.map((project) => project.id) || [];
        const pageFilter = serverProjects
          ? `AND p.id IN (${pageIds.map(() => '?').join(',') || 'NULL'})`
          : '';
        const result = await query<any>(`
          SELECT
            p.*,
            o.name as operator_name,
            COALESCE(MAX(dbe.depth_end), MAX(pl.depth_end), 0) as current_depth,
            p.progress as progress_percentage
          FROM projects p
          LEFT JOIN operators o ON p.assigned_operator_id = o.id
          LEFT JOIN progress_logs_dashboard pl ON p.id = pl.project_id
          LEFT JOIN drilling_bar_entries dbe ON p.id = dbe.project_id
          WHERE p.deleted = 0
          ${pageFilter}
          GROUP BY p.id
          ORDER BY p.updated_at DESC, p.id DESC
        `, pageIds);

        const serverDepths = serverProjects
          ? await drillingBarsApi.getMaxDepths(pageIds).catch(() => new Map<string, number>())
          : new Map<string, number>();
        for (const row of result || []) {
          row.current_depth = Math.max(Number(row.current_depth || 0), serverDepths.get(String(row.id)) ?? 0);
        }
        setProjects((current) => {
          if (!append || !serverProjects) return result || [];
          const merged = new Map(current.map((project) => [String(project.id), project]));
          for (const project of result || []) merged.set(String(project.id), project);
          return Array.from(merged.values());
        });
        if (!serverProjects) setHasMoreProjects(false);
        setLastError(null);
        return;
      } catch (error: any) {
        console.error(`[PHC] Error loading projects (attempt ${attempt}):`, error);

        if (attempt === MAX_RETRIES) {
          setLastError(`Error al cargar proyectos: ${adminErrorText(error)}`);
          throw error;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  };

  const loadOperators = async () => {
    setOperatorsLoading(true);
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        try {
          const serverOperators = await operatorsApi.getAllActivePages();
          const currentTime = new Date().toISOString();
          await runInTransaction(async (transaction) => {
            for (const operator of serverOperators || []) {
              await mirrorOperator({
                id: String(operator.id),
                fullName: operator.full_name,
                username: operator.username,
                isActive: operator.is_active,
                createdAt: operator.created_at,
                currentTime,
              }, transaction.execute);
            }
          });
          setOperators(serverOperators || []);
          return;
        } catch (error) {
          console.warn('[PHC] Could not load server operators:', error);
        }
      }

      const localOperators = await query<any>(
        `SELECT id, name, name as full_name, role, status
         FROM operators
         WHERE status = 'active'
         ORDER BY name`
      );
      setOperators(localOperators || []);
    } catch (error) {
      console.error('[PHC] Error loading operators for project form:', error);
      setOperators([]);
    } finally {
      setOperatorsLoading(false);
    }
  };

  const resetProjectForm = () => {
    setProjectForm({
      name: '',
      wellName: '',
      client: '',
      location: '',
      coordinates: '',
      assignedOperator: '',
      targetDepth: '',
      defaultBarLength: '3',
      defaultBarDiameter: '',
    });
  };

  const openEditProject = (project: any) => {
    setEditError(null);
    loadOperators();
    const initialName = project.name || '';
    editProjectInitialNameRef.current = initialName;
    armEditProjectField();
    const operatorId = project.assigned_operator_id ? String(project.assigned_operator_id) : '';
    const initialLocation = project.location || '';
    const initialDepth = project.target_depth != null ? String(project.target_depth) : '';
    setEditProjectForm({
      name: initialName,
      location: initialLocation,
      assignedOperator: operatorId,
      targetDepth: initialDepth,
    });
    // A slower reply for the well edited before must not land under this one.
    editingProjectId.current = project.id;
    editBaselineRef.current = {
      operator: operatorId,
      partner: '',
      closer: '',
      name: initialName,
      location: initialLocation,
      targetDepth: initialDepth,
    };
    setClosingOperator('');
    setSecondaryOperators([]);
    setEquipoReady(false);
    setEquipoLoadError(false);
    const projectId = project.id;
    Promise.all([
      productV2Api.getClosingAssignments(Number(projectId)),
      productV2Api.getSecondaryOperators(Number(projectId)),
    ])
      .then(([closingRows, secondaryRows]: [any[], any[]]) => {
        if (editingProjectId.current !== projectId) return;
        const closer = String(closingRows?.[0]?.operator_id || '');
        const partners = (secondaryRows || []).map((row: any) => String(row.operator_id));
        editBaselineRef.current = { ...editBaselineRef.current, closer, partner: partners[0] || '' };
        setClosingOperator(closer);
        setSecondaryOperators(partners);
        setEquipoReady(true);
      })
      .catch((error) => {
        console.warn('[PHC] Could not load equipo of the well:', error);
        if (editingProjectId.current === projectId) setEquipoLoadError(true);
      });
    setEditingProject(project);
  };

  // Operador 2 is one person. Tapping selects, tapping again clears. Nothing is
  // written to the server here: "Guardar cambios" saves the whole form at once.
  const toggleSecondaryOperator = (operatorId: string) => {
    setSecondaryOperators((prev) => (prev.includes(operatorId) ? [] : [operatorId]));
  };

  const isEditProjectDirty = () => {
    const baseline = editBaselineRef.current;
    return editProjectForm.name !== baseline.name
      || editProjectForm.location !== baseline.location
      || editProjectForm.targetDepth !== baseline.targetDepth
      || editProjectForm.assignedOperator !== baseline.operator
      || (secondaryOperators[0] || '') !== baseline.partner
      || (closingOperator || '') !== (baseline.closer || '');
  };

  // Closing the sheet with ✕ or the back button must not drop an unsaved change silently.
  const requestCloseEditProject = () => {
    if (!isEditProjectDirty()) {
      closeEditProjectModal();
      return;
    }
    showSheet('Descartar cambios', 'Hay cambios sin guardar en este pozo. ¿Querés descartarlos?', [
      { text: 'Seguir editando', style: 'cancel' },
      { text: 'Descartar', style: 'destructive', onPress: closeEditProjectModal },
    ]);
  };

  // One save for the whole well: name, location, depth, operador 1, operador 2 and
  // the closer. The equipo goes through set_project_equipo (one transaction); the
  // closer through its own RPC, and only when it changed.
  const saveProjectEdit = async () => {
    if (!editingProject) return;
    setEditError(null);
    if (!equipoReady) {
      setEditError('Todavía se está cargando el equipo del pozo. Probá de nuevo en un momento.');
      return;
    }
    if (!editProjectForm.name.trim()) {
      setEditError('El nombre del proyecto es obligatorio');
      return;
    }
    const editedTargetDepth = editProjectForm.targetDepth
      ? Number(editProjectForm.targetDepth.replace(',', '.'))
      : null;
    if (editedTargetDepth !== null && (!Number.isFinite(editedTargetDepth) || editedTargetDepth <= 0)) {
      setEditError('La profundidad objetivo debe ser mayor a 0');
      return;
    }
    const projectId = Number(editingProject.id);
    const operatorId = editProjectForm.assignedOperator;
    const partnerId = secondaryOperators[0] || '';
    if (partnerId && partnerId === operatorId) {
      setEditError('El operador 2 tiene que ser distinto del operador 1');
      return;
    }
    const closerId = closingOperator;
    const baseline = editBaselineRef.current;
    const equipoChanged = operatorId !== baseline.operator || partnerId !== baseline.partner;
    const closerChanged = !!closerId && closerId !== baseline.closer;
    const name = editProjectForm.name.trim();
    const location = editProjectForm.location.trim() || null;

    setSavingProjectEdit(true);
    let equipoSaved = false;
    try {
      if (equipoChanged) {
        await productV2Api.setProjectEquipo(projectId, operatorId || null, partnerId || null);
        editBaselineRef.current = { ...editBaselineRef.current, operator: operatorId, partner: partnerId };
        equipoSaved = true;
      }
      await projectsApi.update(projectId, {
        name,
        location,
        target_depth: editedTargetDepth,
      });
      if (closerChanged) {
        await productV2Api.setClosingOperator(projectId, closerId);
        editBaselineRef.current = { ...editBaselineRef.current, closer: closerId };
      }
      // Keep the local mirror in step so the card updates even before the
      // next full server refresh.
      await execute(
        `UPDATE projects SET name = ?, location = ?, assigned_operator_id = ?, target_depth = ?, updated_at = ? WHERE id = ?`,
        [
          name,
          location,
          operatorId || null,
          editedTargetDepth,
          new Date().toISOString(),
          editingProject.id,
        ]
      );
      closeEditProjectModal();
      await loadProjects();
    } catch (error: any) {
      const message = adminErrorText(error, 'No se pudo guardar el pozo');
      setEditError(
        equipoSaved
          ? `El equipo se guardó, pero no el resto del pozo: ${message}. Revisá el pozo antes de seguir.`
          : message,
      );
    } finally {
      setSavingProjectEdit(false);
    }
  };

  // Pausar / Cancelar / Reactivar. The phone's copy of the status can be stale, so the
  // well is read again before anything is asked or written. A submitted Ficha or an open
  // shift changes what the action does to the crew, so the admin is told first.
  const applyProjectStatus = async (project: any, status: string) => {
    setSavingProjectEdit(true);
    setEditError(null);
    try {
      await projectsApi.update(Number(project.id), { status });
      await execute(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`, [status, new Date().toISOString(), project.id]);
      closeEditProjectModal();
      await loadProjects();
    } catch (error: any) {
      setEditError(adminErrorText(error, 'No se pudo cambiar el estado'));
    } finally {
      setSavingProjectEdit(false);
    }
  };

  const setProjectStatusQuick = async (project: any, status: string) => {
    const projectId = Number(project.id);
    setSavingProjectEdit(true);
    setEditError(null);
    let freshStatus: string;
    let hasOpenShift = false;
    try {
      const fresh = await projectsApi.getById(projectId);
      freshStatus = normalizeStatus(fresh?.status ?? project.status);
      const openShifts = await shiftsApi.getMine({ projectId, unresolvedOnly: true });
      hasOpenShift = openShifts.length > 0;
    } catch (error: any) {
      setEditError(adminErrorText(error, 'No se pudo leer el pozo. Probá de nuevo.'));
      setSavingProjectEdit(false);
      return;
    }
    setSavingProjectEdit(false);

    if (status === 'paused' && freshStatus === 'closure_submitted') {
      setEditError('La Ficha ya fue enviada: el pozo no se puede pausar.');
      return;
    }
    if (status === 'cancelled' && freshStatus === 'completed') {
      setEditError('Este pozo está completado: no se puede cancelar.');
      return;
    }

    const name = project.name;
    const warnings: string[] = [];
    if (status === 'cancelled' && freshStatus === 'closure_submitted') {
      warnings.push('La Ficha ya fue enviada y queda sin firmar.');
    }
    if ((status === 'paused' || status === 'cancelled') && hasOpenShift) {
      warnings.push('Hay un turno abierto: los avances del equipo que se carguen ahora van a Revisión.');
    }
    const question = status === 'paused'
      ? `¿Pausar el proyecto "${name}"?`
      : status === 'cancelled'
        ? `¿Cancelar el proyecto "${name}"? El operador ya no podrá registrar avances.`
        : `¿Reactivar el proyecto "${name}"?`;
    const message = [question, ...warnings].join(' ');
    showSheet('Confirmar', message, [
      { text: 'Volver', style: 'cancel' },
      { text: 'Sí, continuar', style: 'destructive', onPress: () => void applyProjectStatus(project, status) },
    ]);
  };

  const refreshSelectedProjectMaterials = async () => {
    if (!selectedProject) return;
    await openMaterialModal(selectedProject);
  };

  const startEditAssignment = (assignment: any) => {
    setEditingAssignmentId(Number(assignment.id));
    setEditAssignmentTotal(String(assignment.initial_quantity ?? ''));
  };

  const saveAssignmentTotal = async (assignment: any) => {
    setMaterialError(null);
    const newTotal = Number(editAssignmentTotal.trim().replace(',', '.'));
    if (!(newTotal > 0)) {
      setMaterialError('Ingresá una cantidad total válida');
      return;
    }
    try {
      await materialsApi.updateAssignedQuantity(Number(assignment.id), newTotal);
      const consumed = Number(assignment.initial_quantity) - Number(assignment.current_quantity);
      await execute(
        `UPDATE project_materials SET initial_quantity = ?, current_quantity = ?, updated_at = ? WHERE id = ?`,
        [newTotal, newTotal - consumed, new Date().toISOString(), assignment.id]
      );
      setEditingAssignmentId(null);
      setEditAssignmentTotal('');
      await refreshSelectedProjectMaterials();
    } catch (error: any) {
      setMaterialError(adminErrorText(error, 'No se pudo actualizar la cantidad'));
    }
  };

  const removeAssignment = (assignment: any) => {
    setMaterialError(null);
    showSheet(
      'Quitar material',
      `¿Quitar "${assignment.material_name}" de este proyecto?`,
      [
        { text: 'Volver', style: 'cancel' },
        {
          text: 'Sí, quitar',
          style: 'destructive',
          onPress: async () => {
            try {
              await materialsApi.removeAssigned(Number(assignment.id));
              await execute(`DELETE FROM project_materials WHERE id = ?`, [assignment.id]);
              setEditingAssignmentId(null);
              setEditAssignmentTotal('');
              await refreshSelectedProjectMaterials();
            } catch (error: any) {
              setMaterialError(adminErrorText(error, 'No se pudo quitar el material'));
            }
          },
        },
      ]
    );
  };

  const createProject = async () => {
    setCreateError(null);
    if (!projectForm.name.trim()) {
      setCreateError('Ingresá el nombre del proyecto');
      return;
    }

    if (!projectForm.assignedOperator) {
      setCreateError('Seleccioná un operador');
      return;
    }

    const targetDepth = Number((projectForm.targetDepth || '0').replace(',', '.'));
    const barLength = Number((projectForm.defaultBarLength || '0').replace(',', '.'));

    if (!Number.isFinite(targetDepth) || targetDepth <= 0) {
      setCreateError('La profundidad objetivo debe ser mayor a 0');
      return;
    }

    if (!Number.isFinite(barLength) || barLength <= 0) {
      setCreateError('La longitud de barra debe ser mayor a 0');
      return;
    }

    if (creatingProject) return;
    setCreatingProject(true);
    try {
      // A well exists only once the server has it: no local-only fallback.
      const token = await AsyncStorage.getItem('authToken');
      if (!token) {
        throw new Error('Tu sesión venció. Volvé a iniciar sesión para crear el pozo.');
      }
      const currentTime = new Date().toISOString();
      const response = await projectsApi.create({
        name: projectForm.name.trim(),
        well_name: projectForm.wellName.trim() || projectForm.name.trim(),
        client: projectForm.client.trim() || null,
        location: projectForm.location.trim() || null,
        coordinates: projectForm.coordinates.trim() || null,
        assigned_operator_id: String(projectForm.assignedOperator),
        target_depth: targetDepth,
        default_bar_length: barLength,
        default_bar_diameter: projectForm.defaultBarDiameter.trim() || null,
        project_type: 'drilling',
        status: 'active',
      });
      const projectId = response.project_id;

      const selectedOperator = operators.find((operator) => String(operator.id) === String(projectForm.assignedOperator));
      await execute(
        `INSERT OR REPLACE INTO projects (
          id, name, location, assigned_operator_id, target_depth,
          default_bar_length, default_bar_diameter, coordinates, well_name,
          progress, status, created_at, updated_at, deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, 0)`,
        [
          projectId,
          projectForm.name.trim(),
          projectForm.location.trim() || null,
          String(projectForm.assignedOperator),
          targetDepth,
          barLength,
          projectForm.defaultBarDiameter.trim() || null,
          projectForm.coordinates.trim() || null,
          projectForm.wellName.trim() || projectForm.name.trim(),
          currentTime,
          currentTime,
        ]
      );

      if (selectedOperator && selectedOperator.full_name && !selectedOperator.name) {
        await ensureOperatorStub({
          id: String(selectedOperator.id),
          name: selectedOperator.full_name,
          currentTime,
        });
      }

      showSheet('Éxito', 'Proyecto creado y asignado al operador');
      closeProjectModal();
      resetProjectForm();
      await loadProjects();
    } catch (error: any) {
      setCreateError(`No se pudo crear el proyecto: ${adminErrorText(error)}`);
    } finally {
      setCreatingProject(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setIsLoading(false);
    await loadProjects(1, false).catch(() => {});
    setRefreshing(false);
  };

  const initializeLoad = async () => {
    setIsLoading(true);
    setLastError(null);
    try {
      // Project cards resolve operator names through the SQLite mirror, so
      // populate that bounded profile cache before reading the project page.
      await loadOperators();
      await loadProjects(1, false);
    } catch (error) {
      // Error already set in loadProjects
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    initializeLoad();
  }, []);

  const loadMoreProjects = async () => {
    if (!hasMoreProjects || loadingMoreProjects) return;
    setLoadingMoreProjects(true);
    try {
      await loadProjects(projectPage + 1, true);
    } finally {
      setLoadingMoreProjects(false);
    }
  };

  // Build the selectable labels the same way supabase-materials.assignToProject
  // resolves a typed name: the plain material name when its variant is the
  // "estandar" one, otherwise "Material · Variante". Anything produced here is
  // therefore guaranteed to resolve server-side.
  const loadCatalogOptions = async () => {
    setLoadingCatalog(true);
    try {
      const catalog = await productV2Api.getCatalog();
      const labels: string[] = [];
      const units: Record<string, string> = {};
      for (const material of catalog || []) {
        const variants = ((material as any).catalog_variants || []).filter((v: any) => v.active);
        if (variants.length === 0) continue;
        for (const variant of variants) {
          const isStandard = String(variant.display_name || '').trim().toLowerCase() === 'estandar'
            || String(variant.display_name || '').trim().toLowerCase() === 'estándar';
          const label = isStandard ? material.name : `${material.name} · ${variant.display_name}`;
          labels.push(label);
          units[label] = String(material.unit || '');
        }
      }
      setCatalogUnits(units);
      setCatalogOptions(Array.from(new Set(labels)));
    } catch (error) {
      console.error('[PHC] Error loading catalog:', error);
      setCatalogOptions([]);
    } finally {
      setLoadingCatalog(false);
    }
  };

  const openMaterialModal = async (project: any) => {
    materialModalProjectId.current = project.id;
    setSelectedProject(project);
    setMaterialAssignments([]);
    setConsumptionHistory([]);
    setEditingAssignmentId(null);
    setShowMaterialModal(true);
    setAssignmentForm({ materialName: '', quantity: '', notes: '' });
    setMaterialError(null);
    void loadCatalogOptions();

    try {
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        try {
          const [serverAssignments, serverConsumption] = await Promise.all([
            materialsApi.getProjectMaterials(project.id),
            materialsApi.getProjectConsumption(project.id),
          ]);
          const currentTime = new Date().toISOString();
          await runInTransaction(async (transaction) => {
            // This was a 10-column INSERT OR REPLACE that dropped layer,
            // catalog_variant_id and active. SQLite REPLACE deletes and
            // re-inserts, so opening this modal nulled catalog_variant_id,
            // reset 'presupuesto' to 'extras' and forced active back to 1 —
            // including immediately after assignMaterial had written the row
            // correctly. The forced active=1 is the dangerous one: the handover
            // payload reads `active` from this table, so a material the server
            // had DEACTIVATED still went out as active and the server rejected
            // the entire handover with "A handover item is not an active
            // material in this project" — the same deadlock by a second route.
            // The executor is passed so the mirror stays inside this transaction.
            await mirrorProjectMaterials(serverAssignments.data, currentTime, transaction.execute);
            await mirrorMaterialConsumptions(
              serverConsumption.data,
              currentTime,
              transaction.execute,
            );
          });
        } catch (error) {
          console.warn('[PHC] Could not refresh project materials from backend:', error);
        }
      }

      const assignments = await query<any>(`
        SELECT * FROM project_materials
        WHERE project_id = ? AND COALESCE(active, 1) = 1
        ORDER BY material_name
      `, [project.id]);
      if (materialModalProjectId.current !== project.id) return;
      setMaterialAssignments(assignments || []);

      // Load consumption history for this project
      const consumption = await query<any>(`
        SELECT
          mc.*,
          o.name as operator_name
        FROM material_consumption mc
        LEFT JOIN operators o ON mc.operator_id = o.id
        WHERE mc.project_id = ?
        ORDER BY mc.date DESC, mc.created_at DESC
        LIMIT 20
      `, [project.id]);
      if (materialModalProjectId.current !== project.id) return;
      setConsumptionHistory(consumption || []);
    } catch (error) {
      console.error('[PHC] Error loading project materials:', error);
      setMaterialError(adminErrorText(error, 'No se pudo cargar la información de materiales'));
    }
  };

  const assignMaterial = async () => {
    setMaterialError(null);
    const materialName = assignmentForm.materialName.trim();
    if (!materialName || !assignmentForm.quantity) {
      setMaterialError('Seleccioná un material del catálogo e ingresá la cantidad');
      return;
    }

    const quantity = Number(assignmentForm.quantity.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMaterialError('La cantidad debe ser un número mayor a 0');
      return;
    }

    if (assigningMaterial) return;
    setAssigningMaterial(true);
    try {
      const currentTime = new Date().toISOString();

      // Admin actions need the server. Without a session nothing is booked, and
      // nothing is written on the phone either.
      const token = await AsyncStorage.getItem('authToken');
      if (!token) {
        throw new Error('Tu sesión venció. Volvé a iniciar sesión para asignar materiales.');
      }
      const response = await materialsApi.assignToProject(selectedProject.id, {
        material_name: materialName,
        quantity,
        notes: assignmentForm.notes || undefined,
      });
      const serverRow: any = response?.data || null;
      if (!serverRow?.id) {
        throw new Error('No se pudo asignar el material. No se guardó nada.');
      }
      // The server owns this row, so mirror it verbatim — same shape TurnosTab's
      // refreshMaterials uses. Do NOT also insert a second, client-numbered copy:
      // that leaves a phantom row the server has never seen, and the operator's next
      // shift handover is then rejected wholesale with "A handover item is not an
      // active material in this project", which silently deadlocks the well.
      await mirrorProjectMaterial(serverRow, currentTime);

      showSheet('Éxito', `Material asignado correctamente al proyecto`);
      setAssignmentForm({ materialName: '', quantity: '', notes: '' });

      // Reload data
      await openMaterialModal(selectedProject);

    } catch (error) {
      console.error('[PHC] Error assigning material:', error);
      // The thrown message is actionable ("El material no existe en el catálogo
      // activo. Créalo en Catálogo antes de asignarlo.") — showing a generic string
      // instead left the admin at a dead end with no way to learn the real cause.
      setMaterialError(adminErrorText(error, 'No se pudo asignar el material'));
    } finally {
      setAssigningMaterial(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (normalizeStatus(status)) {
      case 'active':
        return COLORS.success;
      case 'completed':
        return COLORS.primary;
      case 'paused':
        return COLORS.warning;
      default:
        return COLORS.neutral;
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando proyectos...</Text>
      </View>
    );
  }

  // Error state
  if (lastError) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorIcon}></Text>
        <Text style={styles.errorText}>{lastError}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={initializeLoad}
        >
          <Text style={styles.retryButtonText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
        style={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[COLORS.primary]}
            tintColor={COLORS.primary}
          />
        }
      >
	        <View style={styles.content}>
	          <View style={styles.titleRow}>
	            <Text style={styles.title}>Todos los Proyectos</Text>
	            <TouchableOpacity
	              style={styles.newProjectButton}
	              onPress={() => {
	                resetProjectForm();
	                setCreateError(null);
	                loadOperators();
                armCreateProjectField();
                setShowProjectModal(true);
	              }}
	            >
	              <Text style={styles.newProjectButtonText}>+ Nuevo</Text>
	            </TouchableOpacity>
	          </View>

          {projects.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No hay proyectos registrados</Text>
            </View>
          ) : (
            projects.map((project) => (
              <View key={project.id} style={styles.projectCard}>
                <View style={styles.projectHeader}>
                  <Text style={styles.projectName}>{project.name}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: getStatusColor(project.status) }]}>
                    <Text style={styles.statusText}>{statusLabel(project.status)}</Text>
                  </View>
                </View>

                <View style={styles.projectContent}>
                  <Text style={styles.projectLocation}>{project.location}</Text>
                  {project.operator_name && (
                    <Text style={styles.projectOperator}>Operador: {project.operator_name}</Text>
                  )}
                  <Text style={styles.projectProgress}>
                    Progreso: {project.current_depth}m / {project.target_depth}m ({project.progress_percentage}%)
                  </Text>

                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${Math.min(project.progress_percentage, 100)}%` }
                      ]}
                    />
                  </View>

                  <View style={styles.projectActionsRow}>
                    {normalizeStatus(project.status) !== 'completed' && (
                      <TouchableOpacity
                        style={[styles.assignMaterialButton, styles.projectActionSecondary]}
                        onPress={() => openEditProject(project)}
                      >
                        <Text style={styles.assignMaterialButtonText}>Editar</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.assignMaterialButton, styles.projectActionSecondary]}
                      onPress={() => setPhotosProject(project)}
                    >
                      <Text style={styles.assignMaterialButtonText}>Fotos</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.assignMaterialButton, { flex: 1 }]}
                      onPress={() => openMaterialModal(project)}
                    >
                      <Text style={styles.assignMaterialButtonText}>Materiales</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))
          )}
          {hasMoreProjects ? (
            <TouchableOpacity
              style={styles.loadMoreButton}
              onPress={loadMoreProjects}
              disabled={loadingMoreProjects}
            >
              <Text style={styles.loadMoreButtonText}>
                {loadingMoreProjects ? 'Cargando…' : 'Cargar más proyectos'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>

      {/* Project Edit Modal */}
      <Modal
        visible={!!editingProject}
        transparent={true}
        animationType="slide"
        onRequestClose={requestCloseEditProject}
        onShow={handleEditProjectModalShow}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Editar proyecto</Text>
              <TouchableOpacity
                onPress={requestCloseEditProject}
                accessibilityRole="button"
                accessibilityLabel="Cerrar"
                focusable={false}
              >
                <Text style={styles.modalCloseButton}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
      keyboardDismissMode="on-drag"
              style={styles.modalContent}
              contentContainerStyle={styles.modalContentContainer}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.formSection}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Nombre</Text>
                  {editProjectFieldReady ? (
                    <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                      testID="edit-project-name-input"
                      ref={editProjectNameInputRef}
                      style={styles.textInput}
                      value={editProjectForm.name}
                      selection={editProjectSelection}
                      onFocus={handleEditProjectFieldFocus}
                      onBlur={handleEditProjectFieldBlur}
                      onChangeText={(name) => setEditProjectForm((form) => ({ ...form, name }))}
                      placeholderTextColor={COLORS.placeholder}
                    />
                  ) : (
                    <View style={styles.textInput}>
                      <Text style={{ color: COLORS.text, fontSize: TYPE.label }}>{editProjectForm.name}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Ubicación</Text>
                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                    style={styles.textInput}
                    value={editProjectForm.location}
                    onChangeText={(t) => setEditProjectForm((f) => ({ ...f, location: t }))}
                    placeholderTextColor={COLORS.placeholder}
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Operador</Text>
                  {operatorsLoading ? (
                    <View style={styles.operatorLoading}>
                      <ActivityIndicator size="small" color={COLORS.accent} />
                      <Text style={styles.operatorLoadingText}>Cargando operadores...</Text>
                    </View>
                  ) : operators.length === 0 ? (
                    <Text style={styles.emptyMessage}>No hay operadores activos disponibles.</Text>
                  ) : (
                    <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.operatorList} nestedScrollEnabled>
                      {operators.map((operator) => {
                        const operatorId = String(operator.id);
                        const isSelected = editProjectForm.assignedOperator === operatorId;
                        return (
                          <TouchableOpacity
                            key={operatorId}
                            style={[styles.operatorOption, isSelected && styles.operatorOptionSelected]}
                            onPress={() => {
                              setEditProjectForm((f) => ({ ...f, assignedOperator: operatorId }));
                              setSecondaryOperators((prev) => prev.filter((id) => id !== operatorId));
                            }}
                          >
                            <Text style={styles.operatorRadio}>{isSelected ? '●' : '○'}</Text>
                          <Text style={styles.operatorOptionText}>
                              {operator.full_name || operator.name || operator.username || `Operador ${operator.id}`}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Profundidad objetivo (m)</Text>
                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                    style={styles.textInput}
                    value={editProjectForm.targetDepth}
                    onChangeText={(t) => setEditProjectForm((f) => ({ ...f, targetDepth: t }))}
                    keyboardType="numeric"
                    placeholderTextColor={COLORS.placeholder}
                  />
                </View>
                {/* The second crew operator of the equipo. Saved with "Guardar cambios". */}
                <View style={[styles.inputGroup, { marginTop: SPACING.xl }]}>
                  <Text style={styles.inputLabel}>Operador 2 del equipo</Text>
                  <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.operatorList} nestedScrollEnabled>
                    {operators
                      .filter((operator) => String(operator.id) !== editProjectForm.assignedOperator)
                      .map((operator) => {
                        const operatorId = String(operator.id);
                        const isSelected = secondaryOperators.includes(operatorId);
                        return (
                          <TouchableOpacity
                            key={`secondary-${operatorId}`}
                            style={[styles.operatorOption, isSelected && styles.operatorOptionSelected]}
                            disabled={!equipoReady}
                            onPress={() => toggleSecondaryOperator(operatorId)}
                          >
                            <Text style={styles.operatorRadio}>{isSelected ? '●' : '○'}</Text>
                          <Text style={styles.operatorOptionText}>
                              {isSelected ? '✓ ' : ''}
                              {operator.full_name || operator.name || operator.username || `Operador ${operator.id}`}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                  </ScrollView>
                </View>

                {/* Closing operator. Separate from the assigned operator on
                    purpose: whoever files the Ficha técnica need not be the one
                    who drilled. Without this the operator's Cierre tab stays
                    empty ("Sin cierres asignados") and the well cannot be closed
                    from the phone at all. */}
                <View style={[styles.inputGroup, { marginTop: SPACING.xl }]}>
                  <Text style={styles.inputLabel}>Operador de cierre (Ficha técnica)</Text>
                  <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.operatorList} nestedScrollEnabled>
                    {operators.map((operator) => {
                      const operatorId = String(operator.id);
                      const isSelected = closingOperator === operatorId;
                      return (
                        <TouchableOpacity
                          key={`closer-${operatorId}`}
                          style={[styles.operatorOption, isSelected && styles.operatorOptionSelected]}
                          onPress={() => setClosingOperator(operatorId)}
                        >
                          <Text style={styles.operatorRadio}>{isSelected ? '●' : '○'}</Text>
                          <Text style={styles.operatorOptionText}>
                            {operator.full_name || operator.name || operator.username || `Operador ${operator.id}`}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                {editError && (
                  <Text style={styles.errorBanner} accessibilityRole="alert">
                    {editError}
                  </Text>
                )}
                {equipoLoadError && (
                  <Text style={styles.errorBanner} accessibilityRole="alert">
                    No se pudo cargar el equipo de este pozo. Cerrá y volvé a abrir el pozo antes de guardar.
                  </Text>
                )}
                {!equipoReady && !equipoLoadError && (
                  <Text style={styles.operatorLoadingText}>Cargando el equipo del pozo…</Text>
                )}
                <TouchableOpacity
                  testID="edit-project-save"
                  style={[styles.assignButton, (savingProjectEdit || !equipoReady) && { opacity: 0.6 }]}
                  onPress={saveProjectEdit}
                  disabled={savingProjectEdit || !equipoReady}
                >
                  <Text style={styles.assignButtonText}>
                    {savingProjectEdit ? 'Guardando…' : 'Guardar cambios'}
                  </Text>
                </TouchableOpacity>

                {editingProject && (
                  <View style={{ marginTop: SPACING.lg }}>
                    <Text style={[styles.inputLabel, { marginBottom: SPACING.sm }]}>Estado del proyecto</Text>
                    {['planning', 'active'].includes(normalizeStatus(editingProject.status)) && (
                      <TouchableOpacity
                        style={[styles.assignMaterialButton, { backgroundColor: COLORS.warning, marginTop: SPACING.sm }]}
                        disabled={savingProjectEdit}
                        onPress={() => setProjectStatusQuick(editingProject, 'paused')}
                      >
                        <Text style={styles.assignMaterialButtonText}>Pausar</Text>
                      </TouchableOpacity>
                    )}
                    {normalizeStatus(editingProject.status) === 'paused' && (
                      <TouchableOpacity
                        style={[styles.assignMaterialButton, { backgroundColor: COLORS.success, marginTop: SPACING.sm }]}
                        disabled={savingProjectEdit}
                        onPress={() => setProjectStatusQuick(editingProject, 'active')}
                      >
                        <Text style={styles.assignMaterialButtonText}>Reactivar</Text>
                      </TouchableOpacity>
                    )}
                    {!['completed', 'cancelled'].includes(normalizeStatus(editingProject.status)) && (
                      <TouchableOpacity
                        style={[styles.assignMaterialButton, { backgroundColor: COLORS.danger, marginTop: SPACING.sm }]}
                        disabled={savingProjectEdit}
                        onPress={() => setProjectStatusQuick(editingProject, 'cancelled')}
                      >
                        <Text style={styles.assignMaterialButtonText}>Cancelar proyecto</Text>
                      </TouchableOpacity>
                    )}
                    {normalizeStatus(editingProject.status) === 'cancelled' && (
                      <TouchableOpacity
                        style={[styles.assignMaterialButton, { backgroundColor: COLORS.success, marginTop: SPACING.sm }]}
                        disabled={savingProjectEdit}
                        onPress={() => setProjectStatusQuick(editingProject, 'active')}
                      >
                        <Text style={styles.assignMaterialButtonText}>Reactivar proyecto</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Project Creation Modal */}
	      <Modal
	        testID="create-project-modal"
	        visible={showProjectModal}
	        transparent={true}
	        animationType="slide"
	        onRequestClose={closeProjectModal}
	        onShow={handleCreateProjectModalShow}
	      >
	        <View style={styles.modalOverlay}>
	          <View style={styles.modalContainer}>
	            <View style={styles.modalHeader}>
	              <Text style={styles.modalTitle}>Nuevo Proyecto / Pozo</Text>
	              <TouchableOpacity
	                onPress={closeProjectModal}
	                accessibilityRole="button"
	                accessibilityLabel="Cerrar"
	                focusable={false}
	              >
	                <Text style={styles.modalCloseButton}>✕</Text>
	              </TouchableOpacity>
	            </View>

	            <ScrollView
      keyboardDismissMode="on-drag"
	              style={styles.modalContent}
	              contentContainerStyle={styles.modalContentContainer}
	              showsVerticalScrollIndicator={false}
	              keyboardShouldPersistTaps="handled"
	            >
	              <View style={styles.formSection}>
	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Nombre del proyecto *</Text>
                  {createProjectFieldReady ? (
                    <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                      testID="create-project-name-input"
                      ref={createProjectNameInputRef}
                      style={styles.textInput}
                      value={projectForm.name}
                      onFocus={handleCreateProjectFieldFocus}
                      onBlur={handleCreateProjectFieldBlur}
                      onChangeText={(text) => updateProjectFormField('name', text)}
                      placeholder="Ej: Pozo Filadelfia Norte"
                      placeholderTextColor={COLORS.placeholder}
                    />
                  ) : (
                    <View style={styles.textInput} />
                  )}
	                </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Nombre / número del pozo</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-well-name-input"
	                    style={styles.textInput}
	                    value={projectForm.wellName}
	                    onChangeText={(text) => updateProjectFormField('wellName', text)}
	                    placeholder="Ej: Pozo 03"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Cliente</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-client-input"
	                    style={styles.textInput}
	                    value={projectForm.client}
	                    onChangeText={(text) => updateProjectFormField('client', text)}
	                    placeholder="Nombre del cliente"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Ubicación</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-location-input"
	                    style={styles.textInput}
	                    value={projectForm.location}
	                    onChangeText={(text) => updateProjectFormField('location', text)}
	                    placeholder="Ciudad / estancia / referencia"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Coordenadas</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-coordinates-input"
	                    style={styles.textInput}
	                    value={projectForm.coordinates}
	                    onChangeText={(text) => updateProjectFormField('coordinates', text)}
	                    placeholder="-22.12345, -60.12345"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	              <View style={styles.inputGroup}>
	                <Text style={styles.inputLabel}>Operador asignado *</Text>
	                {operatorsLoading ? (
	                  <View style={styles.operatorLoading}>
	                    <ActivityIndicator size="small" color={COLORS.accent} />
	                    <Text style={styles.operatorLoadingText}>Cargando operadores...</Text>
	                  </View>
	                ) : operators.length === 0 ? (
	                  <Text style={styles.emptyMessage}>No hay operadores activos disponibles.</Text>
	                ) : (
	                  <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.operatorList} nestedScrollEnabled>
	                    {operators.map((operator) => {
	                      const operatorId = String(operator.id);
	                      const isSelected = projectForm.assignedOperator === operatorId;
	                      return (
	                        <TouchableOpacity
	                          key={operatorId}
	                          style={[styles.operatorOption, isSelected && styles.operatorOptionSelected]}
	                          onPress={() => setProjectForm((form) => ({ ...form, assignedOperator: operatorId }))}
	                        >
	                          <Text style={styles.operatorRadio}>{isSelected ? '●' : '○'}</Text>
                          <Text style={styles.operatorOptionText}>
	                            {operator.full_name || operator.name || operator.username || `Operador ${operator.id}`}
	                          </Text>
	                        </TouchableOpacity>
	                      );
	                    })}
	                  </ScrollView>
	                )}
	              </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Profundidad objetivo (m) *</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-target-depth-input"
	                    style={styles.textInput}
	                    value={projectForm.targetDepth}
	                    onChangeText={(text) => updateProjectFormField('targetDepth', text)}
	                    keyboardType="numeric"
	                    placeholder="Ej: 120"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Longitud de barra por defecto (m) *</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-bar-length-input"
	                    style={styles.textInput}
	                    value={projectForm.defaultBarLength}
	                    onChangeText={(text) => updateProjectFormField('defaultBarLength', text)}
	                    keyboardType="numeric"
	                    placeholder="Ej: 3"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	                <View style={styles.inputGroup}>
	                  <Text style={styles.inputLabel}>Diámetro por defecto</Text>
	                  <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
	                    testID="create-project-bar-diameter-input"
	                    style={styles.textInput}
	                    value={projectForm.defaultBarDiameter}
	                    onChangeText={(text) => updateProjectFormField('defaultBarDiameter', text)}
	                    placeholder="Ej: 6 pulgadas"
	                    placeholderTextColor={COLORS.placeholder}
	                  />
	                </View>

	              {createError && (
	                <Text style={styles.errorBanner} accessibilityRole="alert">{createError}</Text>
	              )}
	              <TouchableOpacity
	                style={[styles.assignButton, (operatorsLoading || creatingProject) && styles.disabledButton]}
	                onPress={createProject}
	                disabled={operatorsLoading || creatingProject}
	              >
	                <Text style={styles.assignButtonText}>{creatingProject ? 'Creando…' : 'Crear y Asignar Proyecto'}</Text>
	              </TouchableOpacity>
	              </View>
	            </ScrollView>
	          </View>
	        </View>
	      </Modal>

	      {/* Material Assignment Modal */}
      <Modal
        visible={showMaterialModal}
        transparent={true}
        animationType="slide"
        onRequestClose={closeMaterialModal}
      >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              Materiales - {selectedProject?.name}
            </Text>
            <TouchableOpacity
              onPress={closeMaterialModal}
              accessibilityRole="button"
              accessibilityLabel="Cerrar"
              focusable={false}
            >
              <Text style={styles.modalCloseButton}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
      keyboardDismissMode="on-drag"
            style={styles.modalContent}
            contentContainerStyle={styles.modalContentContainer}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {materialError && (
              <Text style={styles.errorBanner} accessibilityRole="alert">{materialError}</Text>
            )}

            {/* Material Assignment Form */}
            <View style={styles.formSection}>
              <Text style={styles.modalSectionTitle}>Asignar Material</Text>

              {/* Pick from the catalog instead of typing. The backend only
                  accepts names that resolve against active catalog_materials /
                  catalog_variants, so a free-text box could only ever produce a
                  rejection — and its own placeholder ("ej: Cemento Portland")
                  was not in the catalog, which taught admins to type a value
                  guaranteed to fail. These labels are built exactly the way
                  supabase-materials.assignToProject resolves them, so anything
                  selectable here is guaranteed to match. */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Material:</Text>
                {catalogOptions.length === 0 ? (
                  <View>
                    <Text style={styles.catalogEmptyText}>
                      {loadingCatalog
                        ? 'Cargando catálogo…'
                        : 'No hay materiales activos en el catálogo.'}
                    </Text>
                    {!loadingCatalog && (
                      <TouchableOpacity
                        testID="go-to-catalog"
                        style={styles.catalogButton}
                        onPress={openCatalog}
                      >
                        <Text style={styles.catalogButtonText}>Ir a Catálogo</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ) : (
                  <ScrollView
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" style={styles.operatorList} nestedScrollEnabled>
                    {catalogOptions.map((option) => {
                      const isSelected = assignmentForm.materialName === option;
                      return (
                        <TouchableOpacity
                          key={`catalog-${option}`}
                          testID={`assign-material-option-${option}`}
                          style={[styles.operatorOption, isSelected && styles.operatorOptionSelected]}
                          onPress={() => setAssignmentForm((form) => ({ ...form, materialName: option }))}
                        >
                          <Text style={styles.operatorRadio}>{isSelected ? '●' : '○'}</Text>
                          <Text style={styles.operatorOptionText}>{option}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Cantidad:</Text>
                <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                  testID="assign-material-quantity"
                  style={styles.textInput}
                  value={assignmentForm.quantity}
                  onChangeText={(text) => setAssignmentForm((form) => ({ ...form, quantity: text }))}
                  placeholder="0"
                  keyboardType="numeric"
                  placeholderTextColor={COLORS.placeholder}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Unidad (la del catálogo):</Text>
                <Text testID="assign-material-unit" style={styles.operatorOptionText}>
                  {assignmentForm.materialName ? (catalogUnits[assignmentForm.materialName] || '—') : 'Elegí un material primero'}
                </Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Notas (opcional):</Text>
                <TextInput
                  style={[styles.textInput, styles.textArea]}
                  value={assignmentForm.notes}
                  onChangeText={(text) => setAssignmentForm((form) => ({ ...form, notes: text }))}
                  placeholder="Notas adicionales..."
                  multiline={true}
                  numberOfLines={3}
                  placeholderTextColor={COLORS.placeholder}
                />
              </View>

              <TouchableOpacity
                style={[styles.assignButton, (!assignmentForm.materialName || loadingCatalog || assigningMaterial) && styles.disabledButton]}
                onPress={assignMaterial}
                disabled={!assignmentForm.materialName || loadingCatalog || assigningMaterial}
              >
                <Text style={styles.assignButtonText}>{assigningMaterial ? 'Asignando…' : 'Asignar Material'}</Text>
              </TouchableOpacity>
            </View>

            {/* Current Assignments */}
            <View style={styles.formSection}>
              <Text style={styles.modalSectionTitle}>Materiales Asignados</Text>
              {materialAssignments.length === 0 ? (
                <Text style={styles.emptyMessage}>No hay materiales asignados a este proyecto</Text>
              ) : (
                materialAssignments.map((assignment, index) => {
                  const consumed = Math.round((Number(assignment.initial_quantity) - Number(assignment.current_quantity)) * 100) / 100;
                  const isEditing = editingAssignmentId === Number(assignment.id);
                  return (
                  <View key={assignment.id ?? index} style={styles.assignmentCard}>
                    <Text style={styles.assignmentName}>{assignment.material_name}</Text>
                    {isEditing ? (
                      <View style={styles.inputGroup}>
                        <Text style={styles.inputLabel}>Total asignado</Text>
                        <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
                          style={styles.textInput}
                          value={editAssignmentTotal}
                          onChangeText={setEditAssignmentTotal}
                          keyboardType="numeric"
                          placeholderTextColor={COLORS.placeholder}
                        />
                        <View style={styles.projectActionsRow}>
                          <TouchableOpacity
                            style={[styles.assignMaterialButton, styles.projectActionSecondary, { flex: 1 }]}
                            onPress={() => { setEditingAssignmentId(null); setEditAssignmentTotal(''); }}
                          >
                            <Text style={styles.assignMaterialButtonText}>Cancelar</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.assignMaterialButton, { flex: 1, backgroundColor: COLORS.success }]}
                            onPress={() => saveAssignmentTotal(assignment)}
                          >
                            <Text style={styles.assignMaterialButtonText}>Guardar</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <>
                        <Text style={styles.assignmentQuantity}>
                          Asignado: {assignment.initial_quantity} {assignment.unit}
                        </Text>
                        <Text style={[styles.assignmentQuantity, { color: consumed > 0 ? COLORS.warning : COLORS.textSecondary }]}>
                          Consumido: {consumed} {assignment.unit}
                        </Text>
                        <Text style={[
                          styles.assignmentQuantity,
                          { color: assignment.current_quantity < assignment.initial_quantity * 0.2 ? COLORS.danger : COLORS.success }
                        ]}>
                          Disponible: {assignment.current_quantity} {assignment.unit}
                        </Text>
                        {assignment.notes ? (
                          <Text style={styles.assignmentNotes}>{assignment.notes}</Text>
                        ) : null}
                        <View style={styles.projectActionsRow}>
                          {normalizeStatus(selectedProject?.status) !== 'completed' && (
                            <TouchableOpacity
                              style={[styles.assignMaterialButton, styles.projectActionSecondary, { flex: 1 }]}
                              onPress={() => startEditAssignment(assignment)}
                            >
                              <Text style={styles.assignMaterialButtonText}>Editar</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            style={[styles.assignMaterialButton, { flex: 1, backgroundColor: COLORS.danger }]}
                            onPress={() => removeAssignment(assignment)}
                          >
                            <Text style={styles.assignMaterialButtonText}>Quitar</Text>
                          </TouchableOpacity>
                        </View>
                      </>
                    )}
                  </View>
                  );
                })
              )}
            </View>

            {/* Consumption History */}
            <View style={styles.formSection}>
              <Text style={styles.modalSectionTitle}>Historial de Consumo</Text>
              {consumptionHistory.length === 0 ? (
                <Text style={styles.emptyMessage}>No hay registros de consumo</Text>
              ) : (
                consumptionHistory.map((consumption, index) => (
                  <View key={index} style={styles.consumptionCard}>
                    <View style={styles.consumptionHeader}>
                      <Text style={styles.consumptionMaterial}>{consumption.material_name}</Text>
                      <Text style={styles.consumptionDate}>{consumption.date}</Text>
                    </View>
                    <Text style={styles.consumptionDetail}>
                      Cantidad: {consumption.quantity_used} {consumption.unit}
                    </Text>
                    <Text style={styles.consumptionOperator}>
                      {consumption.operator_name}
                    </Text>
                    {consumption.notes && (
                      <Text style={styles.consumptionNotes}>{consumption.notes}</Text>
                    )}
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>

    <ProjectPhotosModal
      visible={!!photosProject}
      projectId={photosProject ? Number(photosProject.id) : null}
      projectName={photosProject?.name}
      onClose={() => setPhotosProject(null)}
    />
    </View>
  );
};

const styles = StyleSheet.create({
  ...adminSharedStyles,
  assignButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.success,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  assignButtonText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
  },
  assignMaterialButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    marginTop: SPACING.md,
    alignItems: 'center',
  },
  catalogButton: { minHeight: 48, justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  catalogButtonText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
  },
  catalogEmptyText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.caption,
    paddingVertical: SPACING.sm,
  },
  assignMaterialButtonText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
  },
  assignmentCard: {
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  assignmentName: {
    fontSize: TYPE.label,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  assignmentNotes: {
    fontSize: TYPE.caption,
    color: COLORS.primaryText,
    fontStyle: 'italic',
    marginTop: SPACING.xs,
  },
  assignmentQuantity: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  consumptionCard: {
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  consumptionDate: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
  },
  consumptionDetail: {
    fontSize: TYPE.caption,
    color: COLORS.successText,
    marginBottom: SPACING.xs,
  },
  consumptionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  consumptionMaterial: {
    fontSize: TYPE.label,
    fontWeight: 'bold',
    color: COLORS.text,
    flex: 1,
  },
  consumptionNotes: {
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
    marginTop: SPACING.xs,
  },
  consumptionOperator: {
    fontSize: TYPE.caption,
    color: COLORS.primaryText,
    marginBottom: SPACING.xs,
  },
  disabledButton: {
    opacity: 0.6,
  },
  emptyMessage: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    textAlign: 'center',
    fontStyle: 'italic',
    padding: SPACING.xl,
  },
  formSection: {
    padding: SPACING.xl,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.input,
  },
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  inputLabel: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    marginBottom: SPACING.sm,
    fontWeight: '500',
  },
  loadMoreButton: { minHeight: 48, justifyContent: 'center',
    borderColor: COLORS.accent,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginBottom: SPACING.xl,
  },
  loadMoreButtonText: {
    color: COLORS.primaryText,
    fontWeight: 'bold',
  },
  modalCloseButton: {
    fontSize: TYPE.h2,
    color: COLORS.textSecondary,
    fontWeight: 'bold',
  },
  modalContainer: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    width: '100%',
    height: '92%',
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  modalContent: {
    flex: 1,
  },
  modalContentContainer: {
    paddingBottom: SPACING.xxxl,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: SPACING.xl,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalSectionTitle: {
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.lg,
  },
  modalTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    flex: 1,
  },
  newProjectButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.success,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
  },
  newProjectButtonText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
  },
  operatorList: {
    maxHeight: 180,
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  operatorLoading: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  operatorLoadingText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    marginLeft: SPACING.sm,
  },
  errorBanner: {
    backgroundColor: COLORS.errorBg,
    borderColor: COLORS.error,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    color: COLORS.text,
    marginBottom: SPACING.md,
    padding: SPACING.md,
  },
  operatorOption: {
    alignItems: 'center',
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: SPACING.sm,
    minHeight: 48,
    padding: SPACING.md,
  },
  // A one-row list of unselected options is indistinguishable from a filled
  // input showing a value — which is exactly how it read with a single
  // operator on file. The mark says "this is a choice" before it says which.
  operatorRadio: {
    color: COLORS.textMuted,
    fontSize: TYPE.bodyLg,
  },
  operatorRadioSelected: {
    color: COLORS.textOnPrimary,
  },
  operatorOptionSelected: {
    backgroundColor: COLORS.primary,
  },
  operatorOptionText: {
    color: COLORS.text,
    fontSize: TYPE.label,
  },
  progressBar: {
    height: 6,
    backgroundColor: COLORS.neutral,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.success,
    borderRadius: RADIUS.sm,
  },
  projectActionSecondary: {
    backgroundColor: COLORS.border,
    flex: 0,
    paddingHorizontal: SPACING.lg,
  },
  projectActionsRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  projectCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  projectContent: {
    padding: SPACING.lg,
  },
  projectHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  projectLocation: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    marginBottom: SPACING.sm,
  },
  projectName: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    flex: 1,
  },
  projectOperator: {
    fontSize: TYPE.label,
    color: COLORS.primaryText,
    marginBottom: SPACING.sm,
    fontWeight: '500',
  },
  projectProgress: {
    fontSize: TYPE.label,
    color: COLORS.text,
    marginBottom: SPACING.md,
  },
  statusBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.lg,
  },
  statusText: {
    color: COLORS.text,
    fontSize: TYPE.caption,
    fontWeight: 'bold',
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  textInput: {
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    color: COLORS.text,
    fontSize: TYPE.label,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
});

export default ProjectsTab;
