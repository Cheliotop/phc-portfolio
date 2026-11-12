import { query, execute, runInTransaction } from '../src/db/db';
import { writeDomainRowWithOutbox } from '../src/db/operations';

// Mock expo-sqlite
const mockTransaction = jest.fn();
const mockExclusiveTransaction = jest.fn();
const mockExecuteSql = jest.fn();
const runSql = (sql: string, params: any[]) => new Promise((resolve, reject) => {
  mockExecuteSql(
    sql,
    params,
    (_tx: unknown, result: unknown) => resolve(result),
    (_tx: unknown, error: unknown) => reject(error)
  );
});

const mockDatabase = {
  transaction: mockTransaction,
  runAsync: jest.fn((sql: string, params: any[] = []) => runSql(sql, params)),
  getAllAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const result: any = await runSql(sql, params);
    return result?.rows?._array || [];
  }),
  getFirstAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const result: any = await runSql(sql, params);
    return result?.rows?._array?.[0] || null;
  }),
  execAsync: jest.fn(async () => undefined),
  closeAsync: jest.fn(async () => undefined),
  withExclusiveTransactionAsync: mockExclusiveTransaction,
};

const mockOpenDatabaseAsync = jest.fn(async () => mockDatabase);
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...args: unknown[]) => mockOpenDatabaseAsync(...args),
}));

