import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Modal } from 'react-native';

import { productV2Api } from '../src/api/supabase-product-v2';
import CatalogoTab from '../src/components/admin/CatalogoTab';
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

jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: {
    getCatalog: jest.fn(),
    saveCatalogMaterial: jest.fn(),
    saveCatalogVariant: jest.fn(),
  },
}));

// True when the element is rendered inside a <Modal>: the page banner is not.
const isInsideModal = (node: any): boolean => {
  for (let current = node; current; current = current.parent) {
    if (current.type === Modal) return true;
  }
  return false;
};

const mockGetCatalog = productV2Api.getCatalog as jest.MockedFunction<typeof productV2Api.getCatalog>;
const mockSaveMaterial = productV2Api.saveCatalogMaterial as jest.MockedFunction<typeof productV2Api.saveCatalogMaterial>;

describe('CatalogoTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCatalog.mockResolvedValue([]);
    mockSaveMaterial.mockResolvedValue({
      id: 7,
      name: 'Bentonita',
      material_type: 'consumable',
      unit: 'bolsa',
      measurement_method: 'quantity',
      active: true,
      catalog_variants: [],
    });
  });

  it('loads the complete catalog, including inactive rows for admin filtering', async () => {
    const { getByText } = render(<CatalogoTab />);

    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledWith(true));
    expect(getByText('No hay materiales que coincidan con los filtros.')).toBeTruthy();
  });

  it('creates a catalog material through the protected product API', async () => {
    const { getByTestId } = render(<CatalogoTab />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalled());

    fireEvent.press(getByTestId('catalog-new-material'));
    fireEvent.changeText(getByTestId('catalog-material-name'), 'Bentonita');
    fireEvent.changeText(getByTestId('catalog-material-unit'), 'bolsa');
    fireEvent.press(getByTestId('catalog-save-material'));

    await waitFor(() => expect(mockSaveMaterial).toHaveBeenCalledWith({
      id: undefined,
      name: 'Bentonita',
      unit: 'bolsa',
      materialType: 'consumable',
      measurementMethod: 'quantity',
      externalCode: undefined,
      active: true,
    }));
    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
  });

  it('warns before changing a unit, because existing allocations keep the old one', async () => {
    mockGetCatalog.mockResolvedValue([{
      id: 3,
      name: 'Cemento',
      material_type: 'consumable',
      unit: 'bolsa',
      measurement_method: 'quantity',
      active: true,
      external_code: null,
      catalog_variants: [],
    }] as any);
    const { getByText, getByTestId } = render(<CatalogoTab />);
    await waitFor(() => expect(getByText('Cemento')).toBeTruthy());

    fireEvent.press(getByText('Editar'));
    fireEvent.changeText(getByTestId('catalog-material-unit'), 'kg');
    fireEvent.press(getByTestId('catalog-save-material'));

    expect(mockSaveMaterial).not.toHaveBeenCalled();
    expect(showSheet).toHaveBeenCalledWith(
      'Cambiar la unidad',
      expect.stringContaining('conservan la unidad "bolsa"'),
      expect.any(Array),
    );

    const buttons = (showSheet as jest.Mock).mock.calls[0][2];
    buttons[1].onPress();
    await waitFor(() => expect(mockSaveMaterial).toHaveBeenCalledWith(expect.objectContaining({ id: 3, unit: 'kg' })));
  });

  it('shows a duplicate material name inside the open form, in Spanish', async () => {
    mockSaveMaterial.mockRejectedValue({
      code: '23505',
      message: 'duplicate key value violates unique constraint "catalog_materials_normalized_name_uidx"',
      details: 'Key (normalized_name)=(cemento) already exists.',
    });
    const { getByTestId, getByText, queryByText } = render(<CatalogoTab />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalled());

    fireEvent.press(getByTestId('catalog-new-material'));
    fireEvent.changeText(getByTestId('catalog-material-name'), 'Cemento');
    fireEvent.changeText(getByTestId('catalog-material-unit'), 'bolsa');
    fireEvent.press(getByTestId('catalog-save-material'));

    // The banner must be inside the form: the page banner sits behind the modal.
    await waitFor(() => expect(getByText('Ya existe un material con ese nombre.')).toBeTruthy());
    expect(isInsideModal(getByText('Ya existe un material con ese nombre.'))).toBe(true);
    expect(getByTestId('catalog-save-material')).toBeTruthy();
    expect(queryByText(/23505|duplicate key/)).toBeNull();
  });
});
