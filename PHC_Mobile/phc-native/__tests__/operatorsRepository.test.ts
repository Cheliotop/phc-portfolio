const mockExecute = jest.fn();

jest.mock('../src/db/index', () => ({
  execute: (sql: string, params?: Array<string | number | null>) =>
    mockExecute(sql, params),
}));

import {
  ensureOperatorStub,
  mirrorOperator,
  updateOperatorStatus,
} from '../src/db/repositories/operators';

describe('operators repository', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(undefined);
  });

  it('mirrors server identity, name and inactive status with a non-destructive UPSERT', async () => {
    await mirrorOperator({
      id: 'operator-1',
      fullName: '',
      username: 'operador.uno',
      isActive: false,
      createdAt: '2026-07-25T09:00:00.000Z',
      currentTime: '2026-07-26T12:00:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT INTO operators (id, name, role, status, created_at, updated_at)
                   VALUES (?, ?, 'operator', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       role = excluded.role,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
      [
        'operator-1',
        'operador.uno',
        'inactive',
        '2026-07-25T09:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
      ],
    );

    expect(String(mockExecute.mock.calls[0][0])).toContain('ON CONFLICT(id) DO UPDATE');
    expect(String(mockExecute.mock.calls[0][0])).not.toContain('OR REPLACE');
    expect(String(mockExecute.mock.calls[0][0])).not.toContain('OR IGNORE');
  });

  it('derives active when the active-only server source returns is_active true', async () => {
    await mirrorOperator({
      id: 'operator-2',
      fullName: 'Operadora Dos',
      username: 'operadora.dos',
      isActive: true,
      createdAt: null,
      currentTime: '2026-07-26T12:01:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      expect.any(String),
      [
        'operator-2',
        'Operadora Dos',
        'active',
        '2026-07-26T12:01:00.000Z',
        '2026-07-26T12:01:00.000Z',
      ],
    );
  });

  it('ensures an FK stub with OR IGNORE so it cannot replace a real mirror', async () => {
    await ensureOperatorStub({
      id: 'operator-3',
      name: 'Operador Tres',
      currentTime: '2026-07-26T12:02:00.000Z',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      `INSERT OR IGNORE INTO operators (id, name, role, status, created_at, updated_at)
                 VALUES (?, ?, 'operator', 'active', ?, ?)`,
      [
        'operator-3',
        'Operador Tres',
        '2026-07-26T12:02:00.000Z',
        '2026-07-26T12:02:00.000Z',
      ],
    );

    expect(String(mockExecute.mock.calls[0][0])).toContain('INSERT OR IGNORE');
    expect(String(mockExecute.mock.calls[0][0])).not.toContain('OR REPLACE');
  });

  it('updates only the locally mirrored status after the server accepts it', async () => {
    await updateOperatorStatus(
      'operator-1',
      'active',
      '2026-07-26T12:03:00.000Z',
    );

    expect(mockExecute).toHaveBeenCalledWith(
      `
          UPDATE operators
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
      ['active', '2026-07-26T12:03:00.000Z', 'operator-1'],
    );
  });
});