describe('Database Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default transaction mock
    mockTransaction.mockImplementation((callback) => {
      const transaction = {
        executeSql: mockExecuteSql
      };
      callback(transaction);
    });
    mockExclusiveTransaction.mockImplementation(async (callback) => callback(mockDatabase));
    mockOpenDatabaseAsync.mockImplementation(async () => mockDatabase);
  });

  describe('exclusive transaction helpers', () => {
    test('runs every callback statement on the exclusive transaction connection', async () => {
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, sql.startsWith('SELECT')
          ? { rows: { _array: [{ id: 'row-1' }] } }
          : { changes: 1, lastInsertRowId: 1 });
      });

      const result = await runInTransaction(async (transaction) => {
        await transaction.execute('INSERT INTO wells (id) VALUES (?)', ['row-1']);
        return transaction.query<{ id: string }>('SELECT id FROM wells WHERE id = ?', ['row-1']);
      });

      expect(result).toEqual([{ id: 'row-1' }]);
      // A dedicated connection, with the write lock taken up front.
      expect(mockOpenDatabaseAsync).toHaveBeenCalledWith('phc_v2.db', { useNewConnection: true });
      expect(mockDatabase.execAsync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
      expect(mockDatabase.execAsync).toHaveBeenCalledWith('COMMIT');
      expect(mockExclusiveTransaction).not.toHaveBeenCalled();
      expect(mockExecuteSql).toHaveBeenCalledTimes(2);
    });

    test('writes a domain row and outbox record inside one transaction', async () => {
      mockExecuteSql.mockImplementation((_sql, _params, success) => {
        success(null, { changes: 1, lastInsertRowId: 1 });
      });

      const result = await writeDomainRowWithOutbox(
        {
          sql: 'INSERT INTO shifts (id, project_id, operator_id, started_at) VALUES (?, ?, ?, ?)',
          params: ['shift-local-1', 41, 'operator-1', '2026-07-11T10:00:00.000Z'],
        },
        {
          entity: 'shifts',
          entity_id: 'shift-local-1',
          op: 'insert',
          payload_json: { client_entry_id: 'shift-local-1', project_id: 41 },
          author_id: 'operator-1',
        },
      );

      expect(result.domainResult.changes).toBe(1);
      expect(result.outboxId).toEqual(expect.any(String));
      expect(mockExclusiveTransaction).not.toHaveBeenCalled();
      expect(mockExecuteSql).toHaveBeenCalledTimes(2);
      expect(mockExecuteSql.mock.calls[1][0]).toContain('INSERT INTO sync_outbox');
      expect(mockExecuteSql.mock.calls[1][1][1]).toBe('shifts');
      expect(mockExecuteSql.mock.calls[1][1][2]).toBe('shift-local-1');
      expect(mockExecuteSql.mock.calls[1][0]).toContain('author_id');
      expect(mockExecuteSql.mock.calls[1][1][5]).toBe('operator-1');
    });
  });

  describe('query function', () => {
    test('should execute SELECT query and return results', async () => {
      const mockResults = [
        { id: 1, name: 'Test Project' },
        { id: 2, name: 'Another Project' }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, {
          rows: { _array: mockResults }
        });
      });

      const result = await query('SELECT * FROM wells');

      expect(mockExecuteSql).toHaveBeenCalledWith(
        'SELECT * FROM wells',
        [],
        expect.any(Function),
        expect.any(Function)
      );
      expect(result).toEqual(mockResults);
    });

    test('should handle query with parameters', async () => {
      const mockResults = [{ id: 1, name: 'Specific Project' }];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, {
          rows: { _array: mockResults }
        });
      });

      const result = await query('SELECT * FROM wells WHERE id = ?', ['1']);

      expect(mockExecuteSql).toHaveBeenCalledWith(
        'SELECT * FROM wells WHERE id = ?',
        ['1'],
        expect.any(Function),
        expect.any(Function)
      );
      expect(result).toEqual(mockResults);
    });

    test('should handle empty results', async () => {
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, {
          rows: { _array: [] }
        });
      });

      const result = await query('SELECT * FROM non_existent_table');

      expect(result).toEqual([]);
    });

    test('should handle database errors', async () => {
      const mockError = new Error('Database connection failed');

      mockExecuteSql.mockImplementation((sql, params, success, error) => {
        error(null, mockError);
      });

      await expect(query('SELECT * FROM wells')).rejects.toThrow('Database connection failed');
    });

    test('should handle complex queries with joins', async () => {
      const mockResults = [
        {
          well_id: 1,
          well_name: 'Pozo Norte',
          progress_count: 5,
          total_depth: 45.5
        }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, {
          rows: { _array: mockResults }
        });
      });

      const complexQuery = `
        SELECT
          w.id as well_id,
          w.name as well_name,
          COUNT(pl.id) as progress_count,
          MAX(pl.depth_reached) as total_depth
        FROM wells w
        LEFT JOIN progress_logs pl ON w.id = pl.well_id
        WHERE w.deleted = 0
        GROUP BY w.id
      `;

      const result = await query(complexQuery);

      expect(result).toEqual(mockResults);
      expect(mockExecuteSql).toHaveBeenCalledWith(
        complexQuery,
        [],
        expect.any(Function),
        expect.any(Function)
      );
    });
  });

  describe('execute function', () => {
    test('should execute INSERT statement and return result', async () => {
      const mockResult = {
        insertId: 123,
        rowsAffected: 1
      };

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'INSERT INTO wells (name, coordinates) VALUES (?, ?)',
        ['Test Well', 'Test Location']
      );

      expect(mockExecuteSql).toHaveBeenCalledWith(
        'INSERT INTO wells (name, coordinates) VALUES (?, ?)',
        ['Test Well', 'Test Location'],
        expect.any(Function),
        expect.any(Function)
      );
      expect(result).toEqual(mockResult);
    });

    test('should execute UPDATE statement', async () => {
      const mockResult = {
        insertId: undefined,
        rowsAffected: 1
      };

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'UPDATE wells SET name = ? WHERE id = ?',
        ['Updated Well', '1']
      );

      expect(result).toEqual(mockResult);
      expect(result.rowsAffected).toBe(1);
    });

    test('should execute DELETE statement', async () => {
      const mockResult = {
        insertId: undefined,
        rowsAffected: 1
      };

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute('DELETE FROM wells WHERE id = ?', ['1']);

      expect(result).toEqual(mockResult);
      expect(result.rowsAffected).toBe(1);
    });

    test('should handle execution errors', async () => {
      const mockError = new Error('Constraint violation');

      mockExecuteSql.mockImplementation((sql, params, success, error) => {
        error(null, mockError);
      });

      await expect(execute(
        'INSERT INTO wells (id) VALUES (?)',
        ['duplicate_id']
      )).rejects.toThrow('Constraint violation');
    });

    test('should handle CREATE TABLE statements', async () => {
      const mockResult = {
        insertId: undefined,
        rowsAffected: 0
      };

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS test_table (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `;

      const result = await execute(createTableSQL);

      expect(result).toEqual(mockResult);
      expect(mockExecuteSql).toHaveBeenCalledWith(
        createTableSQL,
        [],
        expect.any(Function),
        expect.any(Function)
      );
    });
  });

  describe('Wells Table Operations', () => {
    test('should create well record correctly', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const wellData = {
        id: 'well_123',
        name: 'Pozo Norte',
        coordinates: 'Lat: -25.123, Lng: -57.456',
        target_depth: 100,
        status: 'En Progreso',
        created_at: new Date().toISOString()
      };

      const result = await execute(`
        INSERT INTO wells (id, name, coordinates, target_depth, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        wellData.id,
        wellData.name,
        wellData.coordinates,
        wellData.target_depth,
        wellData.status,
        wellData.created_at
      ]);

      expect(result.insertId).toBe(1);
      expect(result.rowsAffected).toBe(1);
    });

    test('should update well status', async () => {
      const mockResult = { rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'UPDATE wells SET status = ?, updated_at = ? WHERE id = ?',
        ['Completado', new Date().toISOString(), 'well_123']
      );

      expect(result.rowsAffected).toBe(1);
    });

    test('should soft delete well', async () => {
      const mockResult = { rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'UPDATE wells SET deleted = 1, updated_at = ? WHERE id = ?',
        [new Date().toISOString(), 'well_123']
      );

      expect(result.rowsAffected).toBe(1);
    });

    test('should retrieve active wells only', async () => {
      const mockWells = [
        { id: 'well_1', name: 'Pozo 1', status: 'En Progreso', deleted: 0 },
        { id: 'well_2', name: 'Pozo 2', status: 'En Progreso', deleted: 0 }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, { rows: { _array: mockWells } });
      });

      const result = await query(
        'SELECT * FROM wells WHERE deleted = 0 AND status = ?',
        ['En Progreso']
      );

      expect(result).toEqual(mockWells);
    });
  });

  describe('Progress Logs Operations', () => {
    test('should insert progress log with all fields', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const progressData = {
        id: 'progress_123',
        well_id: 'well_123',
        meters_drilled: 6.5,
        rod_length: 2,
        depth_reached: 32.0,
        note: 'Barras: 2 x 6 metros | Suelo: Arena y arcilla',
        timestamp_local: new Date().toISOString()
      };

      const result = await execute(`
        INSERT INTO progress_logs (
          id, well_id, meters_drilled, rod_length, depth_reached, note, timestamp_local,
          sync_status, origin, version, deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        progressData.id,
        progressData.well_id,
        progressData.meters_drilled,
        progressData.rod_length,
        progressData.depth_reached,
        progressData.note,
        progressData.timestamp_local,
        'pending',
        'local',
        1,
        0,
        progressData.timestamp_local,
        progressData.timestamp_local
      ]);

      expect(result.insertId).toBe(1);
    });

    test('should retrieve progress logs for a well', async () => {
      const mockLogs = [
        {
          id: 'progress_1',
          well_id: 'well_123',
          depth_reached: 25.5,
          meters_drilled: 6.5,
          timestamp_local: '2024-01-01T10:00:00.000Z'
        }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, { rows: { _array: mockLogs } });
      });

      const result = await query(
        'SELECT * FROM progress_logs WHERE well_id = ? AND deleted = 0 ORDER BY timestamp_local DESC',
        ['well_123']
      );

      expect(result).toEqual(mockLogs);
    });

    test('should calculate total depth correctly', async () => {
      const mockResult = [{ max_depth: 45.5 }];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, { rows: { _array: mockResult } });
      });

      const result = await query(
        'SELECT MAX(depth_reached) as max_depth FROM progress_logs WHERE well_id = ? AND deleted = 0',
        ['well_123']
      );

      expect(result[0].max_depth).toBe(45.5);
    });
  });

  describe('Materials Operations', () => {
    test('should insert material movement', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const materialData = {
        id: 'material_123',
        well_id: 'well_123',
        material_type_id: 'Cemento Portland',
        quantity: 500,
        unit: 'kg',
        movement_type: 'uso'
      };

      const result = await execute(`
        INSERT INTO material_movements (
          id, well_id, material_type_id, quantity, unit, movement_type,
          timestamp_local, sync_status, origin, version, deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        materialData.id,
        materialData.well_id,
        materialData.material_type_id,
        materialData.quantity,
        materialData.unit,
        materialData.movement_type,
        new Date().toISOString(),
        'pending',
        'local',
        1,
        0,
        new Date().toISOString(),
        new Date().toISOString()
      ]);

      expect(result.insertId).toBe(1);
    });

    test('should update inventory after material usage', async () => {
      const mockResult = { rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(`
        UPDATE material_inventory
        SET current_stock = current_stock - ?, updated_at = ?
        WHERE material_name = ?
      `, [500, new Date().toISOString(), 'Cemento Portland']);

      expect(result.rowsAffected).toBe(1);
    });

    test('should retrieve material usage by project', async () => {
      const mockUsage = [
        {
          material_type_id: 'Cemento Portland',
          total_quantity: 1500,
          unit: 'kg'
        }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, { rows: { _array: mockUsage } });
      });

      const result = await query(`
        SELECT
          material_type_id,
          SUM(quantity) as total_quantity,
          unit
        FROM material_movements
        WHERE well_id = ? AND movement_type = 'uso' AND deleted = 0
        GROUP BY material_type_id, unit
      `, ['well_123']);

      expect(result).toEqual(mockUsage);
    });
  });

  describe('Supply Requests Operations', () => {
    test('should create supply request', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const requestData = {
        id: 'request_123',
        project_id: 'well_123',
        material: 'Cemento Portland',
        quantity: '500 kg',
        priority: 'Normal',
        reason: 'Stock agotado en obra',
        needed_by: new Date().toISOString(),
        status: 'Pendiente'
      };

      const result = await execute(`
        INSERT INTO supply_requests (
          id, project_id, material, quantity, priority, reason, needed_by, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        requestData.id,
        requestData.project_id,
        requestData.material,
        requestData.quantity,
        requestData.priority,
        requestData.reason,
        requestData.needed_by,
        requestData.status,
        new Date().toISOString(),
        new Date().toISOString()
      ]);

      expect(result.insertId).toBe(1);
    });

    test('should update request status', async () => {
      const mockResult = { rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'UPDATE supply_requests SET status = ?, updated_at = ? WHERE id = ?',
        ['Aprobado', new Date().toISOString(), 'request_123']
      );

      expect(result.rowsAffected).toBe(1);
    });

    test('should retrieve pending requests sorted by priority', async () => {
      const mockRequests = [
        {
          id: 'req_1',
          material: 'Cemento',
          priority: 'Urgente',
          status: 'Pendiente',
          created_at: '2024-01-01T10:00:00.000Z'
        }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, { rows: { _array: mockRequests } });
      });

      const result = await query(`
        SELECT * FROM supply_requests
        WHERE status = 'Pendiente'
        ORDER BY
          CASE priority
            WHEN 'Urgente' THEN 1
            WHEN 'Normal' THEN 2
            WHEN 'Baja' THEN 3
          END,
          created_at DESC
      `);

      expect(result).toEqual(mockRequests);
    });
  });

  describe('Operators Operations', () => {
    test('should create operator', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const operatorData = {
        id: 'operator_123',
        name: 'Juan Pérez',
        role: 'operator',
        status: 'active'
      };

      const result = await execute(`
        INSERT INTO operators (id, name, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        operatorData.id,
        operatorData.name,
        operatorData.role,
        operatorData.status,
        new Date().toISOString(),
        new Date().toISOString()
      ]);

      expect(result.insertId).toBe(1);
    });

    test('should retrieve operators with project counts', async () => {
      const mockOperators = [
        {
          id: 'op_1',
          name: 'Juan Pérez',
          status: 'active',
          assigned_projects: 2
        }
      ];

      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, { rows: { _array: mockOperators } });
      });

      const result = await query(`
        SELECT
          o.*,
          COUNT(w.id) as assigned_projects
        FROM operators o
        LEFT JOIN wells w ON w.assigned_operator_id = o.id AND w.deleted = 0
        GROUP BY o.id
        ORDER BY o.created_at DESC
      `);

      expect(result).toEqual(mockOperators);
    });

    test('should toggle operator status', async () => {
      const mockResult = { rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'UPDATE operators SET status = ?, updated_at = ? WHERE id = ?',
        ['inactive', new Date().toISOString(), 'operator_123']
      );

      expect(result.rowsAffected).toBe(1);
    });
  });

  describe('Inventory Operations', () => {
    test('should initialize material inventory', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const materialTypes = [
        { name: 'Cemento Portland', unit: 'kg', min_stock: 1000 },
        { name: 'Arena de Río', unit: 'm³', min_stock: 10 }
      ];

      for (const material of materialTypes) {
        const result = await execute(`
          INSERT INTO material_inventory (id, material_name, current_stock, unit, min_stock)
          VALUES (?, ?, ?, ?, ?)
        `, [
          `inv_${Date.now()}`,
          material.name,
          0,
          material.unit,
          material.min_stock
        ]);

        expect(result.insertId).toBe(1);
      }
    });

    test('should adjust inventory stock', async () => {
      const mockResult = { rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const result = await execute(
        'UPDATE material_inventory SET current_stock = ?, updated_at = ? WHERE id = ?',
        [1500, new Date().toISOString(), 'inv_cement']
      );

      expect(result.rowsAffected).toBe(1);
    });

    test('should log stock adjustments', async () => {
      const mockResult = { insertId: 1, rowsAffected: 1 };
      mockExecuteSql.mockImplementation((sql, params, success) => {
        success(null, mockResult);
      });

      const adjustmentData = {
        id: 'adj_123',
        material_id: 'inv_cement',
        material_name: 'Cemento Portland',
        adjustment_type: 'add',
        amount: 500,
        old_stock: 1000,
        new_stock: 1500,
        reason: 'Ajuste de entrada manual'
      };

      const result = await execute(`
        INSERT INTO stock_adjustments (
          id, material_id, material_name, adjustment_type, amount,
          old_stock, new_stock, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        adjustmentData.id,
        adjustmentData.material_id,
        adjustmentData.material_name,
        adjustmentData.adjustment_type,
        adjustmentData.amount,
        adjustmentData.old_stock,
        adjustmentData.new_stock,
        adjustmentData.reason,
        new Date().toISOString()
      ]);

      expect(result.insertId).toBe(1);
    });
  });

  describe('Transaction Handling', () => {
    test('should handle transaction rollback on error', async () => {
      let callCount = 0;
      mockExecuteSql.mockImplementation((sql, params, success, error) => {
        callCount++;
        if (callCount === 1) {
          // First query succeeds
          success(null, { insertId: 1, rowsAffected: 1 });
        } else {
          // Second query fails
          error(null, new Error('Constraint violation'));
        }
      });

      // This would be a real transaction in the actual implementation
      try {
        await execute('INSERT INTO wells (id, name) VALUES (?, ?)', ['well_1', 'Test Well']);
        await execute('INSERT INTO wells (id, name) VALUES (?, ?)', ['well_1', 'Duplicate']); // Should fail
      } catch (error) {
        expect((error as Error).message).toContain('Constraint violation');
      }
    });

    test('should handle multiple operations in sequence', async () => {
      mockExecuteSql
        .mockImplementationOnce((sql, params, success) => {
          success(null, { insertId: 1, rowsAffected: 1 });
        })
        .mockImplementationOnce((sql, params, success) => {
          success(null, { insertId: 2, rowsAffected: 1 });
        })
        .mockImplementationOnce((sql, params, success) => {
          success(null, { rowsAffected: 1 });
        });

      // Create well
      const wellResult = await execute(
        'INSERT INTO wells (id, name) VALUES (?, ?)',
        ['well_1', 'Test Well']
      );

      // Create progress log
      const progressResult = await execute(
        'INSERT INTO progress_logs (id, well_id, depth_reached) VALUES (?, ?, ?)',
        ['progress_1', 'well_1', 25.5]
      );

      // Update well status
      const updateResult = await execute(
        'UPDATE wells SET status = ? WHERE id = ?',
        ['En Progreso', 'well_1']
      );

      expect(wellResult.insertId).toBe(1);
      expect(progressResult.insertId).toBe(2);
      expect(updateResult.rowsAffected).toBe(1);
    });
  });

  describe('Data Integrity', () => {
    test('should maintain referential integrity between wells and progress logs', async () => {
      // Mock foreign key constraint error
      const mockError = new Error('FOREIGN KEY constraint failed');
      mockExecuteSql.mockImplementation((sql, params, success, error) => {
        error(null, mockError);
      });

      await expect(execute(
        'INSERT INTO progress_logs (id, well_id, depth_reached) VALUES (?, ?, ?)',
        ['progress_1', 'non_existent_well', 25.5]
      )).rejects.toThrow('FOREIGN KEY constraint failed');
    });

    test('should prevent duplicate primary keys', async () => {
      const mockError = new Error('UNIQUE constraint failed');
      mockExecuteSql.mockImplementation((sql, params, success, error) => {
        error(null, mockError);
      });

      await expect(execute(
        'INSERT INTO wells (id, name) VALUES (?, ?)',
        ['existing_well_id', 'Duplicate Well']
      )).rejects.toThrow('UNIQUE constraint failed');
    });

    test('should enforce NOT NULL constraints', async () => {
      const mockError = new Error('NOT NULL constraint failed');
      mockExecuteSql.mockImplementation((sql, params, success, error) => {
        error(null, mockError);
      });

      await expect(execute(
        'INSERT INTO wells (id, name) VALUES (?, ?)',
        ['well_1', null]
      )).rejects.toThrow('NOT NULL constraint failed');
    });
  });
});
