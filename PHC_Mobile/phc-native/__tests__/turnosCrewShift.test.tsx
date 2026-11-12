/**
 * The well's shift belongs to the equipo (code read OPA-1, OPA-2): a crew member
 * who is not the one who started it sees and ends the same open shift, does not
 * get "Iniciar turno", and records one join for it. Real SQLite with the app's
 * schema; the network is fake.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;

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
jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  const Picker = ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children);
  Picker.Item = ({ label }: { label: string }) => ReactModule.createElement(Text, null, label);
  return { Picker };
});
jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
jest.mock('../src/hooks/useOperatorDataRefresh', () => {
  const ReactModule = require('react');
  // Loads once when the tab mounts, like the real hook while the tab is focused.
  return {
    useOperatorDataRefresh: (refresh: () => unknown) => {
      ReactModule.useEffect(() => { void refresh(); }, []);
    },
  };
});
jest.mock('../src/sync/drainCoordinator', () => ({ drainOutboxIncludingNew: jest.fn(async () => undefined) }));
jest.mock('../src/sync/startShift', () => ({ startShiftOnServer: jest.fn() }));
jest.mock('../src/sync/productV2Sync', () => ({ getShiftSyncState: async () => 'pending' }));
jest.mock('../src/api/supabase-shifts', () => ({ shiftsApi: { getMine: async () => [] } }));
jest.mock('../src/api/supabase-materials', () => ({
  materialsApi: { getProjectMaterials: async () => ({ data: [] }) },
}));
jest.mock('../src/api/projectCache', () => {
  const project = { id: 7, name: 'Pozo 7', location: '', assigned_operator_id: 'ana' };
  return {
    loadAssignedProjects: async () => [project],
    refreshAssignedProjects: async () => [project],
  };
});

import TurnosTab from '../src/components/operator/TurnosTab';
import { showSheet } from '../src/components/shared/Sheet';

const NOW = new Date().toISOString();

const seed = ({ partnerIsCrew }: { partnerIsCrew: boolean }) => {
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana'), ('partner', 'Beto')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', 'ana')`).run();
  if (partnerIsCrew) {
    mockSqlite.prepare(`INSERT INTO project_secondary_operators (project_id, operator_id) VALUES (7, 'partner')`).run();
  }
  // A shift Ana started, already accepted by the server and still open.
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at, handover_confirmed)
     VALUES ('local-s1', 'srv-s1', 'entry-s1', 7, 'ana', 'open', ?, 0)`,
  ).run(NOW);
};

const joinRows = () => mockSqlite.prepare(
  `SELECT author_id FROM sync_outbox WHERE entity = 'shift_join' AND entity_id = 'local-s1'`,
).all();

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('operatorId', 'partner');
  await AsyncStorage.setItem('userName', 'Beto');
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  (showSheet as jest.Mock).mockClear();
});

afterEach(() => mockSqlite.close());

it('shows the well\'s open shift to a crew member instead of offering a new one, and records one join', async () => {
  seed({ partnerIsCrew: true });
  const first = render(<TurnosTab />);
  await first.findAllByText('Confirmar traspaso');
  expect(first.queryByText('Iniciar turno')).toBeNull();
  first.unmount();

  const second = render(<TurnosTab />);
  await second.findAllByText('Confirmar traspaso');
  second.unmount();

  expect(joinRows()).toEqual([{ author_id: 'partner' }]);
});

it('does not queue a join for an operator who is not on the well', async () => {
  seed({ partnerIsCrew: false });
  const screen = render(<TurnosTab />);
  await screen.findAllByText('Confirmar traspaso');
  expect(joinRows()).toEqual([]);
});

it('lets the crew member who did not start the shift end it, attributed to them', async () => {
  seed({ partnerIsCrew: true });
  mockSqlite.prepare(`UPDATE shifts SET handover_confirmed = 1 WHERE id = 'local-s1'`).run();
  const screen = render(<TurnosTab />);

  fireEvent.press(await screen.findByText('Finalizar turno e informe'));
  const buttons = (showSheet as jest.Mock).mock.calls[0][2];
  await buttons[1].onPress();

  await waitFor(() => {
    const rows = mockSqlite.prepare(
      `SELECT author_id FROM sync_outbox WHERE entity = 'shift_end' AND entity_id = 'local-s1'`,
    ).all();
    expect(rows).toEqual([{ author_id: 'partner' }]);
  });
});
