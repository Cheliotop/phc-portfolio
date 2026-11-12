/**
 * The pedido and receipt forms on the operator's phone (audit OPB-5, OPB-6, OPB-9,
 * OPB-10, OPB-20, and the quantity reader OPA-6 / OPB-7). Real SQLite with the app's
 * schema; the network is fake.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockShowSheet = jest.fn();
const mockGetAll = jest.fn();

jest.mock('../src/db/db', () => {
  // Same shape as the app's db layer: lastInsertRowid becomes lastInsertRowId.
  const execute = async (sql: string, params: any[] = []) => {
    const result = mockSqlite.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  };
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) =>
    mockSqlite.prepare(sql).get(...params) ?? null;
  return { execute, query, queryFirst, runInTransaction: async (task: any) => task({ execute, query, queryFirst }) };
});
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
// Picker options are tappable: pressing an option label picks its value.
jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  const Picker = ({ children, onValueChange }: any) => ReactModule.createElement(
    View,
    null,
    ReactModule.Children.map(children, (child: any) => ReactModule.createElement(
      Text,
      { onPress: () => onValueChange?.(child.props.value, 0) },
      child.props.label,
    )),
  );
  Picker.Item = () => null;
  return { Picker };
});
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: any[]) => mockShowSheet(...args),
}));
jest.mock('../src/api/projectCache', () => {
  const project = { id: 7, name: 'Pozo 7' };
  return { loadAssignedProjects: async () => [project], refreshAssignedProjects: async () => [project] };
});
jest.mock('../src/api/supabase-pedidos', () => ({
  pedidosApi: { getAll: (...args: any[]) => mockGetAll(...args) },
}));
const mockCatalog = jest.fn();
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: { getCatalog: (...args: any[]) => mockCatalog(...args) },
}));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutboxIncludingNew: jest.fn(async () => undefined),
}));

import PedidosV2Tab from '../src/components/operator/PedidosV2Tab';

const ANA = 'operator-ana';

const approvedPedido = (received: number, approved: number, state: string) => ({
  id: 55,
  pedido_number: 'P-55',
  project_id: 7,
  kind: 'empresa',
  priority: 'Normal',
  status: 'Aprobado',
  justification: null,
  created_at: '2026-11-07T10:00:00.000Z',
  projects: { name: 'Pozo 7' },
  pedido_items: [{
    id: 501, material_name_snapshot: 'Bentonita', requested_quantity: approved, approved_quantity: approved,
    received_quantity: received, unit_snapshot: 'bolsa', state, layer: 'extras',
  }],
});

/** Calls the nearest onPress handler the way two taps in one frame would, with no re-render between. */
const tapTwice = (node: any) => {
  let current = node;
  while (current && !current.props.onPress) current = current.parent;
  current.props.onPress();
  current.props.onPress();
};

const sheetTitles = () => mockShowSheet.mock.calls.map(([title]) => title);
/** The body of the nth sheet with this title (0-based; the first by default). */
const sheetBody = (title: string, nth = 0) => mockShowSheet.mock.calls.filter(([t]) => t === title)[nth]?.[1];

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Ana')`).run(ANA);
  mockSqlite.prepare(
    `INSERT INTO projects (id, name, assigned_operator_id, status) VALUES (7, 'Pozo 7', ?, 'active')`,
  ).run(ANA);
  await AsyncStorage.setItem('operatorId', ANA);
  mockGetAll.mockResolvedValue({ data: [] });
  mockCatalog.mockRejectedValue(new Error('Sin conexión'));
});

afterEach(() => mockSqlite.close());

