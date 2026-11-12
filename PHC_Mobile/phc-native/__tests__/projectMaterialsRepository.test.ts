const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (...args: any[]) => mockExecute(...args),
}));

import { mirrorProjectMaterial, mirrorProjectMaterials } from '../src/db/repositories/projectMaterials';

/**
 * Guards the 2026-07-25 audit findings. There used to be four hand-written
 * copies of this mirror and two of them had drifted to only 10 of the 13
 * columns. The destructive mirror let omitted columns fall back to their
 * defaults — verified on-device:
 *
 *     after 13-col write:   presupuesto | 46   | 0
 *     after 10-col mirror:  extras      | NULL | 1
 *
 * The forced `active = 1` was the dangerous one: the shift-handover payload
 * reads `active` from this table, so a material the server had DEACTIVATED went
 * out as active and the server rejected the whole handover with "A handover item
 * is not an active material in this project", deadlocking the well.
 */
describe('project_materials local mirror', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  const serverRow = {
    id: 175,
    project_id: 33,
    material_name: 'Agua potable · Reforzado',
    initial_quantity: 25,
    current_quantity: 25,
    unit: 'unidad',
    layer: 'presupuesto',
    catalog_variant_id: 46,
    active: false,
    assigned_date: '2026-07-25T10:00:00.000Z',
    notes: 'nota',
    created_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T11:00:00.000Z',
  };

  it('writes all thirteen columns through a non-destructive UPSERT', async () => {
    await mirrorProjectMaterial(serverRow);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0];

    for (const column of [
      'id', 'project_id', 'material_name', 'initial_quantity', 'current_quantity',
      'unit', 'layer', 'catalog_variant_id', 'active', 'assigned_date', 'notes',
      'created_at', 'updated_at',
    ]) {
      expect(sql).toContain(column);
    }
    // 13 columns => 13 placeholders => 13 params. If someone adds a column to
    // the statement without a param (or vice versa) this fails loudly.
    expect((sql.match(/\?/g) || []).length).toBe(13);
    expect(params).toHaveLength(13);
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(sql).not.toContain('OR REPLACE');
  });

  it('preserves layer, catalog_variant_id and active rather than defaulting them', async () => {
    await mirrorProjectMaterial(serverRow);
    const [, params] = mockExecute.mock.calls[0];

    expect(params).toContain('presupuesto'); // not silently 'extras'
    expect(params).toContain(46);            // not silently NULL
    expect(params[8]).toBe(0);               // active:false -> 0, not forced to 1
  });

  it('keys on the SERVER id and never invents one', async () => {
    await mirrorProjectMaterial(serverRow);
    const [, params] = mockExecute.mock.calls[0];
    // A client-generated id produces a row the server has never seen, which is
    // what made confirm_shift_handover reject the payload wholesale.
    expect(params[0]).toBe(175);
  });

  it('defaults layer to extras and active to 1 only when the server omits them', async () => {
    await mirrorProjectMaterial({
      id: 1, project_id: 2, material_name: 'Cemento',
    });
    const [, params] = mockExecute.mock.calls[0];
    expect(params[6]).toBe('extras');
    expect(params[8]).toBe(1);
    expect(params[7]).toBeNull();
  });

  it('routes through a caller-supplied executor so transactions keep their atomicity', async () => {
    const txExecute = jest.fn().mockResolvedValue(undefined);
    await mirrorProjectMaterials([serverRow, { ...serverRow, id: 176 }], 'now', txExecute);

    expect(txExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('tolerates a null or empty server response', async () => {
    await mirrorProjectMaterials(null);
    await mirrorProjectMaterials([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
