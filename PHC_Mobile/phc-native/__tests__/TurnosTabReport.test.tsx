/**
 * The shift screen's report (audit B4 and H1). Finishing offline must say the report
 * was saved, lock it so it can't go twice, and only alarm on a real refusal. A
 * background refresh must not wipe what the operator is typing. Real SQLite with the
 * app's schema; the network is fake and stays offline.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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

const addShift = (fields: { handover?: number; reported?: number } = {}) =>
  mockSqlite.prepare(
    `INSERT INTO shifts (id, server_id, client_entry_id, project_id, operator_id, status, started_at,
                         handover_confirmed, usage_report_submitted)
     VALUES (?, ?, 'entry-1', 7, ?, 'open', ?, ?, ?)`,
  ).run(SHIFT, SHIFT, ANA, new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    fields.handover ?? 1, fields.reported ?? 0);

const outboxRows = () => mockSqlite.prepare(`SELECT entity, state FROM sync_outbox ORDER BY created_at`).all();

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

const finishWith = async (screen: ReturnType<typeof render>, quantity: string) => {
  fireEvent.changeText(screen.getByPlaceholderText('0 u'), quantity);
  fireEvent.press(screen.getByText('Finalizar turno e informe'));
  const [, , buttons] = mockShowSheet.mock.calls.find(([title]) => title === 'Finalizar turno');
  await act(async () => {
    await buttons.find((button: any) => button.text === 'Finalizar').onPress();
  });
};

describe('finishing a shift offline (B4)', () => {
  it('says the report was saved, and locks it', async () => {
    addShift();
    const screen = render(<TurnosTab />);
    await screen.findByText('Informe para finalizar');

    await finishWith(screen, '2');

    await screen.findByText('Informe final guardado');
    expect(screen.getByText('Informe guardado en este dispositivo. Se enviará solo cuando haya conexión.')).toBeTruthy();
    expect(screen.queryByText('Finalizar turno e informe')).toBeNull();
    expect(screen.queryByPlaceholderText('0 u')).toBeNull();
    expect(mockShowSheet.mock.calls.map(([title]) => title)).toEqual(['Finalizar turno']);
    expect(outboxRows()).toEqual([
      { entity: 'shift_join', state: 'pending' },
      { entity: 'shift_end', state: 'pending' },
    ]);
    expect(mockSqlite.prepare(`SELECT current_quantity FROM project_materials WHERE id = 31`).get().current_quantity).toBe(8);
  });

  it('stays locked when the screen loads again', async () => {
    addShift({ reported: 1 });
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, last_error, created_at, updated_at)
       VALUES ('q1', 'shift_end', ?, 'UPDATE', '{}', 1,
               'OfflineError: Sin conexión.
    at anonymous (index.android.bundle:1:2)', '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
    ).run(SHIFT);

    const screen = render(<TurnosTab />);

    await screen.findByText('Informe final guardado');
    expect(screen.getByText('CIERRE EN ESPERA')).toBeTruthy();
    expect(screen.queryByText('Finalizar turno e informe')).toBeNull();
    expect(screen.queryByText(/anonymous|OfflineError/)).toBeNull();
  });

  it('says how many of the shift\'s bars the close is waiting for', async () => {
    addShift({ reported: 1 });
    const queue = mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, created_at, updated_at)
       VALUES (?, ?, ?, 'UPSERT', ?, 0, '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
    );
    queue.run('b1', 'drilling_bar', 'bar-1', JSON.stringify({ project_id: 7, shift_id: SHIFT }));
    queue.run('b2', 'drilling_bar', 'bar-2', JSON.stringify({ project_id: 7, shift_id: SHIFT }));
    queue.run('q1', 'shift_end', SHIFT, '{}');

    const screen = render(<TurnosTab />);

    await screen.findByText('Primero tienen que subir 2 barras de este turno.');
  });

  it('explains a refusal in plain words', async () => {
    addShift({ reported: 1 });
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, retries, state, last_error, created_at, updated_at)
       VALUES ('q1', 'shift_end', ?, 'UPDATE', '{}', 3, 'quarantined',
               'Shift cannot be closed from status closed (22023)', '2026-11-08T10:00:00Z', '2026-11-08T10:00:00Z')`,
    ).run(SHIFT);

    const screen = render(<TurnosTab />);

    await screen.findByText('Cierre no aceptado');
    expect(screen.getByText('El servidor no aceptó el cierre de este turno: Shift cannot be closed from status closed.')).toBeTruthy();
    expect(screen.queryByText('Finalizar turno e informe')).toBeNull();
  });
});

describe('a background refresh (H1)', () => {
  it('keeps a half-typed report', async () => {
    addShift();
    const screen = render(<TurnosTab />);
    await screen.findByText('Informe para finalizar');
    fireEvent.changeText(screen.getByPlaceholderText('0 u'), '7');
    const loadsBefore = mockGetMaterials.mock.calls.length;

    await act(async () => {
      notifyOperatorDataChanged();
    });
    await waitFor(() => expect(mockGetMaterials.mock.calls.length).toBeGreaterThan(loadsBefore));

    await waitFor(() => expect(screen.getByPlaceholderText('0 u').props.value).toBe('7'));
  });

  it('keeps a handover difference being typed', async () => {
    addShift({ handover: 0 });
    const screen = render(<TurnosTab />);
    await screen.findByText('Coincide');
    fireEvent.press(screen.getByText('Coincide'));
    fireEvent.changeText(screen.getByPlaceholderText('Cantidad observada'), '9');
    fireEvent.changeText(screen.getByPlaceholderText('Describí la diferencia'), 'Falta uno');
    const loadsBefore = mockGetMaterials.mock.calls.length;

    await act(async () => {
      notifyOperatorDataChanged();
    });
    await waitFor(() => expect(mockGetMaterials.mock.calls.length).toBeGreaterThan(loadsBefore));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Cantidad observada').props.value).toBe('9');
      expect(screen.getByPlaceholderText('Describí la diferencia').props.value).toBe('Falta uno');
    });
  });
});

describe('opening the screen with a server that does not answer (B3 gap)', () => {
  it('shows the shift the phone holds without waiting for the server', async () => {
    addShift();
    // An expired token and no server: the auth library keeps retrying for most
    // of a minute. Here the server never answers at all.
    mockRefreshProjects.mockReturnValue(new Promise(() => {}));

    const screen = render(<TurnosTab />);

    await screen.findByText('Informe para finalizar');
    expect(screen.queryByText('Cargando turno…')).toBeNull();
  });
});

describe('OPA-11: handover ids are per shift and material', () => {
  it('queues the handover with the same client ids on every submit', async () => {
    addShift({ handover: 0 });
    const screen = render(<TurnosTab />);
    await screen.findByText('Coincide');
    await act(async () => {
      fireEvent.press(screen.getAllByText('Confirmar traspaso').pop()!);
    });
    await waitFor(() => expect(outboxRows().some((row: any) => row.entity === 'shift_handover')).toBe(true));
    const row = mockSqlite.prepare(
      `SELECT payload_json FROM sync_outbox WHERE entity = 'shift_handover'`,
    ).get();
    const payload = JSON.parse(row.payload_json);
    expect(payload.items.map((item: any) => item.client_entry_id)).toEqual([`handover:${SHIFT}:31`]);
  });
});

describe('messages about a shift that is gone (H4 gap, m-76)', () => {
  it('drops "Traspaso confirmado." once the screen no longer shows that shift', async () => {
    addShift({ handover: 0 });
    // Online this time: the drain sends the handover and empties the queue.
    mockDrain.mockImplementation(async () => {
      mockSqlite.exec(`DELETE FROM sync_outbox`);
      mockSqlite.exec(`UPDATE shifts SET handover_confirmed = 1`);
      return { synced: 1, failed: 0 };
    });
    const screen = render(<TurnosTab />);
    await screen.findByText('Coincide');
    await act(async () => {
      fireEvent.press(screen.getAllByText('Confirmar traspaso').pop()!);
    });
    await screen.findByText('Traspaso confirmado.');

    // The admin force-closes it, and the phone catches up.
    mockSqlite.exec(`UPDATE shifts SET status = 'closed', end_type = 'admin', notes = 'Se fue'`);
    await act(async () => {
      notifyOperatorDataChanged();
    });

    await screen.findByText(/El administrador cerró tu último turno/);
    expect(screen.queryByText('Traspaso confirmado.')).toBeNull();
  });
});
