const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import { mirrorProject, mirrorProjects } from '../src/db/repositories/projects';

/**
 * Guards Defect A from the 2026-07-26 local-data-layer audit. The admin
 * projects mirror omitted `created_at` and used destructive REPLACE semantics.
 * SQLite could therefore destroy timestamps or fail when child rows existed.
 *
 * These assertions also preserve each server `updated_at`; using device refresh
 * time collapsed a real project list into a 22-row ordering tie.
 */
describe('projects local mirror', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  const serverRow = {
    id: 7,
    name: 'Pozo San Isidro',
    location: 'Filadelfia',
    assigned_operator_id: 'operator-1',
    target_depth: 120,
    default_bar_length: 3,
    default_bar_diameter: '6 pulgadas',
    coordinates: '-22.339,-60.031',
    well_name: 'PSI-01',
    progress_percentage: 42,
    status: 'closure_submitted',
    created_at: '2026-05-22T10:00:00.000Z',
    updated_at: '2026-07-25T11:00:00.000Z',
  };

  it('writes the complete mirror SQL and preserves both server timestamps', async () => {
    await mirrorProject(serverRow, '2026-07-26T16:40:53.000Z');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO projects (
        id, name, location, assigned_operator_id, target_depth,
        default_bar_length, default_bar_diameter, coordinates, well_name,
        progress, status, created_at, updated_at, deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        location = excluded.location,
        assigned_operator_id = excluded.assigned_operator_id,
        target_depth = excluded.target_depth,
        default_bar_length = excluded.default_bar_length,
        default_bar_diameter = excluded.default_bar_diameter,
        coordinates = excluded.coordinates,
        well_name = excluded.well_name,
        progress = excluded.progress,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted = 0`,
      [
        7,
        'Pozo San Isidro',
        'Filadelfia',
        'operator-1',
        120,
        3,
        '6 pulgadas',
        '-22.339,-60.031',
        'PSI-01',
        42,
        'Cierre enviado',
        '2026-05-22T10:00:00.000Z',
        '2026-07-25T11:00:00.000Z',
      ],
    );
  });

  it('uses the canonical fallback values when server fields are absent', async () => {
    await mirrorProject(
      { id: 8, name: 'Pozo Norte' },
      '2026-07-26T16:40:53.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      expect.any(String),
      [
        8,
        'Pozo Norte',
        '',
        null,
        null,
        3,
        null,
        null,
        null,
        0,
        'En progreso',
        '2026-07-26T16:40:53.000Z',
        '2026-07-26T16:40:53.000Z',
      ],
    );
  });

  it('updates in place rather than deleting a project referenced by field rows', async () => {
    await mirrorProject(serverRow);
    const sql = String(mockExecute.mock.calls[0][0]);

    expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(sql).not.toContain('OR REPLACE');
  });

  it('routes a whole server response through a caller-supplied executor', async () => {
    const transactionExecute = jest.fn().mockResolvedValue(undefined);

    await mirrorProjects(
      [serverRow, { ...serverRow, id: 8 }],
      '2026-07-26T16:40:53.000Z',
      transactionExecute,
    );

    expect(transactionExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('tolerates a null or empty server response', async () => {
    await mirrorProjects(null);
    await mirrorProjects([]);

    expect(mockExecute).not.toHaveBeenCalled();
  });
});
