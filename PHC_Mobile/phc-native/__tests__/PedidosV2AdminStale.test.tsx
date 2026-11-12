import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { pedidosApi } from '../src/api/supabase-pedidos';
import PedidosV2AdminTab from '../src/components/admin/PedidosV2AdminTab';
import { showSheet } from '../src/components/shared/Sheet';

jest.mock('@react-navigation/native', () => ({
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

jest.mock('../src/api/supabase-pedidos', () => ({
  pedidosApi: {
    getAll: jest.fn(),
    getAllPages: jest.fn(),
    getById: jest.fn(),
    decideItem: jest.fn(),
    closeManually: jest.fn(),
  },
}));

const mockGetAll = pedidosApi.getAll as jest.Mock;
const mockGetAllPages = pedidosApi.getAllPages as jest.Mock;
const mockGetById = pedidosApi.getById as jest.Mock;
const mockCloseManually = pedidosApi.closeManually as jest.Mock;

const pedido = (id: number, itemState: string) => ({
  id,
  pedido_number: `P-${id}`,
  kind: 'empresa',
  status: 'abierto',
  created_at: '2026-11-01T10:00:00Z',
  needed_by: null,
  project_id: 1,
  operator_id: 'op-1',
  justification: null,
  notes: null,
  closed_manually: false,
  projects: { name: 'Pozo Sur', location: null },
  profiles: { username: 'ana', full_name: 'Ana' },
  pedido_items: [{
    id: id * 10,
    material_name_snapshot: 'Cemento',
    requested_quantity: 5,
    unit_snapshot: 'bolsa',
    state: itemState,
    layer: 'extras',
    pedido_receipts: [],
  }],
});

describe('PedidosV2AdminTab on a stale list and with filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue({ data: [pedido(1, 'solicitado')] });
    mockGetAllPages.mockResolvedValue({ data: [pedido(2, 'recibido'), pedido(1, 'solicitado')] });
  });

  // Opens the manual close of the first pedido and confirms it, through the sheet.
  const closeFirstPedido = async (getByText: (text: string) => any, getByPlaceholderText: (text: string) => any) => {
    fireEvent.press(getByText('Cerrar pedido manualmente'));
    fireEvent.changeText(getByPlaceholderText('Explicá por qué se cierra el pedido'), 'Pedido duplicado');
    fireEvent.press(getByText('Revisar y cerrar'));
    await waitFor(() => expect(showSheet).toHaveBeenCalledWith(
      'Confirmar cierre manual',
      expect.any(String),
      expect.any(Array),
    ));
    const buttons = (showSheet as jest.Mock).mock.calls.at(-1)[2];
    buttons[1].onPress();
  };

  it('refuses a manual close when the pedido changed after the list was drawn', async () => {
    mockGetById.mockResolvedValue(pedido(1, 'aprobado'));
    const { getByText, getByPlaceholderText } = render(<PedidosV2AdminTab />);
    await waitFor(() => expect(getByText('P-1')).toBeTruthy());

    await closeFirstPedido(getByText, getByPlaceholderText);

    await waitFor(() => expect(showSheet).toHaveBeenCalledWith(
      'El pedido cambió',
      expect.stringContaining('Revisá los datos actualizados'),
    ));
    expect(mockGetById).toHaveBeenCalledWith(1);
    expect(mockCloseManually).not.toHaveBeenCalled();
  });

  it('closes the pedido when nothing changed since the list was drawn', async () => {
    mockGetById.mockResolvedValue(pedido(1, 'solicitado'));
    mockCloseManually.mockResolvedValue({});
    const { getByText, getByPlaceholderText } = render(<PedidosV2AdminTab />);
    await waitFor(() => expect(getByText('P-1')).toBeTruthy());

    await closeFirstPedido(getByText, getByPlaceholderText);

    await waitFor(() => expect(mockCloseManually).toHaveBeenCalledWith(1, 'Pedido duplicado'));
  });

  it('searches every pedido on the server once a filter is active', async () => {
    const { getByText, queryByText } = render(<PedidosV2AdminTab />);
    await waitFor(() => expect(getByText('P-1')).toBeTruthy());
    expect(queryByText('P-2')).toBeNull();
    expect(mockGetAllPages).not.toHaveBeenCalled();

    fireEvent.press(getByText('Por decidir'));

    await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
    await waitFor(() => expect(getByText('P-1')).toBeTruthy());
    // P-2 is already received, so the decision filter hides it: nothing is hidden
    // only because it sat on a page that was not loaded.
    expect(queryByText('P-2')).toBeNull();
  });
});
