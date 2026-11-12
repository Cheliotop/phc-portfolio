/**
 * Ficha, after code read S5:
 * - a returned Ficha's correction the server refused for good opens the form
 *   again with the corrected values and the reason, instead of "Reenvío
 *   guardado" forever;
 * - a draft written against a refused Ficha survives the app restarting. The
 *   refusal is read from the phone after the screen opens, and the draft hook
 *   used to read the draft before that, see a different version and delete it.
 * Real SQLite with the app's schema; the network is fake.
 */
import { render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
let mockCompletion: any = null;

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
      project: { id: 7, name: 'Pozo 7' }, completion: mockCompletion, bars: [], shifts: [], shift_handovers: [],
      photos: [], materials: [], consumption: [], samples: [], company_pedidos: [], corrections: [],
      discrepancies: [], attachments: [], reconciliations: [], audit: [],
    }),
  },
}));
jest.mock('../src/sync/drainCoordinator', () => ({ drainOutboxIncludingNew: jest.fn(async () => ({ synced: 0, failed: 0 })) }));

import FichaTecnicaTab from '../src/components/operator/FichaTecnicaTab';

const NOW = '2026-11-08T10:00:00Z';
const field = (screen: any) => screen.getByPlaceholderText('Nivel estático (m) *', { includeHiddenElements: true });

beforeEach(async () => {
  mockCompletion = null;
  await AsyncStorage.clear();
  await AsyncStorage.setItem('operatorId', 'ana');
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', 'ana')`).run();
});

afterEach(() => mockSqlite.close());

it('opens a refused correction again with its values and the reason', async () => {
  mockCompletion = { id: 55, status: 'returned', returned_at: NOW, static_level: 10, dynamic_level: 30 };
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
     VALUES ('q9', 'completion_v2_resubmit', '55', 'UPDATE', ?, 3, 'quarantined',
             'La Ficha ya no está devuelta (55000)', ?, ?)`,
  ).run(JSON.stringify({ projectId: 7, finalFields: { static_level: 12.5, dynamic_level: 31 } }), NOW, NOW);

  const screen = render(<FichaTecnicaTab />);

  await screen.findByText('El servidor no aceptó la corrección');
  expect(screen.getByText('Motivo: La Ficha ya no está devuelta')).toBeTruthy();
  expect(screen.queryByText('Reenvío guardado')).toBeNull();
  await waitFor(() => expect(field(screen).props.value).toBe('12.5'));
});

it('keeps a draft written against a refused Ficha when the app restarts', async () => {
  mockSqlite.prepare(
    `INSERT INTO completion_reports_local (id, client_entry_id, project_id, operator_id, format_version, submitted_at, created_at, updated_at)
     VALUES ('f1', 'f1', 7, 'ana', 2, ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
     VALUES ('q1', 'completion_v2', 'f1', 'INSERT', ?, 3, 'quarantined', 'Hay turnos abiertos (55000)', ?, ?)`,
  ).run(JSON.stringify({ projectId: 7, finalFields: { static_level: 12.5 } }), NOW, NOW);
  const values = {
    staticLevel: '99', dynamicLevel: '', flowRate: '', maximumFlow: '', pumpDepth: '',
    specificOverrideEnabled: false, specificOverride: '', explorationDepth: '', wideningDepth: '',
    casingTotal: '', casingAboveGround: '', centralizers: '', bottomPlug: '', bentonite: '', gravel: '',
    compressorHours: '', pumpHours: '', waterQuality: '', notes: '', casingRows: [],
  };
  await AsyncStorage.setItem('phc.draft.ficha:7', JSON.stringify({ savedAt: Date.now(), values, scope: '7:new:draft:f1' }));

  const screen = render(<FichaTecnicaTab />);

  await screen.findByText('El servidor no aceptó la Ficha');
  await waitFor(() => expect(field(screen).props.value).toBe('99'));
  expect(await AsyncStorage.getItem('phc.draft.ficha:7')).not.toBeNull();
});