describe('creating a pedido', () => {
  it('a double tap on "Guardar pedido" saves one pedido, not two (OPB-9)', async () => {
    const screen = render(<PedidosV2Tab />);
    await screen.findByText('+ Nuevo');
    fireEvent.press(screen.getByText('+ Nuevo'));
    fireEvent.changeText(screen.getByPlaceholderText('Motivo operativo'), 'Falta caño para el entubado');
    fireEvent.changeText(screen.getByPlaceholderText('Material o equipo'), 'Caño PVC');
    fireEvent.changeText(screen.getByPlaceholderText('Cantidad'), '2,5');
    fireEvent.changeText(screen.getByPlaceholderText('Unidad'), 'metros');

    tapTwice(screen.getByText('Guardar pedido'));

    await waitFor(() => expect(sheetTitles()).toContain('Pedido guardado'));
    const rows = mockSqlite.prepare('SELECT COUNT(*) AS n FROM supply_requests').get();
    expect(rows.n).toBe(1);
  });

  it('asks for the justification with the vos form', async () => {
    const screen = render(<PedidosV2Tab />);
    await screen.findByText('+ Nuevo');
    fireEvent.press(screen.getByText('+ Nuevo'));
    fireEvent.changeText(screen.getByPlaceholderText('Material o equipo'), 'Caño PVC');
    fireEvent.changeText(screen.getByPlaceholderText('Cantidad'), '2');
    fireEvent.changeText(screen.getByPlaceholderText('Unidad'), 'metros');

    fireEvent.press(screen.getByText('Guardar pedido'));

    await waitFor(() => expect(sheetTitles()).toContain('Falta justificación'));
    expect(sheetBody('Falta justificación')).toBe('Explicá por qué la empresa debe proveer este pedido.');
  });

  it('refuses "1.500" with the question, instead of saving 1.5 (OPA-6 / OPB-7)', async () => {
    const screen = render(<PedidosV2Tab />);
    await screen.findByText('+ Nuevo');
    fireEvent.press(screen.getByText('+ Nuevo'));
    fireEvent.changeText(screen.getByPlaceholderText('Motivo operativo'), 'Falta caño para el entubado');
    fireEvent.changeText(screen.getByPlaceholderText('Material o equipo'), 'Caño PVC');
    fireEvent.changeText(screen.getByPlaceholderText('Cantidad'), '1.500');
    fireEvent.changeText(screen.getByPlaceholderText('Unidad'), 'metros');

    fireEvent.press(screen.getByText('Guardar pedido'));

    await waitFor(() => expect(sheetTitles()).toContain('Cantidad inválida'));
    expect(sheetBody('Cantidad inválida')).toBe('¿1500 o 1,5? Escribí 1500 o 1,5');
    expect(mockSqlite.prepare('SELECT COUNT(*) AS n FROM supply_requests').get().n).toBe(0);
  });

  it('a catalog item keeps its unit read-only; a free-text item can change it (OPB-5)', async () => {
    mockCatalog.mockResolvedValue([{
      id: 9,
      name: 'Caño PVC',
      unit: 'unidad',
      catalog_variants: [{ id: 90, display_name: 'Estándar', active: true }],
    }]);
    const screen = render(<PedidosV2Tab />);
    await screen.findByText('+ Nuevo');
    fireEvent.press(screen.getByText('+ Nuevo'));
    await waitFor(() => expect(screen.getByText('Caño PVC')).toBeTruthy());

    fireEvent.press(screen.getByText('Caño PVC'));

    expect(screen.getByPlaceholderText('Unidad').props.value).toBe('unidad');
    expect(screen.getByPlaceholderText('Unidad').props.editable).toBe(false);

    // Typing a name of its own leaves the catalog, so the unit is free again.
    fireEvent.changeText(screen.getByPlaceholderText('Material o equipo'), 'Tubo especial');
    expect(screen.getByPlaceholderText('Unidad').props.editable).not.toBe(false);
  });
});

describe('confirming a delivery', () => {
  const openReceiptFor = async (screen: ReturnType<typeof render>) => {
    await screen.findByText('Confirmar entrega');
    fireEvent.press(screen.getByText('Confirmar entrega'));
    await screen.findByText('Confirmar');
  };

  it('a double tap on "Confirmar" records one receipt (OPB-9)', async () => {
    mockGetAll.mockResolvedValue({ data: [approvedPedido(0, 10, 'aprobado')] });
    const screen = render(<PedidosV2Tab />);
    await openReceiptFor(screen);
    fireEvent.changeText(screen.getByPlaceholderText('Cantidad recibida'), '10');

    tapTwice(screen.getByText('Confirmar'));

    await waitFor(() => expect(sheetTitles()).toContain('Recepción guardada'));
    expect(mockSqlite.prepare('SELECT COUNT(*) AS n FROM pedido_receipts').get().n).toBe(1);
  });

  it('a partial delivery needs a quantity above zero and below what is pending (OPB-10)', async () => {
    mockGetAll.mockResolvedValue({ data: [approvedPedido(0, 10, 'aprobado')] });
    const screen = render(<PedidosV2Tab />);
    await openReceiptFor(screen);
    fireEvent.press(screen.getByText('Entrega parcial'));

    fireEvent.changeText(screen.getByPlaceholderText('Explicación obligatoria'), 'Llegó la mitad');

    // Empty, zero, and the full pending amount are each refused. Each try waits for
    // its own answer, the way a second tap comes after the first one has finished.
    fireEvent.changeText(screen.getByPlaceholderText('Cantidad recibida'), '');
    fireEvent.press(screen.getByText('Confirmar'));
    await waitFor(() => expect(sheetTitles()).toHaveLength(1));
    expect(sheetBody('Cantidad inválida', 0)).toBe('Ingresá una cantidad.');

    fireEvent.changeText(screen.getByPlaceholderText('Cantidad recibida'), '0');
    fireEvent.press(screen.getByText('Confirmar'));
    await waitFor(() => expect(sheetTitles()).toHaveLength(2));
    expect(sheetBody('Cantidad inválida', 1)).toContain('mayor que cero y menor que lo pendiente (10 bolsa)');

    fireEvent.changeText(screen.getByPlaceholderText('Cantidad recibida'), '10');
    fireEvent.press(screen.getByText('Confirmar'));
    await waitFor(() => expect(sheetTitles()).toHaveLength(3));
    expect(sheetBody('Cantidad inválida', 2)).toContain('mayor que cero y menor que lo pendiente (10 bolsa)');
    expect(mockSqlite.prepare('SELECT COUNT(*) AS n FROM pedido_receipts').get().n).toBe(0);
  });

  it('prefills what is pending rounded, so "1,6" is accepted (OPB-6)', async () => {
    // 2.3 approved, 0.7 already received: 2.3 - 0.7 is 1.5999999999999999 in floats.
    mockGetAll.mockResolvedValue({ data: [approvedPedido(0.7, 2.3, 'parcial')] });
    const screen = render(<PedidosV2Tab />);
    await openReceiptFor(screen);

    expect(screen.getByPlaceholderText('Cantidad recibida').props.value).toBe('1,6');

    fireEvent.press(screen.getByText('Confirmar'));
    await waitFor(() => expect(sheetTitles()).toContain('Recepción guardada'));
    expect(sheetTitles()).not.toContain('Cantidad inválida');
    expect(sheetTitles()).not.toContain('Recepción incompleta');
  });
});
