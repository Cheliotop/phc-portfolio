import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

import { materialsApi } from '../src/api/supabase-materials';
import { operatorsApi } from '../src/api/supabase-operators';
import { projectsApi } from '../src/api/supabase-projects';
import { productV2Api } from '../src/api/supabase-product-v2';
import { query } from '../src/db/db';
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
  projectsApi: { getAll: jest.fn(), update: jest.fn() },
}));
jest.mock('../src/api/supabase-operators', () => ({
  operatorsApi: { getAllActivePages: jest.fn(), getActive: jest.fn() },
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
  { id: 'op-3', full_name: 'Carla Cierre', username: 'carla', is_active: true, role: 'operator' },
];

// The operator, operador 2 and closer lists render in that order, so the
// closer is always the last match of a name.
const pressLast = (getAllByText: (text: string) => any[], text: string) => {
  const matches = getAllByText(text);
  fireEvent.press(matches[matches.length - 1]);
};

const openEditor = async (getByText: (t: string) => any, queryByText: (t: string) => any) => {
  await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());
  fireEvent.press(getByText('Editar'));
  await waitFor(() => expect(productV2Api.getSecondaryOperators).toHaveBeenCalledWith(7));
  await waitFor(() => expect(queryByText('Cargando el equipo del pozo…')).toBeNull());
};

describe('ProjectsTab well edit: one save for the equipo', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.setItem('authToken', 'token-for-test');
    (projectsApi.getAll as jest.Mock).mockResolvedValue([project]);
    (projectsApi.update as jest.Mock).mockResolvedValue({});
    (operatorsApi.getAllActivePages as jest.Mock).mockResolvedValue(operators);
    (productV2Api.getClosingAssignments as jest.Mock).mockResolvedValue([]);
    (productV2Api.getSecondaryOperators as jest.Mock).mockResolvedValue([]);
    (productV2Api.setProjectEquipo as jest.Mock).mockResolvedValue({});
    (productV2Api.setClosingOperator as jest.Mock).mockResolvedValue({});
    (productV2Api.getCatalog as jest.Mock).mockResolvedValue([]);
    (query as jest.Mock).mockImplementation(async (sql: string) => (sql.includes('FROM projects p') ? [project] : []));
    (materialsApi.getProjectMaterials as jest.Mock).mockResolvedValue({ data: [] });
    (materialsApi.getProjectConsumption as jest.Mock).mockResolvedValue({ data: [] });
  });

  it('saves a new closing operator with "Guardar cambios" instead of a separate button', async () => {
    const { getByText, queryByText, getAllByText, getByTestId } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    expect(queryByText('Asignar cierre')).toBeNull();
    pressLast(getAllByText, 'Carla Cierre');
    fireEvent.press(getByTestId('edit-project-save'));

    await waitFor(() => expect(productV2Api.setClosingOperator).toHaveBeenCalledWith(7, 'op-3'));
    expect(productV2Api.setProjectEquipo).not.toHaveBeenCalled();
  });

  it('writes operador 2 through set_project_equipo in the same save as the rest of the well', async () => {
    const { getByText, queryByText, getAllByText, getByTestId } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    // Operador 2 is the second list: pick Beto there (the first match is in the operator list).
    const beto = getAllByText('Beto Operador');
    fireEvent.press(beto[1]);
    fireEvent.press(getByTestId('edit-project-save'));

    await waitFor(() => expect(productV2Api.setProjectEquipo).toHaveBeenCalledWith(7, 'op-1', 'op-2'));
    expect(productV2Api.setClosingOperator).not.toHaveBeenCalled();
    await waitFor(() => expect(projectsApi.update).toHaveBeenCalledWith(7, {
      name: 'Pozo Norte',
      location: null,
      target_depth: 40,
    }));
  });

  it('does not write operador 2 until "Guardar cambios" is pressed', async () => {
    const { getByText, queryByText, getAllByText } = render(<ProjectsTab />);
    await openEditor(getByText, queryByText);

    fireEvent.press(getAllByText('Beto Operador')[1]);

    expect(productV2Api.setProjectEquipo).not.toHaveBeenCalled();
    expect(productV2Api.getSecondaryOperators).toHaveBeenCalledTimes(1);
  });

  it('assigns the unit from the catalog and no longer takes a typed unit', async () => {
    (productV2Api.getCatalog as jest.Mock).mockResolvedValue([{
      id: 1,
      name: 'Cemento',
      unit: 'bolsa',
      catalog_variants: [{ id: 10, display_name: 'estandar', active: true }],
    }]);
    const { getByText, queryByText, getByTestId } = render(<ProjectsTab />);
    await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());

    fireEvent.press(getByText('Materiales'));
    await waitFor(() => expect(getByTestId('assign-material-option-Cemento')).toBeTruthy());
    fireEvent.press(getByTestId('assign-material-option-Cemento'));

    expect(getByTestId('assign-material-unit').props.children).toBe('bolsa');
    expect(queryByText('Unidad:')).toBeNull();
  });
});
