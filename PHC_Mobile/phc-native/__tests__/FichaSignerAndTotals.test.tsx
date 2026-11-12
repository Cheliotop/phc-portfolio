/**
 * Ficha audit items OPB-13, OPB-14 and OPB-15 (wave 3).
 *  - The signature is prefilled with the signed-in operator, who is named on the
 *    screen, and it is never written into a draft.
 *  - A draft records who saved it, and the next operator on the well is told.
 *  - The casing total is the sum of the tramos, shown read-only, with no typed total.
 *  - An exploration depth far from the last bar is flagged, never blocked.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const { DatabaseSync } = require('node:sqlite');

let mockSqlite: any;
let mockPreview: any;

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
  completionApi: { getPreview: async () => mockPreview },
}));
jest.mock('../src/sync/productV2Sync', () => ({
  syncPendingCompletionsV2: jest.fn(async () => ({ synced: 0, failed: 0 })),
  syncPendingCompletionDiscrepancies: jest.fn(async () => ({ synced: 0, failed: 0 })),
  syncPendingCompletionResubmissions: jest.fn(async () => ({ synced: 0, failed: 0 })),
}));

import FichaTecnicaTab, { explorationDepthWarning, signerLabelFor } from '../src/components/operator/FichaTecnicaTab';

const previewWithBars = (bars: any[] = []) => ({
  project: { id: 7, name: 'Pozo 7', default_bar_length: 3 }, completion: null, bars, shifts: [], shift_handovers: [],
  photos: [], materials: [], consumption: [], samples: [], company_pedidos: [], corrections: [],
  discrepancies: [], attachments: [], reconciliations: [], audit: [],
});

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([
    ['operatorId', 'ana'], ['userName', 'Ana Pérez'], ['userLoginName', 'ana'],
  ]);
  mockPreview = previewWithBars([
    { id: 'b1', bar_number: 1, depth_start: 0, depth_end: 3, soil_type: 'arena' },
    { id: 'b2', bar_number: 2, depth_start: 3, depth_end: 58, soil_type: 'arcilla' },
  ]);
  mockSqlite = new DatabaseSync(':memory:');
  const { createTablesSQL, createIndexesSQL } = require('../src/db/schema');
  for (const sql of [...createTablesSQL, ...createIndexesSQL]) mockSqlite.exec(sql);
  mockSqlite.prepare(`INSERT INTO operators (id, name) VALUES ('ana', 'Ana Pérez')`).run();
  mockSqlite.prepare(`INSERT INTO projects (id, name, assigned_operator_id) VALUES (7, 'Pozo 7', 'ana')`).run();
});

afterEach(() => mockSqlite.close());

describe('signerLabelFor', () => {
  it('names the operator and their login', () => {
    expect(signerLabelFor({ name: 'Ana Pérez', username: 'ana' })).toBe('Ana Pérez (usuario ana)');
  });

  it('falls back to whichever part is known', () => {
    expect(signerLabelFor({ name: '', username: 'ana' })).toBe('usuario ana');
    expect(signerLabelFor({ name: 'Ana Pérez', username: '' })).toBe('Ana Pérez');
    expect(signerLabelFor({ name: '', username: '' })).toBe('operador');
  });
});

describe('explorationDepthWarning', () => {
  const lastBar = { start: 55, end: 58 };

  it('stays silent when the depth is within one bar length of the last bar end', () => {
    expect(explorationDepthWarning('58', lastBar, 3)).toBeNull();
    expect(explorationDepthWarning('61', lastBar, 3)).toBeNull();
    expect(explorationDepthWarning('55', lastBar, 3)).toBeNull();
  });

  it('flags a typo that is more than one bar length away, with a decimal comma too', () => {
    expect(explorationDepthWarning('85', lastBar, 3)).toMatch(/difiere más de un tramo.*58 m/);
    expect(explorationDepthWarning('60,5', lastBar, 3)).toBeNull();
    expect(explorationDepthWarning('61,5', lastBar, 3)).toMatch(/difiere/);
    expect(explorationDepthWarning('60,5', lastBar, 2)).toMatch(/difiere/);
  });

  it('uses the last bar length when the well has no nominal bar length', () => {
    expect(explorationDepthWarning('70', lastBar, null)).toMatch(/difiere/);
    expect(explorationDepthWarning('60', lastBar, null)).toBeNull();
  });

  it('says nothing when there is nothing to compare with', () => {
    expect(explorationDepthWarning('85', null, 3)).toBeNull();
    expect(explorationDepthWarning('', lastBar, 3)).toBeNull();
    expect(explorationDepthWarning('85', { start: null, end: null }, null)).toBeNull();
  });
});

describe('Ficha signer, draft and totals', () => {
  it('prefills the signature with the signed-in operator and names them on the screen', async () => {
    const screen = render(<FichaTecnicaTab />);

    await screen.findByText('Firmás como Ana Pérez (usuario ana)', { includeHiddenElements: true }, { timeout: 3000 });
    const signature = screen.getByPlaceholderText('Nombre y aclaración *', { includeHiddenElements: true });
    expect(signature.props.value).toBe('Ana Pérez');
  });

  it('never saves the signature in the draft, and records who saved it', async () => {
    const screen = render(<FichaTecnicaTab />);
    const field = await screen.findByPlaceholderText('Nivel estático (m) *', { includeHiddenElements: true });

    fireEvent.changeText(field, '14');

    await waitFor(async () => {
      const keys = await AsyncStorage.getAllKeys();
      const key = keys.find((name) => name.includes('ficha:7'));
      expect(key).toBeTruthy();
      const stored = JSON.parse((await AsyncStorage.getItem(key!))!);
      expect(stored.values.staticLevel).toBe('14');
      expect(stored.values).not.toHaveProperty('signature');
      expect(stored.values).not.toHaveProperty('casingTotal');
      expect(stored.values.savedByName).toBe('Ana Pérez');
      expect(stored.values.savedById).toBe('ana');
    }, { timeout: 3000 });
  });

  it('says whose draft it is when restoring one, and does not restore a signature', async () => {
    await AsyncStorage.setItem('phc.draft.ficha:7', JSON.stringify({
      savedAt: Date.now(),
      scope: '7:new:draft:',
      values: {
        staticLevel: '14', dynamicLevel: '', flowRate: '', maximumFlow: '', pumpDepth: '',
        specificOverrideEnabled: false, specificOverride: '', explorationDepth: '', wideningDepth: '',
        casingAboveGround: '', centralizers: '', bottomPlug: '', bentonite: '', gravel: '',
        compressorHours: '', pumpHours: '', waterQuality: '', notes: '', casingRows: [],
        savedById: 'beto', savedByName: 'Beto Gómez', signature: 'Firma ajena',
      },
    }));

    const screen = render(<FichaTecnicaTab />);

    await screen.findByText('Borrador guardado por Beto Gómez', { includeHiddenElements: true }, { timeout: 3000 });
    await waitFor(() => expect(screen.getByPlaceholderText('Nivel estático (m) *', { includeHiddenElements: true }).props.value).toBe('14'));
    const signature = screen.getByPlaceholderText('Nombre y aclaración *', { includeHiddenElements: true });
    expect(signature.props.value).toBe('Ana Pérez');
  });

  it('shows the casing total as the sum of the tramos, with no typed total to disagree with it', async () => {
    const screen = render(<FichaTecnicaTab />);
    await screen.findByText('Total entubado (suma de tramos)', { includeHiddenElements: true }, { timeout: 3000 });

    expect(screen.queryByPlaceholderText('Total entubado (vacío = suma)', { includeHiddenElements: true })).toBeNull();
  });

  it('warns, without blocking, when the exploration depth is far from the last bar', async () => {
    const screen = render(<FichaTecnicaTab />);
    const exploration = await screen.findByPlaceholderText('Profundidad de exploración (m) *', { includeHiddenElements: true });

    fireEvent.changeText(exploration, '85');
    await screen.findByText(/difiere más de un tramo de perforación/, { includeHiddenElements: true }, { timeout: 3000 });

    fireEvent.changeText(exploration, '58');
    await waitFor(() => expect(screen.queryByText(/difiere más de un tramo/, { includeHiddenElements: true })).toBeNull());
  });
});
