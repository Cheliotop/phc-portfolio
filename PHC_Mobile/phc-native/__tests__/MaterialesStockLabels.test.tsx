/**
 * OPB-16: the Materiales screen shows quantities the operator can read and act on.
 *  - At most two decimals, with a decimal comma (12.299999999999999 reads "12,3").
 *  - A negative balance reads "Consumo mayor que lo asignado".
 *  - "Inicial" is "Asignado + recibido", because receipts are added to it.
 *  - An initial of 0 is never "Buen Stock".
 *  - No assigned well does not say the well was completed.
 * Real SQLite; every server call hangs, as on a phone with no internet.
 */
import { render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockNever = () => new Promise<never>(() => undefined);

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) =>
    mockSqlite.prepare(sql).get(...params) ?? null;
  return {
    execute, query, queryFirst,
    runInTransaction: async (task: any) => task({ execute, query, queryFirst }),
  };
});
jest.mock('../src/db/index', () => ({
  execute: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
}));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
// The server answers, with no wells for this operator, for the no-well case.
jest.mock('../src/api/supabase-projects', () => ({ projectsApi: { getAll: async () => [] } }));
jest.mock('../src/api/supabase-materials', () => ({
  materialsApi: { getProjectMaterials: () => mockNever(), getProjectConsumption: () => mockNever() },
}));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: { getClosingAssignments: () => mockNever(), getVisibleSecondaryAssignments: async () => [] },
}));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutbox: jest.fn(async () => undefined),
  drainOutboxIncludingNew: jest.fn(async () => undefined),
}));

import MaterialesTab from '../src/components/operator/MaterialesTab';

const addMaterial = (id: number, name: string, initial: number | null, current: number | null) => {
  mockSqlite.prepare(
    `INSERT INTO project_materials (id, project_id, material_name, initial_quantity, current_quantity, unit, active)
     VALUES (?, 7, ?, ?, ?, 'bolsas', 1)`,
  ).run(id, name, initial, current);
};

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['operatorId', 'ana'], ['authToken', 'token']]);
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana')`).run();
  mockSqlite.prepare(
    `INSERT INTO projects (id, name, assigned_operator_id, status) VALUES (7, 'Pozo Siete', 'ana', 'active')`,
  ).run();
});

afterEach(() => mockSqlite.close());

it('shows a float balance with two decimals and a decimal comma', async () => {
  addMaterial(31, 'Cemento', 12.6, 12.299999999999999);
  const screen = render(<MaterialesTab />);

  await screen.findByText('Cemento');
  expect(screen.getByText(/12,3 bolsas/)).toBeTruthy();
  expect(screen.getByText(/12,6 bolsas/)).toBeTruthy();
  expect(screen.queryByText(/12\.299999/)).toBeNull();
});

it('reads a negative balance as a consumption above what was assigned', async () => {
  addMaterial(32, 'Arena', 10, -3);
  const screen = render(<MaterialesTab />);

  await screen.findByText('Arena');
  expect(screen.getByText('Consumo mayor que lo asignado')).toBeTruthy();
  expect(screen.queryByText(/-3 bolsas/)).toBeNull();
});

it('labels the initial figure as assigned plus received', async () => {
  addMaterial(33, 'Grava', 8, 6);
  const screen = render(<MaterialesTab />);

  await screen.findByText('Grava');
  expect(screen.getByText('Asignado + recibido:')).toBeTruthy();
  expect(screen.queryByText('Inicial:')).toBeNull();
});

it('never calls a material with nothing assigned "Buen Stock"', async () => {
  addMaterial(34, 'Bentonita', 0, 5);
  const screen = render(<MaterialesTab />);

  await screen.findByText('Bentonita');
  expect(screen.queryByText(/Buen Stock/)).toBeNull();
  expect(screen.getByText(/Stock Crítico/)).toBeTruthy();
});

it('does not say the well is completed when no well is assigned', async () => {
  mockSqlite.prepare('DELETE FROM projects').run();
  const screen = render(<MaterialesTab />);

  await screen.findByText('No tenés un proyecto asignado. Hablá con el administrador.', {}, { timeout: 3000 });
  expect(screen.queryByText(/Este pozo ya fue completado/)).toBeNull();
});

it('speaks to the operator with vos', async () => {
  addMaterial(35, 'Caño PVC', 10, 8);
  const screen = render(<MaterialesTab />);

  await screen.findByText(/abrí Turnos y completá el informe al finalizar/);
});
