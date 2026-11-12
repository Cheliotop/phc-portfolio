/**
 * Code read O7: with Wi-Fi but no internet a server request can hang for 30
 * seconds or more. Pozos, Materiales, Muestras and Ficha waited on the server
 * before showing anything. Here the server never answers, and each screen must
 * still show what the phone already has. Real SQLite with the app's schema.
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
jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  const Picker = ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children);
  Picker.Item = ({ label }: { label: string }) => ReactModule.createElement(Text, null, label);
  return { Picker };
});
jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
jest.mock('../src/components/shared/PhotoCapture', () => () => null);
// Every server call hangs.
jest.mock('../src/api/supabase-projects', () => ({ projectsApi: { getAll: () => mockNever() } }));
jest.mock('../src/api/supabase-materials', () => ({
  materialsApi: { getProjectMaterials: () => mockNever(), getProjectConsumption: () => mockNever() },
}));
jest.mock('../src/api/supabase-water-samples', () => ({ waterSamplesApi: { getAll: () => mockNever() } }));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: {
    getClosingAssignments: () => mockNever(),
    getVisibleSecondaryAssignments: () => mockNever(),
  },
}));
jest.mock('../src/api/supabase-completion', () => ({ completionApi: { getPreview: () => mockNever() } }));
jest.mock('../src/sync/serverBarsCache', () => ({ cacheServerBars: () => mockNever() }));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutbox: jest.fn(async () => undefined),
  drainOutboxIncludingNew: jest.fn(async () => undefined),
}));
jest.mock('../src/sync/productV2Sync', () => ({
  syncPendingCompletionsV2: jest.fn(async () => ({ synced: 0, failed: 0 })),
  syncPendingCompletionDiscrepancies: jest.fn(async () => ({ synced: 0, failed: 0 })),
  syncPendingCompletionResubmissions: jest.fn(async () => ({ synced: 0, failed: 0 })),
}));

import PozosTab from '../src/components/operator/PozosTab';
import MaterialesTab from '../src/components/operator/MaterialesTab';
import WaterSamplesTab from '../src/components/operator/WaterSamplesTab';
import FichaTecnicaTab from '../src/components/operator/FichaTecnicaTab';

const emptyDossier = {
  project: { id: 7, name: 'Pozo 7' }, completion: null, bars: [], shifts: [], shift_handovers: [],
  photos: [], materials: [], consumption: [], samples: [], company_pedidos: [], corrections: [],
  discrepancies: [], attachments: [], reconciliations: [], audit: [],
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

it('Pozos shows the phone’s well while the server hangs', async () => {
  const screen = render(<PozosTab />);
  await screen.findByText('Pozo Siete');
});

it('Pozos keeps waiting on a first login, instead of saying there is no well', async () => {
  mockSqlite.prepare('DELETE FROM projects').run();
  const screen = render(<PozosTab />);
  await screen.findByText('Cargando proyecto asignado...');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText('No tenés un proyecto asignado. Hablá con el administrador.')).toBeNull();
});

it('Materiales shows the phone’s materials while the server hangs', async () => {
  mockSqlite.prepare(
    `INSERT INTO project_materials (id, project_id, material_name, initial_quantity, current_quantity, unit)
     VALUES (31, 7, 'Caño PVC', 10, 8, 'u')`,
  ).run();
  const screen = render(<MaterialesTab />);
  await screen.findByText('Caño PVC');
});

it('Muestras shows the phone’s samples while the server hangs', async () => {
  mockSqlite.prepare(
    `INSERT INTO water_samples (id, project_id, sample_number, operator_id, taken_at, sync_status)
     VALUES ('w1', 7, 3, 'ana', '2026-11-08T10:00:00Z', 'pending')`,
  ).run();
  const screen = render(<WaterSamplesTab />);
  await screen.findByText('Muestra #3');
});

it('Ficha shows the stored copy while the server hangs', async () => {
  await AsyncStorage.multiSet([
    ['phc_closing_assignments_ana', JSON.stringify([{ project_id: 7 }])],
    ['phc_ficha_preview_ana_7', JSON.stringify(emptyDossier)],
  ]);
  const screen = render(<FichaTecnicaTab />);
  await screen.findByPlaceholderText('Nivel estático (m) *', { includeHiddenElements: true });
});
