/**
 * Saving a bar must not wait on the network. Offline, or on Wi-Fi with no
 * internet, each request can wait 15 seconds before failing, and the operator was
 * held on "Guardando..." for the whole upload on every bar. Here the upload never
 * answers; the bar must still be saved and the form freed. Real SQLite.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockNever = () => new Promise<never>(() => undefined);
let mockReleaseDrain: () => void = () => undefined;

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
jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
jest.mock('../src/components/shared/PhotoCapture', () => () => null);
jest.mock('../src/api/projectCache', () => {
  const actual = jest.requireActual('../src/api/projectCache');
  return { ...actual, refreshAssignedProjects: () => mockNever() };
});
jest.mock('../src/sync/serverBarsCache', () => ({ cacheServerBars: () => mockNever() }));
jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutboxIncludingNew: jest.fn(() => new Promise((resolve) => {
    mockReleaseDrain = () => resolve({ synced: 1, failed: 0 });
  })),
}));

import ProgresoTab from '../src/components/operator/ProgresoTab';

const NOW = '2026-11-08T10:00:00Z';

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['operatorId', 'ana'], ['authToken', 'token']]);
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana')`).run();
  mockSqlite.prepare(
    `INSERT INTO projects (id, name, assigned_operator_id, status, default_bar_length) VALUES (7, 'Pozo Siete', 'ana', 'active', 3)`,
  ).run();
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at, handover_confirmed)
     VALUES ('s1', 's1', 'e1', 7, 'ana', 'open', ?, 1)`,
  ).run(NOW);
});

afterEach(() => mockSqlite.close());

const saveABar = async (screen: any) => {
  await screen.findByText('Guardar Progreso');
  const [start, end] = screen.getAllByPlaceholderText('HH:MM');
  fireEvent.changeText(start, '06:00');
  fireEvent.changeText(end, '06:30');
  fireEvent.press(screen.getByText('Arena'));
  fireEvent.press(screen.getByText('Guardar Progreso'));
};

it('saves the bar and frees the form while the upload hangs', async () => {
  const screen = render(<ProgresoTab />);
  await saveABar(screen);

  await screen.findByText('Barra guardada en este dispositivo. Enviando…');
  expect(screen.queryByText('Guardando...')).toBeNull();
  const queued = mockSqlite.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE entity = 'drilling_bar'`).get();
  expect(queued.n).toBe(1);
});

it('says the bar arrived once the upload has sent it', async () => {
  const screen = render(<ProgresoTab />);
  await saveABar(screen);
  await screen.findByText('Barra guardada en este dispositivo. Enviando…');

  mockSqlite.prepare(`DELETE FROM sync_outbox WHERE entity = 'drilling_bar'`).run(); // the drain sent it
  mockReleaseDrain();

  await waitFor(() => expect(screen.getByText('Barra guardada y sincronizada con el servidor.')).toBeTruthy());
});
