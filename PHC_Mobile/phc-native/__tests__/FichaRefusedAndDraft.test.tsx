/**
 * The Ficha screen (code read O1, O2): a Ficha the server refused for good must
 * open again with its values and the reason, instead of "Pendiente de
 * sincronización" forever; and what the operator types must be saved as a draft.
 * Real SQLite with the app's schema; the network is fake.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { claimOutbox } from '../src/sync/outboxOwner';

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
// The submit path drains the outbox. Stubbed here so the test never probes the
// real server (drainOutboxIncludingNew checks reachability first).
jest.mock('../src/sync/drainCoordinator', () => ({ drainOutboxIncludingNew: jest.fn(async () => ({ synced: 0, failed: 0 })) }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('@react-native-picker/picker', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  const Picker = ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children);
  Picker.Item = ({ label }: { label: string }) => ReactModule.createElement(Text, null, label);
  return { Picker };
});
jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: { getClosingAssignments: async () => [{ project_id: 7, projects: { name: 'Pozo 7' } }] },
}));
jest.mock('../src/api/supabase-completion', () => ({
  completionApi: {
    getPreview: async () => ({
      project: { id: 7, name: 'Pozo 7' }, completion: null, bars: [], shifts: [], shift_handovers: [],
      photos: [], materials: [], consumption: [], samples: [], company_pedidos: [], corrections: [],
      discrepancies: [], attachments: [], reconciliations: [], audit: [],
    }),
  },
}));
jest.mock('../src/sync/productV2Sync', () => ({
  syncPendingCompletionsV2: jest.fn(async () => ({ synced: 0, failed: 0 })),
  syncPendingCompletionDiscrepancies: jest.fn(async () => ({ synced: 0, failed: 0 })),
  syncPendingCompletionResubmissions: jest.fn(async () => ({ synced: 0, failed: 0 })),
}));

import FichaTecnicaTab from '../src/components/operator/FichaTecnicaTab';

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('operatorId', 'ana');
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana')`).run();
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('partner', 'Beto')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', 'ana')`).run();
  mockSqlite.prepare(`INSERT INTO project_secondary_operators (project_id, operator_id) VALUES (7, 'partner')`).run();
});

afterEach(() => mockSqlite.close());

it('opens a refused Ficha again with its values and the reason', async () => {
  mockSqlite.prepare(
    `INSERT INTO completion_reports_local (id, client_entry_id, project_id, operator_id, format_version, submitted_at, created_at, updated_at)
     VALUES ('f1', 'f1', 7, 'ana', 2, '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
  ).run();
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
     VALUES ('q1', 'completion_v2', 'f1', 'INSERT', ?, 3, 'quarantined', 'Hay turnos abiertos en el pozo (55000)',
             '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
  ).run(JSON.stringify({ projectId: 7, finalFields: { static_level: 12.5, dynamic_level: 30 }, completionNotes: 'ok' }));

  await claimOutbox('partner');
  expect(mockSqlite.prepare("SELECT state FROM sync_outbox WHERE id = 'q1'").get().state).toBe('quarantined');
  await AsyncStorage.setItem('operatorId', 'partner');

  const screen = render(<FichaTecnicaTab />);

  await screen.findByText('El servidor no aceptó la Ficha');
  expect(screen.getByText('Motivo: Hay turnos abiertos en el pozo')).toBeTruthy();
  expect(screen.queryByText('Ficha enviada')).toBeNull();
  await waitFor(() => expect(screen.getByPlaceholderText('Nivel estático (m) *', { includeHiddenElements: true }).props.value).toBe('12.5'));
});

it('still shows a Ficha waiting to upload as sent', async () => {
  mockSqlite.prepare(
    `INSERT INTO completion_reports_local (id, client_entry_id, project_id, operator_id, format_version, submitted_at, created_at, updated_at)
     VALUES ('f1', 'f1', 7, 'ana', 2, '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
  ).run();
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
     VALUES ('q1', 'completion_v2', 'f1', 'INSERT', '{}', 0, '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
  ).run();

  const screen = render(<FichaTecnicaTab />);

  await screen.findByText('Ficha enviada');
  expect(screen.queryByText('El servidor no aceptó la Ficha')).toBeNull();
});

it('saves what the operator types as a draft', async () => {
  const screen = render(<FichaTecnicaTab />);
  const field = await screen.findByPlaceholderText('Nivel estático (m) *', { includeHiddenElements: true });

  fireEvent.changeText(field, '14');

  await waitFor(async () => {
    const keys = await AsyncStorage.getAllKeys();
    const key = keys.find((name) => name.includes('ficha:7'));
    expect(key).toBeTruthy();
    expect(JSON.parse((await AsyncStorage.getItem(key!))!).values.staticLevel).toBe('14');
  }, { timeout: 3000 });
});
