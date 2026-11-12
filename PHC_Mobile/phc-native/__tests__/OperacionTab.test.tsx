import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { productV2Api } from '../src/api/supabase-product-v2';
import { projectsApi } from '../src/api/supabase-projects';
import { shiftsApi } from '../src/api/supabase-shifts';
import OperacionTab from '../src/components/admin/OperacionTab';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(callback, [callback]);
  },
}));

jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  // Exposes onValueChange on the host node so tests can pick a value with fireEvent.
  const Picker = ({ children, onValueChange, testID }: { children: React.ReactNode; onValueChange?: (value: string) => void; testID?: string }) =>
    ReactModule.createElement(View, { testID, onValueChange }, children);
  Picker.Item = ({ label }: { label: string }) => ReactModule.createElement(Text, null, label);
  return { Picker };
});

jest.mock('../src/api/supabase-projects', () => ({ projectsApi: { getAll: jest.fn() } }));
jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: {
    getAll: jest.fn(),
    getOperatorDirectory: jest.fn(),
    getAllOperatorMetrics: jest.fn(),
  },
}));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: { getAudit: jest.fn(), recordCorrection: jest.fn(), getCorrectionRecord: jest.fn() },
}));

describe('OperacionTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (projectsApi.getAll as jest.Mock).mockResolvedValue([]);
    (shiftsApi.getOperatorDirectory as jest.Mock).mockResolvedValue([]);
    (shiftsApi.getAll as jest.Mock).mockResolvedValue([]);
    (shiftsApi.getAllOperatorMetrics as jest.Mock).mockResolvedValue([]);
    (productV2Api.getAudit as jest.Mock).mockResolvedValue([]);
    (productV2Api.getCorrectionRecord as jest.Mock).mockResolvedValue(null);
    (productV2Api.recordCorrection as jest.Mock).mockResolvedValue({});
  });

  it('loads shifts, accountability metrics, and append-only audit data', async () => {
    const { getByText, getByTestId } = render(<OperacionTab />);

    await waitFor(() => expect(shiftsApi.getAll).toHaveBeenCalledWith({
      projectId: undefined,
      operatorId: undefined,
      status: undefined,
    }));
    expect(shiftsApi.getAllOperatorMetrics).toHaveBeenCalledWith([]);
    expect(productV2Api.getAudit).toHaveBeenCalledWith({
      projectId: undefined,
      actorId: undefined,
      entityType: undefined,
      action: undefined,
    });
    // One fetch feeds all three views, so the data is present regardless of
    // which view is showing. Only the audit view renders the audit list.
    fireEvent.press(getByTestId('operation-view-historial'));
    expect(getByText('Historial del proyecto')).toBeTruthy();
  });

  it('shows one view at a time so the screen carries one question', async () => {
    const { getByText, queryByText, getByTestId } = render(<OperacionTab />);
    await waitFor(() => expect(productV2Api.getAudit).toHaveBeenCalled());

    // Turnos is the landing view; the audit log and the metric section are not
    // competing for the same screen. Assert on the shift subtitle rather than
    // the word "Turnos", which is also the segment button label.
    expect(getByText('0 turno(s) según los filtros')).toBeTruthy();
    expect(queryByText('Historial del proyecto')).toBeNull();
    expect(queryByText('Responsabilidad por operador')).toBeNull();

    fireEvent.press(getByTestId('operation-view-cumplimiento'));
    expect(getByText('Responsabilidad por operador')).toBeTruthy();
    expect(queryByText('Historial del proyecto')).toBeNull();

    fireEvent.press(getByTestId('operation-view-historial'));
    expect(getByText('Historial del proyecto')).toBeTruthy();
    expect(queryByText('Responsabilidad por operador')).toBeNull();
  });

  it('only offers audit filters on the audit view', async () => {
    const { getByText, queryByText, getByTestId } = render(<OperacionTab />);
    await waitFor(() => expect(productV2Api.getAudit).toHaveBeenCalled());

    // "Entidad" used to sit above the shift list while filtering something
    // else entirely, which is what made the screen feel arbitrary.
    expect(getByText('Estado del turno')).toBeTruthy();
    expect(queryByText('Entidad')).toBeNull();

    fireEvent.press(getByTestId('operation-view-historial'));
    expect(getByText('Entidad')).toBeTruthy();
    expect(queryByText('Estado del turno')).toBeNull();
  });

  it('blocks incomplete administrative corrections before calling Supabase', async () => {
    const { getByTestId, getByText } = render(<OperacionTab />);
    await waitFor(() => expect(productV2Api.getAudit).toHaveBeenCalled());

    fireEvent.press(getByTestId('operation-view-historial'));
    fireEvent.press(getByTestId('operation-open-correction'));
    fireEvent.press(getByTestId('operation-save-correction'));

    // The banner has to be repeated inside the modal; the one in the main
    // scroll would be hidden behind it.
    expect(getByText('Registro, campo, valor corregido y motivo son obligatorios.')).toBeTruthy();
    expect(productV2Api.recordCorrection).not.toHaveBeenCalled();
  });
  it('finds the record inside the chosen well and shows it before saving', async () => {
    (productV2Api.getCorrectionRecord as jest.Mock).mockResolvedValue({
      id: 11, bar_number: 3, project_id: 5, depth_end: 10, projects: { name: 'Pozo Norte' },
    });
    const { getByTestId, findByTestId } = render(<OperacionTab />);
    await waitFor(() => expect(productV2Api.getAudit).toHaveBeenCalled());

    fireEvent.press(getByTestId('operation-view-historial'));
    fireEvent.press(getByTestId('operation-open-correction'));
    fireEvent(getByTestId('correction-project'), 'valueChange', '5');
    fireEvent.changeText(getByTestId('correction-entity-id'), '3');

    expect(await findByTestId('correction-preview')).toBeTruthy();
    expect(productV2Api.getCorrectionRecord).toHaveBeenCalledWith('drilling_bars', 5, '3');

    // A decimal comma is a number on a numeric field, not the text "12,5".
    fireEvent.changeText(getByTestId('correction-value'), '12,5');
    fireEvent.changeText(getByTestId('correction-reason'), 'Error de tipeo en la barra');
    fireEvent.press(getByTestId('operation-save-correction'));

    await waitFor(() => expect(productV2Api.recordCorrection).toHaveBeenCalledWith({
      entityType: 'drilling_bars',
      entityId: '11',
      fieldName: 'depth_end',
      correctedValue: 12.5,
      reason: 'Error de tipeo en la barra',
    }));
  });

  it('refuses a text value on a numeric field before calling Supabase', async () => {
    (productV2Api.getCorrectionRecord as jest.Mock).mockResolvedValue({
      id: 11, bar_number: 3, project_id: 5, depth_end: 10, projects: { name: 'Pozo Norte' },
    });
    const { getByTestId, findByTestId, getByText } = render(<OperacionTab />);
    await waitFor(() => expect(productV2Api.getAudit).toHaveBeenCalled());

    fireEvent.press(getByTestId('operation-view-historial'));
    fireEvent.press(getByTestId('operation-open-correction'));
    fireEvent(getByTestId('correction-project'), 'valueChange', '5');
    fireEvent.changeText(getByTestId('correction-entity-id'), '3');
    await findByTestId('correction-preview');

    fireEvent.changeText(getByTestId('correction-value'), 'abc');
    fireEvent.changeText(getByTestId('correction-reason'), 'Error de tipeo en la barra');
    fireEvent.press(getByTestId('operation-save-correction'));

    expect(getByText('Ingresá un número. Podés usar coma decimal, por ejemplo 12,5.')).toBeTruthy();
    expect(productV2Api.recordCorrection).not.toHaveBeenCalled();
  });

  it('does not allow saving when the typed bar is not in the chosen well', async () => {
    (productV2Api.getCorrectionRecord as jest.Mock).mockResolvedValue(null);
    const { getByTestId, findByText } = render(<OperacionTab />);
    await waitFor(() => expect(productV2Api.getAudit).toHaveBeenCalled());

    fireEvent.press(getByTestId('operation-view-historial'));
    fireEvent.press(getByTestId('operation-open-correction'));
    fireEvent(getByTestId('correction-project'), 'valueChange', '5');
    fireEvent.changeText(getByTestId('correction-entity-id'), '99');

    expect(await findByText('Ese pozo no tiene una barra con ese número.')).toBeTruthy();
    fireEvent.changeText(getByTestId('correction-value'), '12');
    fireEvent.changeText(getByTestId('correction-reason'), 'Error de tipeo en la barra');
    fireEvent.press(getByTestId('operation-save-correction'));
    expect(productV2Api.recordCorrection).not.toHaveBeenCalled();
  });

  it('keeps shifts and history on screen when only the operator metrics fail', async () => {
    (shiftsApi.getAllOperatorMetrics as jest.Mock).mockRejectedValue(new Error('timeout'));
    const { getByText } = render(<OperacionTab />);

    await waitFor(() => expect(getByText('0 turno(s) según los filtros')).toBeTruthy());
    expect(getByText('No se pudieron cargar las métricas por operador. Los turnos y el historial sí se cargaron.')).toBeTruthy();
  });
});
