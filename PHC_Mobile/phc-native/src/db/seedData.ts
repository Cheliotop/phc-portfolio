import { execute, query } from './db';

/**
 * Seed sample data for testing the PHC Native app
 */
export const seedSampleData = async (): Promise<void> => {
  try {
    // Check if data already exists to avoid duplicates
    const existingOperators = await query<{ count: number }>('SELECT COUNT(*) as count FROM operators');
    if (existingOperators[0]?.count > 0) {
      return;
    }

    // 1. Create sample operators
    await execute(`
      INSERT INTO operators (id, name, role, status, pin, created_at, updated_at)
      VALUES
        ('op_001', 'Juan Pérez', 'operator', 'active', '1234', datetime('now'), datetime('now')),
        ('op_002', 'María González', 'operator', 'active', '5678', datetime('now'), datetime('now')),
        ('op_003', 'Carlos Rodríguez', 'supervisor', 'active', '9999', datetime('now'), datetime('now'))
    `);

    // 2. Create sample projects
    await execute(`
      INSERT INTO projects (name, location, assigned_operator_id, progress, status, created_at, updated_at)
      VALUES
        ('Pozo Filadelfia Norte', 'Filadelfia, Boquerón', 'op_001', 35.5, 'En Progreso', datetime('now'), datetime('now')),
        ('Pozo Loma Plata Central', 'Loma Plata, Chaco', 'op_002', 72.0, 'En Progreso', datetime('now'), datetime('now')),
        ('Pozo Neuland Sur', 'Neuland, Boquerón', 'op_001', 15.8, 'En Progreso', datetime('now'), datetime('now'))
    `);

    // 3. Create sample material inventory
    await execute(`
      INSERT INTO material_inventory (material_name, current_stock, min_stock, unit, location, notes, created_at, updated_at)
      VALUES
        ('Tubería PVC 6"', 45.0, 10.0, 'metros', 'Almacén Principal', 'Para pozos estándar', datetime('now'), datetime('now')),
        ('Tubería PVC 8"', 25.0, 5.0, 'metros', 'Almacén Principal', 'Para pozos de gran diámetro', datetime('now'), datetime('now')),
        ('Barras de perforación 3m', 120.0, 30.0, 'unidades', 'Patio de herramientas', 'Barras estándar', datetime('now'), datetime('now')),
        ('Cemento para sellar', 8.0, 3.0, 'bolsas', 'Almacén Materiales', 'Para sellado final', datetime('now'), datetime('now')),
        ('Filtros de arena', 15.0, 5.0, 'unidades', 'Almacén Principal', 'Filtros estándar', datetime('now'), datetime('now'))
    `);

    // 4. Create sample progress logs
    await execute(`
      INSERT INTO progress_logs_dashboard (
        project_id, operator_id, date, depth_start, depth_end, bars_added,
        bar_type, drilling_method, soil_type, water_level, notes, created_at, updated_at
      )
      VALUES
        (1, 'op_001', date('now', '-2 days'), 0.0, 15.5, 5, '3 metros', 'Rotary', 'Arena compacta', NULL, 'Inicio de perforación, suelo firme', datetime('now'), datetime('now')),
        (1, 'op_001', date('now', '-1 day'), 15.5, 28.0, 4, '3 metros', 'Rotary', 'Arcilla', 12.5, 'Encontrado nivel freático', datetime('now'), datetime('now')),
        (2, 'op_002', date('now', '-3 days'), 45.0, 62.0, 6, '3 metros', 'Percusión', 'Arena gruesa', 8.2, 'Buena velocidad de avance', datetime('now'), datetime('now')),
        (3, 'op_001', date('now'), 0.0, 8.5, 3, '3 metros', 'Rotary', 'Tierra negra', NULL, 'Proyecto iniciado hoy', datetime('now'), datetime('now'))
    `);

    // 5. Create sample supply requests
    await execute(`
      INSERT INTO supply_requests (
        project_id, operator_id, material, quantity, priority, reason,
        needed_by, status, admin_notes, created_at, updated_at
      )
      VALUES
        (1, 'op_001', 'Tubería PVC 6"', 20.0, 'Alta', 'Necesario para completar instalación', date('now', '+3 days'), 'Pendiente', NULL, datetime('now'), datetime('now')),
        (1, 'op_001', 'Barras de perforación 3m', 8.0, 'Normal', 'Reposición de barras desgastadas', date('now', '+5 days'), 'Pendiente', NULL, datetime('now'), datetime('now')),
        (2, 'op_002', 'Cemento para sellar', 3.0, 'Normal', 'Para sellado final del pozo', date('now', '+7 days'), 'Aprobado', 'Aprobado por supervisor', datetime('now'), datetime('now')),
        (3, 'op_001', 'Filtros de arena', 2.0, 'Baja', 'Preparación para etapa final', date('now', '+10 days'), 'Pendiente', NULL, datetime('now'), datetime('now'))
    `);

    // 6. Create sample materials used
    await execute(`
      INSERT INTO materials_used (
        project_id, operator_id, date, material_type, quantity, unit, notes, created_at, updated_at
      )
      VALUES
        (1, 'op_001', date('now', '-2 days'), 'Barras de perforación 3m', 5.0, 'unidades', 'Perforación inicial', datetime('now'), datetime('now')),
        (1, 'op_001', date('now', '-1 day'), 'Barras de perforación 3m', 4.0, 'unidades', 'Continuación perforación', datetime('now'), datetime('now')),
        (2, 'op_002', date('now', '-3 days'), 'Barras de perforación 3m', 6.0, 'unidades', 'Avance en terreno duro', datetime('now'), datetime('now')),
        (2, 'op_002', date('now', '-2 days'), 'Tubería PVC 8"', 5.0, 'metros', 'Instalación de tubería', datetime('now'), datetime('now')),
        (3, 'op_001', date('now'), 'Barras de perforación 3m', 3.0, 'unidades', 'Inicio de proyecto', datetime('now'), datetime('now'))
    `);

    // Sample data seeded successfully

  } catch (error) {
    console.error('[PHC] Error seeding sample data:', error);
    throw error;
  }
};

/**
 * Get database statistics for verification
 */
export const getDatabaseStats = async () => {
  const stats = {
    operators: await query<{ count: number }>('SELECT COUNT(*) as count FROM operators'),
    projects: await query<{ count: number }>('SELECT COUNT(*) as count FROM projects'),
    progress_logs: await query<{ count: number }>('SELECT COUNT(*) as count FROM progress_logs_dashboard'),
    supply_requests: await query<{ count: number }>('SELECT COUNT(*) as count FROM supply_requests'),
    materials_used: await query<{ count: number }>('SELECT COUNT(*) as count FROM materials_used'),
    material_inventory: await query<{ count: number }>('SELECT COUNT(*) as count FROM material_inventory'),
  };

  return {
    operators: stats.operators[0]?.count || 0,
    projects: stats.projects[0]?.count || 0,
    progress_logs: stats.progress_logs[0]?.count || 0,
    supply_requests: stats.supply_requests[0]?.count || 0,
    materials_used: stats.materials_used[0]?.count || 0,
    material_inventory: stats.material_inventory[0]?.count || 0,
  };
};

/**
 * Clear all sample data (for testing purposes)
 */
export const clearSampleData = async (): Promise<void> => {
  // Delete in reverse order due to foreign key constraints
  await execute('DELETE FROM materials_used');
  await execute('DELETE FROM supply_requests');
  await execute('DELETE FROM progress_logs_dashboard');
  await execute('DELETE FROM projects');
  await execute('DELETE FROM material_inventory');
  await execute('DELETE FROM operators');
};
