/**
 * The bar form on Progreso (audit OPA-7, OPA-8, and the quantity reader OPA-6 /
 * OPB-7 for the water level). Real SQLite with the app's schema; the network is fake.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockShowSheet = jest.fn();

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) ?? null;
  return { execute, query, queryFirst, runInTransaction: async (task: any) => task({ execute, query, queryFirst }) };
});
jest.mock('../src/db/index', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  const Picker = ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children);
  Picker.Item = ({ label }: { label: string }) => ReactModule.createElement(Text, null, label);
  return { Picker };
});
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: any[]) => mockShowSheet(...args),
}));
jest.mock('../src/components/shared/PhotoCapture', () => () => null);
jest.mock('../src/api/projectCache', () => {
  const project = { id: 7, name: 'Pozo Siete', default_bar_length: 3, default_bar_diameter: '6 pulgadas' };
  return {
    loadAssignedProjects: async () => [project],
    refreshAssignedProjects: async () => [project],
  };
});
jest.mock('../src/sync/serverBarsCache', () => ({ cacheServerBars: async () => undefined }));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutboxIncludingNew: jest.fn(async () => undefined),
}));

import ProgresoTab from '../src/components/operator/ProgresoTab';

const NOW = '2026-11-08T10:00:00Z';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['operatorId', 'ana'], ['authToken', 'token']]);
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana')`).run();
  mockSqlite.prepare(
    `INSERT INTO projects (id, name, assigned_operator_id, status, default_bar_length, default_bar_diameter)
     VALUES (7, 'Pozo Siete', 'ana', 'active', 3, '6 pulgadas')`,
  ).run();
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at, handover_confirmed)
     VALUES ('s1', 's1', 'e1', 7, 'ana', 'open', ?, 1)`,
  ).run(NOW);
});

afterEach(() => mockSqlite.close());

const startInput = (screen: ReturnType<typeof render>) => screen.getAllByPlaceholderText('HH:MM')[0];
const endInput = (screen: ReturnType<typeof render>) => screen.getAllByPlaceholderText('HH:MM')[1];
const barRows = () => mockSqlite.prepare(
  'SELECT bar_number, depth_start, depth_end, length, water_level FROM drilling_bar_entries ORDER BY bar_number',
).all();
const sheetBodies = (title: string) => mockShowSheet.mock.calls.filter(([t]) => t === title).map(([, body]) => body);

describe('the bar length (OPA-7)', () => {
  it('can be changed from the well default before saving, and the depth follows it', async () => {
    const screen = render(<ProgresoTab />);
    await screen.findByText('Guardar Progreso');
    // The well's default (3 m) has loaded once the planned depth shows it.
    await screen.findByText('3.00 m');

    fireEvent.changeText(screen.getByPlaceholderText('3'), '2,5');
    fireEvent.changeText(startInput(screen), '06:00');
    fireEvent.changeText(endInput(screen), '06:30');
    fireEvent.press(screen.getByText('Arena'));
    fireEvent.press(screen.getByText('Guardar Progreso'));

    await waitFor(() => expect(barRows()).toHaveLength(1));
    expect(barRows()[0]).toMatchObject({ bar_number: 1, depth_start: 0, depth_end: 2.5, length: 2.5 });
  });

  it('refuses a length outside 0,5 to 50 m', async () => {
    const screen = render(<ProgresoTab />);
    await screen.findByText('Guardar Progreso');
    await screen.findByText('3.00 m');
    fireEvent.changeText(screen.getByPlaceholderText('3'), '0,2');
    fireEvent.changeText(startInput(screen), '06:00');
    fireEvent.changeText(endInput(screen), '06:30');
    fireEvent.press(screen.getByText('Arena'));
    fireEvent.press(screen.getByText('Guardar Progreso'));

    await waitFor(() => expect(sheetBodies('Longitud de barra')).toHaveLength(1));
    expect(sheetBodies('Longitud de barra')[0]).toBe('La longitud debe estar entre 0,5 y 50 m.');
    expect(barRows()).toHaveLength(0);
  });
});

describe('the start time (OPA-8)', () => {
  it('is not stamped when the tab opens; it is set by the first edit of the bar', async () => {
    const screen = render(<ProgresoTab />);
    await screen.findByText('Guardar Progreso');
    expect(startInput(screen).props.value).toBe('');

    fireEvent.changeText(screen.getByPlaceholderText('Ej: 6 pulgadas'), '6 pulgadas');

    expect(startInput(screen).props.value).toMatch(/^\d{2}:\d{2}$/);
  });

  it('a bar saved without a start time is refused, not stamped with the tab-open time', async () => {
    const screen = render(<ProgresoTab />);
    await screen.findByText('Guardar Progreso');
    await screen.findByText('3.00 m');
    // Only the end time is typed: that edit does not start the bar.
    fireEvent.changeText(endInput(screen), '06:30');
    fireEvent.press(screen.getByText('Guardar Progreso'));

    await waitFor(() => expect(sheetBodies('Error')).toContain('Ingresá la hora de inicio de la barra (o tocá "Ahora")'));
    expect(barRows()).toHaveLength(0);
  });
});

describe('the water level (OPA-6 / OPB-7)', () => {
  it('refuses "1.500" with the question instead of saving 1.5', async () => {
    const screen = render(<ProgresoTab />);
    await screen.findByText('Guardar Progreso');
    fireEvent.changeText(startInput(screen), '06:00');
    fireEvent.changeText(endInput(screen), '06:30');
    fireEvent.press(screen.getByText('Arena'));
    fireEvent.changeText(screen.getByPlaceholderText('Profundidad del agua'), '1.500');
    fireEvent.press(screen.getByText('Guardar Progreso'));

    await waitFor(() => expect(sheetBodies('Error')).toContain('Nivel de agua: ¿1500 o 1,5? Escribí 1500 o 1,5'));
    expect(barRows()).toHaveLength(0);
  });
});

describe('"Limpiar Formulario" (OPA-9)', () => {
  it('asks first, and only "Sí, limpiar" clears the form', async () => {
    const screen = render(<ProgresoTab />);
    await screen.findByText('Guardar Progreso');
    fireEvent.changeText(screen.getByPlaceholderText('Observaciones, problemas encontrados, etc.'), 'piedra a 4 m');

    fireEvent.press(screen.getByText('Limpiar Formulario'));
    const call = mockShowSheet.mock.calls.find(([title]) => title === 'Limpiar formulario');
    expect(call).toBeTruthy();
    // Nothing is cleared until the operator confirms.
    expect(screen.getByDisplayValue('piedra a 4 m')).toBeTruthy();

    const confirm = (call![2] as Array<{ text: string; onPress?: () => void }>).find((b) => b.text === 'Sí, limpiar');
    const { act } = require('@testing-library/react-native');
    act(() => confirm!.onPress!());
    await waitFor(() => expect(screen.queryByDisplayValue('piedra a 4 m')).toBeNull());
  });
});
