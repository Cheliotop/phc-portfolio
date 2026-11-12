const mockWrite = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///tmp/',
  writeAsStringAsync: (...args: any[]) => mockWrite(...args),
}));

import { buildCsv } from '../src/utils/exportCsv';

describe('CSV export safety', () => {
  test('quotes structural characters and neutralizes spreadsheet formulas', () => {
    const csv = buildCsv(
      [{ name: 'Pozo, Norte', notes: '=HYPERLINK("bad")\nsegunda línea' }],
      [{ key: 'name', label: 'Nombre' }, { key: 'notes', label: 'Notas' }],
    );

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"Pozo, Norte"');
    expect(csv).toContain('"\'=HYPERLINK(""bad"")\nsegunda línea"');
  });

  test('has no English-header progress export left (it was unused)', () => {
    // The admin exports Spanish headers only. The English-header progress export
    // had no caller and would have shipped "Date" and "Soil Type" if one appeared.
    const module = require('../src/utils/exportCsv');
    expect(module.exportProgressToCsv).toBeUndefined();
  });

  test('rejects an empty export', () => {
    expect(() => buildCsv([], [{ key: 'id', label: 'ID' }])).toThrow('No data to export');
  });
});

describe('what the admin exports (code read A7)', () => {
  beforeEach(() => mockWrite.mockReset());
  const written = () => String(mockWrite.mock.calls[0]?.[1] || '');

  it('projects: Spanish headers, the progress, and the status in words', async () => {
    const { exportProjectsToCsv } = require('../src/utils/exportCsv');
    await exportProjectsToCsv([{ id: 1, name: 'Norte', status: 'active', progress_percentage: 45, client: 'Estancia' }]);
    const csv = written();
    expect(csv).toContain('Nombre');
    expect(csv).toContain('45%');
    expect(csv).toContain('Estancia');
    expect(csv).not.toContain('undefined');
    expect(csv).not.toMatch(/,active,/);
  });

  it('pedidos: one row per item, with its unit', async () => {
    const { exportSupplyRequestsToCsv } = require('../src/utils/exportCsv');
    await exportSupplyRequestsToCsv([{
      pedido_number: 'P-1', kind: 'empresa', projects: { name: 'Pozo 7' },
      pedido_items: [
        { material_name_snapshot: 'Caño', requested_quantity: 100, unit_snapshot: 'm', state: 'aprobado' },
        { material_name_snapshot: 'Bentonita', requested_quantity: 20, unit_snapshot: 'bolsa', state: 'no_recibido' },
      ],
    }]);
    const lines = written().trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('No recibido');
  });
});
