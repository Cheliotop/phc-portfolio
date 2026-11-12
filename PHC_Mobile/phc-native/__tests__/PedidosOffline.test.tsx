/**
 * Pedidos must stay visible offline (audit H6): the list showed synced pedidos only
 * straight from the server, so with no signal it read "Sin pedidos", and an approved
 * delivery could not be confirmed. Real SQLite with the app's schema.
 */
import { render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
const mockGetAll = jest.fn();

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params);
  const queryFirst = async (sql: string, params: any[] = []) =>
    mockSqlite.prepare(sql).get(...params) ?? null;
  return { execute, query, queryFirst, runInTransaction: async (task: any) => task({ execute, query, queryFirst }) };
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
jest.mock('../src/api/projectCache', () => {
  const project = { id: 7, name: 'Pozo 7' };
  return { loadAssignedProjects: async () => [project], refreshAssignedProjects: async () => [project] };
});
jest.mock('../src/api/supabase-pedidos', () => ({
  pedidosApi: { getAll: (...args: any[]) => mockGetAll(...args) },
}));
jest.mock('../src/api/supabase-product-v2', () => ({
  productV2Api: { getCatalog: async () => { throw new Error('Sin conexión'); } },
}));
jest.mock('../src/sync/productV2Sync', () => ({
  syncPendingPedidoReceipts: jest.fn(),
  syncPendingPedidosV2: jest.fn(),
}));

import PedidosV2Tab from '../src/components/operator/PedidosV2Tab';

const ANA = 'operator-ana';
const approved = {
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
    id: 501, material_name_snapshot: 'Bentonita', requested_quantity: 10, approved_quantity: 10,
    received_quantity: 0, unit_snapshot: 'bolsa', state: 'aprobado', layer: 'extras',
  }],
};
const offline = () => Object.assign(new Error('Sin conexión'), { name: 'OfflineError' });

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  await AsyncStorage.setItem('operatorId', ANA);
});

afterEach(() => mockSqlite.close());

it('shows the pedidos the server last returned, and says they are saved ones', async () => {
  mockGetAll.mockResolvedValueOnce({ data: [approved] });
  const online = render(<PedidosV2Tab />);
  await online.findByText(/Bentonita/);
  expect(online.queryByText(/Sin conexión/)).toBeNull();
  online.unmount();

  mockGetAll.mockRejectedValue(offline());
  const screen = render(<PedidosV2Tab />);

  await screen.findByText(/Bentonita/);
  expect(screen.getByText(/Sin conexión\. Se muestran los pedidos guardados el/)).toBeTruthy();
  expect(screen.queryByText('Sin pedidos')).toBeNull();
});

it('shows a delivery confirmed on the phone after the list was saved', async () => {
  mockGetAll.mockResolvedValueOnce({ data: [approved] });
  render(<PedidosV2Tab />).unmount();
  await waitFor(async () => expect(await AsyncStorage.getItem(`pedidosCache:${ANA}`)).toBeTruthy());
  mockSqlite.prepare(
    `INSERT INTO pedido_items (id, server_id, material_name_snapshot, requested_quantity, unit_snapshot,
                               state, approved_quantity, received_quantity, layer, sync_status, created_at, updated_at)
     VALUES ('server_item_501', 501, 'Bentonita', 10, 'bolsa', 'recibido', 10, 10, 'extras', 'synced', ?, ?)`,
  ).run('2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');

  mockGetAll.mockRejectedValue(offline());
  const screen = render(<PedidosV2Tab />);

  await screen.findByText(/Recibido 10/);
  expect(screen.getByText('recibido')).toBeTruthy();
});

it('keeps a queued receipt over the online server list and hides duplicate confirmation', async () => {
  const serverList = [{
    ...approved,
    pedido_items: [
      ...approved.pedido_items,
      {
        id: 502, material_name_snapshot: 'Cemento', requested_quantity: 4, approved_quantity: 4,
        received_quantity: 0, unit_snapshot: 'bolsa', state: 'aprobado', layer: 'extras',
      },
    ],
  }];
  mockSqlite.prepare(
    `INSERT INTO pedido_items (id, server_id, pedido_server_id, material_name_snapshot, requested_quantity,
                               unit_snapshot, state, approved_quantity, received_quantity, layer, sync_status,
                               created_at, updated_at)
     VALUES ('local-item-501', 501, 55, 'Bentonita', 10, 'bolsa', 'parcial', 10, 5, 'extras', 'pending', ?, ?)`,
  ).run('2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z');
  mockSqlite.prepare(
    `INSERT INTO pedido_receipts (id, pedido_item_id, pedido_item_server_id, outcome, quantity_received,
                                  confirmed_by, confirmed_at, sync_status, created_at, updated_at)
     VALUES ('receipt-501', 'local-item-501', 501, 'parcial', 5, ?, ?, 'pending', ?, ?)`,
  ).run(ANA, '2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z');
  mockSqlite.prepare(
    `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
     VALUES ('outbox-receipt-501', 'pedido_receipt', 'receipt-501', 'INSERT', '{}', 0, ?, ?)`,
  ).run('2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z');
  mockGetAll.mockResolvedValueOnce({ data: serverList });

  const screen = render(<PedidosV2Tab />);

  await screen.findByText('Recepción guardada, pendiente de envío');
  expect(screen.getByText(/Recibido 5/)).toBeTruthy();
  expect(screen.getByText('parcial')).toBeTruthy();
  expect(screen.getAllByText('Confirmar entrega')).toHaveLength(1);
});

it('keeps one operator\'s saved pedidos from another on the same phone', async () => {
  mockGetAll.mockResolvedValueOnce({ data: [approved] });
  render(<PedidosV2Tab />).unmount();
  await waitFor(async () => expect(await AsyncStorage.getItem(`pedidosCache:${ANA}`)).toBeTruthy());

  await AsyncStorage.setItem('operatorId', 'operator-beto');
  mockGetAll.mockRejectedValue(offline());
  const screen = render(<PedidosV2Tab />);

  await screen.findByText('Sin pedidos');
  expect(screen.queryByText(/Bentonita/)).toBeNull();
});
