/**
 * Admin material calls that change a well's allocation.
 *
 * Two rules here. A typed name must resolve to an EXACT catalog label: a name
 * that matches only the material (not one of its variants) must not be booked
 * under the first variant. And editing a total must not overwrite the notes
 * the allocation already carries; the server keeps them when p_notes is null.
 */
import { materialsApi } from '../src/api/supabase-materials';
import supabase from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: { from: jest.fn(), rpc: jest.fn() },
}));

const mockFrom = supabase.from as unknown as jest.Mock;
const mockRpc = supabase.rpc as unknown as jest.Mock;

const catalogWith = (rows: unknown[]) => {
  mockFrom.mockReturnValue({
    select: () => ({ eq: async () => ({ data: rows, error: null }) }),
  });
};

describe('materialsApi.assignToProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockResolvedValue({ data: { id: 1 }, error: null });
  });

  it('books the variant whose label was typed', async () => {
    catalogWith([{
      id: 1,
      name: 'Cemento',
      catalog_variants: [
        { id: 5, display_name: 'Estándar', active: true },
        { id: 6, display_name: 'Gris', active: true },
      ],
    }]);

    await materialsApi.assignToProject(9, { material_name: 'Cemento · Gris', quantity: 2 });

    expect(mockRpc).toHaveBeenCalledWith('assign_catalog_material_to_project', expect.objectContaining({
      p_catalog_variant_id: 6,
    }));
  });

  it('refuses a name that matches only the material when no variant matches exactly', async () => {
    // Before this change the first active variant (6) was booked silently.
    catalogWith([{
      id: 1,
      name: 'Cemento',
      catalog_variants: [{ id: 6, display_name: 'Gris', active: true }],
    }]);

    await expect(
      materialsApi.assignToProject(9, { material_name: 'Cemento', quantity: 2 }),
    ).rejects.toThrow('El material no existe en el catálogo activo');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('materialsApi.updateAssignedQuantity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockResolvedValue({ data: { id: 1 }, error: null });
  });

  it('sends p_notes = null so the allocation keeps its existing notes', async () => {
    await materialsApi.updateAssignedQuantity(42, 12.5);

    expect(mockRpc).toHaveBeenCalledWith('update_project_material_assignment', {
      p_assignment_id: 42,
      p_new_total: 12.5,
      p_notes: null,
    });
  });
});
