/**
 * The shift report's quantities (audit OPA-6 / OPB-7): "1.500" is refused with the
 * question instead of saved as 1.5, "2,5" is saved as 2.5. Real SQLite with the app's
 * schema; the network is fake and stays offline.
 */
import { act, fireEvent, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockShowSheet = jest.fn();
const mockDrain = jest.fn();
const mockGetMaterials = jest.fn();

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) =>
    mockSqlite.prepare(sql).get(...params) ?? null;
  return {
    execute,
    query,
    queryFirst,
    openDb: async () => mockSqlite,
    runInTransaction: async (task: (transaction: any) => Promise<any>) => {
      mockSqlite.exec('BEGIN');
      try {
        const result = await task({ execute, query, queryFirst });
        mockSqlite.exec('COMMIT');
        return result;
      } catch (error) {
        mockSqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
});
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
const mockRefreshProjects = jest.fn();
jest.mock('../src/api/projectCache', () => {
  const project = { id: 7, name: 'Pozo 7', location: 'Filadelfia' };
  return {
    loadAssignedProjects: async () => [project],
    refreshAssignedProjects: (...args: any[]) => mockRefreshProjects(...args),
  };
});
jest.mock('../src/api/supabase-materials', () => ({
  materialsApi: { getProjectMaterials: (...args: any[]) => mockGetMaterials(...args) },
}));
jest.mock('../src/api/supabase-shifts', () => ({
  shiftsApi: { getMine: async () => [] },
}));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutbox: (...args: any[]) => mockDrain(...args),
  drainOutboxIncludingNew: (...args: any[]) => mockDrain(...args),
}));

import TurnosTab from '../src/components/operator/TurnosTab';
import { notifyOperatorDataChanged } from '../src/events/operatorDataEvents';

const ANA = 'operator-ana';
const SHIFT = 'shift-1';

beforeEach(async () => {
  jest.clearAllMocks();
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES (?, 'Ana')`).run(ANA);
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', ?)`).run(ANA);
  mockSqlite.prepare(
    `INSERT INTO project_materials (id, project_id, material_name, current_quantity, initial_quantity, unit, layer, active)
     VALUES (31, 7, 'Caño', 10, 10, 'u', 'presupuesto', 1)`,
  ).run();
  await AsyncStorage.setItem('operatorId', ANA);
  // No signal: every server call fails, and the drain leaves the queue as it is.
  mockGetMaterials.mockRejectedValue(new Error('Sin conexión'));
  mockDrain.mockResolvedValue({ synced: 0, failed: 1 });
  mockRefreshProjects.mockResolvedValue([{ id: 7, name: 'Pozo 7', location: 'Filadelfia' }]);
});

afterEach(() => mockSqlite.close());

const addShift = () =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at,
                         handover_confirmed, usage_report_submitted)
     VALUES (?, ?, 'entry-1', 7, ?, 'open', ?, 1, 0)`,
  ).run(SHIFT, SHIFT, ANA, new Date(Date.now() - 60 * 60 * 1000).toISOString());

describe('the usage quantity on the shift report', () => {
  it('refuses "1.500" with the question and does not finish the shift', async () => {
    addShift();
    const screen = render(<TurnosTab />);
    await screen.findByText('Informe para finalizar');

    fireEvent.changeText(screen.getByPlaceholderText('0 u'), '1.500');
    expect(screen.getByText('¿1500 o 1,5? Escribí 1500 o 1,5')).toBeTruthy();
    fireEvent.press(screen.getByText('Finalizar turno e informe'));

    expect(mockShowSheet).toHaveBeenCalledWith('Cantidad inválida', 'Caño: ¿1500 o 1,5? Escribí 1500 o 1,5');
    expect(mockShowSheet.mock.calls.map(([title]) => title)).not.toContain('Finalizar turno');
    expect(mockSqlite.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE entity = 'shift_end'`).get().n).toBe(0);
  });

  it('saves "2,5" as 2.5 in the report', async () => {
    addShift();
    const screen = render(<TurnosTab />);
    await screen.findByText('Informe para finalizar');

    fireEvent.changeText(screen.getByPlaceholderText('0 u'), '2,5');
    expect(screen.getByText('= 2,5')).toBeTruthy();
    fireEvent.press(screen.getByText('Finalizar turno e informe'));
    const [, , buttons] = mockShowSheet.mock.calls.find(([title]) => title === 'Finalizar turno');
    await act(async () => {
      await buttons.find((button: any) => button.text === 'Finalizar').onPress();
    });

    await screen.findByText('Informe final guardado');
    const endRow = mockSqlite.prepare(`SELECT payload_json FROM sync_outbox WHERE entity = 'shift_end'`).get();
    expect(JSON.parse(endRow.payload_json).usage[0].quantity_used).toBe(2.5);
  });
});
