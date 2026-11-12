/**
 * Admin well screen, the parts that act on a well that is already in progress.
 *
 *  - A completed well offers no "Editar" (ADM-9).
 *  - "Pausar" / "Cancelar" re-read the well first and warn about a Ficha already
 *    sent or an open shift; the refusal shows inside the edit sheet (ADM-11).
 *  - Without a session nothing is created or assigned on the phone, and the
 *    refusal shows inside the form (ADM-13).
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { Modal } from 'react-native';

import { materialsApi } from '../src/api/supabase-materials';
import { operatorsApi } from '../src/api/supabase-operators';
import { projectsApi } from '../src/api/supabase-projects';
import { productV2Api } from '../src/api/supabase-product-v2';
import { shiftsApi } from '../src/api/supabase-shifts';
import { execute, query } from '../src/db/db';
import { showSheet } from '../src/components/shared/Sheet';
import ProjectsTab from '../src/components/admin/ProjectsTab';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useFocusEffect: (callback: () => void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(callback, [callback]);
  },
}));

jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  const Picker = ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children);
  Picker.Item = ({ label }: { label: string }) => ReactModule.createElement(Text, null, label);
  return { Picker };
});

jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
jest.mock('../src/components/admin/ProjectPhotosModal', () => () => null);

jest.mock('../src/db/db', () => ({
  execute: jest.fn(async () => undefined),
  query: jest.fn(async () => []),
  runInTransaction: jest.fn(async (callback: (tx: { execute: jest.Mock }) => unknown) => callback({ execute: jest.fn() })),
}));
jest.mock('../src/db/repositories/projectMaterials', () => ({
  mirrorProjectMaterial: jest.fn(),
  mirrorProjectMaterials: jest.fn(),
}));
jest.mock('../src/db/repositories/projects', () => ({ mirrorProjects: jest.fn() }));
jest.mock('../src/db/repositories/operators', () => ({
  ensureOperatorStub: jest.fn(),
  mirrorOperator: jest.fn(),
}));
jest.mock('../src/db/repositories/materialConsumption', () => ({ mirrorMaterialConsumptions: jest.fn() }));

jest.mock('../src/api/supabase-projects', () => ({
  projectsApi: { getAll: jest.fn(), update: jest.fn(), getById: jest.fn(), create: jest.fn() },
}));
jest.mock('../src/api/supabase-operators', () => ({
  operatorsApi: { getAllActivePages: jest.fn(), getActive: jest.fn() },
}));
jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: { getMine: jest.fn() },
}));
jest.mock('../src/api/supabase-materials', () => ({
  materialsApi: {
    getProjectMaterials: jest.fn(),
    getProjectConsumption: jest.fn(),
    assignToProject: jest.fn(),
  },
}));
jest.mock('../src/api/supabase-drilling-bars', () => ({
  drillingBarsApi: { getMaxDepths: jest.fn(async () => new Map()) },
}));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: {
    getCatalog: jest.fn(),
    getClosingAssignments: jest.fn(),
    getSecondaryOperators: jest.fn(),
    setProjectEquipo: jest.fn(),
    setClosingOperator: jest.fn(),
  },
}));
jest.mock('../src/api/supabase-operators', () => ({
  operatorsApi: { getAllActivePages: jest.fn(), getActive: jest.fn() },
}));

const project = {
  id: 7,
  name: 'Pozo Norte',
  location: null,
  status: 'active',
  assigned_operator_id: 'op-1',
  target_depth: 40,
  updated_at: '2026-11-08T10:00:00Z',
};

const operators = [
  { id: 'op-1', full_name: 'Ana Operadora', username: 'ana', is_active: true, role: 'operator' },
  { id: 'op-2', full_name: 'Beto Operador', username: 'beto', is_active: true, role: 'operator' },
];

// True when the element is rendered inside a <Modal>: the page banner is not.
const isInsideModal = (node: any): boolean => {
  for (let current = node; current; current = current.parent) {
    if (current.type === Modal) return true;
  }
  return false;
};

const openEditor = async (getByText: (t: string) => any, queryByText: (t: string) => any) => {
  await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());
  fireEvent.press(getByText('Editar'));
  await waitFor(() => expect(productV2Api.getSecondaryOperators).toHaveBeenCalledWith(7));
  await waitFor(() => expect(queryByText('Cargando el equipo del pozo…')).toBeNull());
};

let listedProjects: unknown[] = [project];

describe('ProjectsTab: well already in progress', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    listedProjects = [project];
    (query as jest.Mock).mockImplementation(async (sql: string) =>
      (sql.includes('FROM projects p') ? listedProjects : []));
    await AsyncStorage.setItem('authToken', 'token-for-test');
    (projectsApi.getAll as jest.Mock).mockResolvedValue([project]);
    (projectsApi.getById as jest.Mock).mockResolvedValue({ ...project });
    (projectsApi.update as jest.Mock).mockResolvedValue({});
    (shiftsApi.getMine as jest.Mock).mockResolvedValue([]);
    (operatorsApi.getAllActivePages as jest.Mock).mockResolvedValue(operators);
    (productV2Api.getClosingAssignments as jest.Mock).mockResolvedValue([]);
    (productV2Api.getSecondaryOperators as jest.Mock).mockResolvedValue([]);
    (productV2Api.getCatalog as jest.Mock).mockResolvedValue([]);
    (materialsApi.getProjectMaterials as jest.Mock).mockResolvedValue({ data: [] });
    (materialsApi.getProjectConsumption as jest.Mock).mockResolvedValue({ data: [] });
  });

  it('offers no "Editar" on a completed well', async () => {
    listedProjects = [{ ...project, status: 'completed' }];
    const { getByText, queryByText } = render(<ProjectsTab />);
    await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());

    expect(queryByText('Editar')).toBeNull();
    expect(getByText('Materiales')).toBeTruthy();
  });

  it('re-reads the well before pausing and refuses when the Ficha was already sent', async () => {
    (projectsApi.getById as jest.Mock).mockResolvedValue({ ...project, status: 'closure_submitted' });
    const { getByText, queryByText } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    fireEvent.press(getByText('Pausar'));

    await waitFor(() => expect(getByText('La Ficha ya fue enviada: el pozo no se puede pausar.')).toBeTruthy());
    expect(projectsApi.update).not.toHaveBeenCalled();
    expect(showSheet).not.toHaveBeenCalledWith('Confirmar', expect.anything(), expect.anything());
  });

  it('warns that a Ficha already sent stays unsigned when cancelling', async () => {
    (projectsApi.getById as jest.Mock).mockResolvedValue({ ...project, status: 'closure_submitted' });
    const { getByText, queryByText } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    fireEvent.press(getByText('Cancelar proyecto'));

    await waitFor(() => expect(showSheet).toHaveBeenCalledWith(
      'Confirmar',
      expect.stringContaining('La Ficha ya fue enviada y queda sin firmar.'),
      expect.any(Array),
    ));
    expect(projectsApi.update).not.toHaveBeenCalled();
  });

  it('warns about an open shift before cancelling, and only writes after confirmation', async () => {
    (shiftsApi.getMine as jest.Mock).mockResolvedValue([{ id: 'shift-1', status: 'open' }]);
    const { getByText, queryByText } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    fireEvent.press(getByText('Cancelar proyecto'));

    await waitFor(() => expect(showSheet).toHaveBeenCalledWith(
      'Confirmar',
      expect.stringContaining('Hay un turno abierto'),
      expect.any(Array),
    ));
    expect(shiftsApi.getMine).toHaveBeenCalledWith({ projectId: 7, unresolvedOnly: true });
    expect(projectsApi.update).not.toHaveBeenCalled();

    const buttons = (showSheet as jest.Mock).mock.calls.at(-1)[2];
    buttons[1].onPress();
    await waitFor(() => expect(projectsApi.update).toHaveBeenCalledWith(7, { status: 'cancelled' }));
  });

  it('shows a status change the server refuses inside the edit sheet, not behind it', async () => {
    (projectsApi.update as jest.Mock).mockRejectedValue({
      code: '22023',
      message: 'Invalid transition from closure_submitted to paused',
    });
    const { getByText, queryByText, getAllByText } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    fireEvent.press(getByText('Pausar'));
    await waitFor(() => expect(showSheet).toHaveBeenCalledWith('Confirmar', expect.any(String), expect.any(Array)));
    const buttons = (showSheet as jest.Mock).mock.calls.at(-1)[2];
    buttons[1].onPress();

    const message = 'No se pudo cambiar el estado';
    await waitFor(() => expect(getByText(message)).toBeTruthy());
    expect(isInsideModal(getByText(message))).toBe(true);
    expect(queryByText(/Invalid transition/)).toBeNull();
    expect(getAllByText('Pozo Norte').length).toBeGreaterThan(0);
  });

  it('creates no well on the phone when there is no session', async () => {
    await AsyncStorage.removeItem('authToken');
    // Without a session the operator list comes from the phone's own cache.
    (query as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM projects p')) return listedProjects;
      if (sql.includes('FROM operators')) return [{ id: 'op-1', name: 'Ana Operadora', full_name: 'Ana Operadora', status: 'active' }];
      return [];
    });
    const { getByText, getByTestId, getAllByText, queryByTestId } = render(<ProjectsTab />);
    await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());

    fireEvent.press(getByText('+ Nuevo'));
    // The name field mounts once the sheet reports it is shown (the device settle step).
    fireEvent(getByTestId('create-project-modal'), 'show');
    await waitFor(() => expect(queryByTestId('create-project-name-input')).toBeTruthy());
    fireEvent.changeText(getByTestId('create-project-name-input'), 'Pozo Nuevo');
    fireEvent.changeText(getByTestId('create-project-target-depth-input'), '50');
    await waitFor(() => expect(getAllByText('Ana Operadora').length).toBeGreaterThan(0));
    fireEvent.press(getAllByText('Ana Operadora')[0]);
    fireEvent.press(getByText('Crear y Asignar Proyecto'));

    await waitFor(() => expect(getByText(/Tu sesión venció/)).toBeTruthy());
    expect(projectsApi.create).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT OR REPLACE INTO projects/), expect.anything());
  });

  it('assigns no material on the phone when there is no session', async () => {
    await AsyncStorage.removeItem('authToken');
    (productV2Api.getCatalog as jest.Mock).mockResolvedValue([{
      id: 1,
      name: 'Cemento',
      unit: 'bolsa',
      catalog_variants: [{ id: 10, display_name: 'estandar', active: true }],
    }]);
    const { getByText, getByTestId, getAllByText, queryByText } = render(<ProjectsTab />);
    await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());

    fireEvent.press(getByText('Materiales'));
    await waitFor(() => expect(getByTestId('assign-material-option-Cemento')).toBeTruthy());
    fireEvent.press(getByTestId('assign-material-option-Cemento'));
    fireEvent.changeText(getByTestId('assign-material-quantity'), '5');
    const assignButtons = getAllByText('Asignar Material');
    fireEvent.press(assignButtons[assignButtons.length - 1]);

    await waitFor(() => expect(queryByText(/Tu sesión venció/)).toBeTruthy());
    expect(materialsApi.assignToProject).not.toHaveBeenCalled();
    expect(showSheet).not.toHaveBeenCalledWith('Éxito', expect.anything());
  });
});
