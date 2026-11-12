/**
 * Mi Pozo for a well that is not in the field (OPA-16), the sync banner that must
 * agree with the header badge (OPA-18), and the well's totals with several bars and
 * log rows (OPA-20). Real SQLite with the app's schema; the server never answers.
 */
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { toneColor } from '../src/theme/phcTheme';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
let mockSqlLog: string[] = [];
const mockNever = () => new Promise<never>(() => undefined);

jest.mock('../src/db/db', () => {
  const execute = async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params);
  const query = async (sql: string, params: any[] = []) => {
    mockSqlLog.push(sql);
    return mockSqlite.prepare(sql).all(...params);
  };
  const queryFirst = async (sql: string, params: any[] = []) => {
    mockSqlLog.push(sql);
    return mockSqlite.prepare(sql).get(...params) ?? null;
  };
  return {
    execute, query, queryFirst,
    runInTransaction: async (task: any) => task({ execute, query, queryFirst }),
  };
});
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock('../src/api/supabase-projects', () => ({ projectsApi: { getAll: () => mockNever() } }));
jest.mock('../src/sync/serverBarsCache', () => ({ cacheServerBars: async () => undefined }));

import PozosTab from '../src/components/operator/PozosTab';

const setStatus = (status: string) =>
  mockSqlite.prepare(`UPDATE projects SET status = ? WHERE id = 7`).run(status);

beforeEach(async () => {
  mockSqlLog = [];
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

describe('OPA-16: a well that is not in the field', () => {
  it('says a paused well is paused, not completed and signed, and offers no close report', async () => {
    setStatus('paused');
    const screen = render(<PozosTab />);
    await screen.findByText('Pozo pausado');
    expect(screen.getByText(/La administración pausó este pozo/)).toBeTruthy();
    expect(screen.queryByText('Pozo completado')).toBeNull();
    expect(screen.queryByText('Ver informe de cierre')).toBeNull();
  });

  it('says a cancelled well is cancelled, with no close report', async () => {
    setStatus('cancelled');
    const screen = render(<PozosTab />);
    await screen.findByText('Pozo cancelado');
    expect(screen.queryByText('Ver informe de cierre')).toBeNull();
    expect(screen.queryByText('Registrar barra')).toBeNull();
  });

  it('says a well whose close is awaiting review is in closure, and offers no actions', async () => {
    setStatus('closure_submitted');
    const screen = render(<PozosTab />);
    await screen.findByText('El cierre de este pozo ya fue enviado y está en revisión por la administración. No se puede registrar nada más.');
    expect(screen.queryByText('Registrar barra')).toBeNull();
    expect(screen.queryByText('Ver informe de cierre')).toBeNull();
  });

  it('offers the close report only for a completed well', async () => {
    setStatus('completed');
    const screen = render(<PozosTab />);
    await screen.findByText('Pozo completado');
    expect(screen.getByText('Ver informe de cierre')).toBeTruthy();
  });

  it('colours the status badge from the tone helper', async () => {
    setStatus('paused');
    const screen = render(<PozosTab />);
    const badge = await screen.findByText('Pausado');
    expect(StyleSheet.flatten(badge.props.style).color).toBe(toneColor('warning').fg);
  });
});

describe('OPA-18: the Mi Pozo banner agrees with the header badge', () => {
  it('shows a retrying row as pending, not as "no se pudieron subir"', async () => {
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at)
       VALUES ('o-retry', 'drilling_bar', 'bar-1', 'UPSERT', '{}', 'ana', 3, '2026-11-09', '2026-11-09')`,
    ).run();
    const screen = render(<PozosTab />);
    await screen.findByText('1 registro(s) guardados en este dispositivo, pendientes de subir.');
    expect(screen.queryByText(/no se pudieron subir/)).toBeNull();
  });

  it('shows a refused row as rejected', async () => {
    mockSqlite.prepare(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, author_id, retries, state, created_at, updated_at)
       VALUES ('o-refused', 'drilling_bar', 'bar-2', 'UPSERT', '{}', 'ana', 0, 'quarantined', '2026-11-09', '2026-11-09')`,
    ).run();
    const screen = render(<PozosTab />);
    await screen.findByText(/registro\(s\) rechazados por el servidor/);
  });
});

describe('OPA-20: the well totals are not a cross product', () => {
  it('reads depth and last activity with scalar subqueries, not a join', async () => {
    const screen = render(<PozosTab />);
    await screen.findByText('Pozo Siete');
    const wellQuery = mockSqlLog.find((sql) => sql.includes('current_depth'));
    expect(wellQuery).toBeTruthy();
    expect(wellQuery).not.toMatch(/JOIN\s+progress_logs_dashboard/i);
    expect(wellQuery).not.toMatch(/JOIN\s+drilling_bar_entries/i);
  });

  it('shows the deepest bar with several bars and log rows, not an inflated product', async () => {
    const insertBar = (id: string, barNumber: number, depthEnd: number) =>
      mockSqlite.prepare(
        `INSERT INTO drilling_bar_entries (id, project_id, operator_id, bar_number, depth_start, depth_end, length,
                                           soil_type, created_at, timestamp_local)
         VALUES (?, 7, 'ana', ?, ?, ?, 3, 'arcilla', '2026-11-09T10:00:00Z', '2026-11-09T10:00:00Z')`,
      ).run(id, barNumber, depthEnd - 3, depthEnd);
    insertBar('b1', 1, 3);
    insertBar('b2', 2, 6);
    insertBar('b3', 3, 9);
    for (const [depth, date] of [[4, '2026-11-08'], [5, '2026-11-08'], [7, '2026-11-08']] as const) {
      mockSqlite.prepare(
        `INSERT INTO progress_logs_dashboard (project_id, operator_id, date, depth_start, depth_end, created_at)
         VALUES (7, 'ana', ?, ?, ?, ?)`,
      ).run(date, depth - 1, depth, `${date}T08:00:00Z`);
    }
    const screen = render(<PozosTab />);
    await screen.findByText('9m');
    expect(screen.queryByText('18m')).toBeNull();
  });
});
