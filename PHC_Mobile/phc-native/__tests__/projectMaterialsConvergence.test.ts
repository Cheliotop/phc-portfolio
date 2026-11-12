import { readFileSync } from 'fs';

const mockEq = jest.fn();
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn(() => ({ select: mockSelect }));
const mockExecute = jest.fn();

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

jest.mock('../src/db/index', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));

import { materialsApi } from '../src/api/supabase-materials';
import { mirrorProjectMaterials } from '../src/db/repositories/projectMaterials';

describe('project_materials convergence safety', () => {
  beforeEach(() => {
    mockEq.mockReset();
    mockSelect.mockClear();
    mockFrom.mockClear();
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  it('fetches an inactive server row and mirrors active=false as 0 locally', async () => {
    const inactiveServerRow = {
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
      notes: null,
      created_at: '2026-07-25T10:00:00.000Z',
      updated_at: '2026-07-25T11:00:00.000Z',
    };
    mockEq.mockResolvedValue({ data: [inactiveServerRow], error: null });

    const response = await materialsApi.getProjectMaterials(33);

    expect(mockFrom).toHaveBeenCalledWith('project_materials');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith('project_id', 33);

    await mirrorProjectMaterials(response.data);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, params] = mockExecute.mock.calls[0];
    expect(params[0]).toBe(175);
    expect(params[8]).toBe(0);
  });

  it('keeps the admin screen from inserting a client-numbered phantom offline', () => {
    // ProjectsTab has no practical component harness. This source-level guard
    // pins the safety boundary directly: it may target an existing row with an
    // UPDATE, but it must never create a project_materials row of its own.
    const source = readFileSync(
      `${process.cwd()}/src/components/admin/ProjectsTab.tsx`,
      'utf8',
    );

    expect(source).not.toMatch(/INSERT\s+INTO\s+project_materials/i);
    // ADM-13: no offline branch remains. Without a server row nothing is saved.
    expect(source).not.toMatch(/local_project_/);
    expect(source).toContain(
      'No se pudo asignar el material. No se guardó nada.',
    );
  });
});
