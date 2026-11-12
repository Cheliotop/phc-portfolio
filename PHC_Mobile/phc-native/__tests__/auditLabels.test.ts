/**
 * The audit trail is written by a database trigger in English by construction:
 * `action` is `table_name || '.' || lower(TG_OP)` and `entity_type` is the raw
 * table name. Anything rendered straight from the row reaches a Paraguayan
 * administrator as "shifts · insert".
 */
import {
  auditActionLabel,
  entityLabel,
  fieldLabel,
  humanizeToken,
} from '../src/domain/auditLabels';

describe('audit labels', () => {
  it('names the real trigger output in Spanish', () => {
    expect(auditActionLabel('shifts.insert')).toBe('Turno creado');
    expect(auditActionLabel('drilling_bars.update')).toBe('Barra de perforación modificada');
    expect(auditActionLabel('pedidos.delete')).toBe('Pedido eliminado');
  });

  it('labels the second crew operator without subcontractor wording', () => {
    expect(entityLabel('project_secondary_operators')).toBe('Operador 2 del equipo');
    expect(auditActionLabel('project_secondary_operators.insert')).toBe('Operador 2 del equipo creado');
  });

  it('agrees in gender', () => {
    // "Foto creado" is the kind of detail that makes software feel machine-made.
    expect(auditActionLabel('photos.insert')).toBe('Foto creada');
    expect(auditActionLabel('completion_reports.insert')).toBe('Ficha técnica creada');
    expect(auditActionLabel('projects.insert')).toBe('Proyecto creado');
  });

  it('degrades to readable words for a table added later', () => {
    // A new table with a trigger must not render blank in an append-only log.
    expect(auditActionLabel('rig_inspections.insert')).toBe('rig inspections creado');
    expect(entityLabel('rig_inspections')).toBe('rig inspections');
  });

  it('survives an unknown operation and a missing action', () => {
    expect(auditActionLabel('shifts.truncate')).toBe('Turno · truncate');
    expect(auditActionLabel(null)).toBe('Evento');
    expect(auditActionLabel('')).toBe('Evento');
    expect(entityLabel(null)).toBe('Registro');
  });

  it('splits on the LAST dot, so a schema-qualified name still works', () => {
    expect(auditActionLabel('public.shifts.insert')).toBe('public · shifts creado');
  });

  it('names correction fields the way an administrator says them', () => {
    // Picking the wrong field here silently corrects the wrong number.
    expect(fieldLabel('depth_end')).toBe('Profundidad final');
    expect(fieldLabel('static_level')).toBe('Nivel estático');
    expect(fieldLabel('quantity_used')).toBe('Cantidad usada');
    expect(fieldLabel('unknown_column')).toBe('unknown column');
    expect(fieldLabel(null)).toBe('');
  });

  it('never uses replaceAll — keep compatibility with older installed runtimes', () => {
    expect(humanizeToken('a_b.c_d')).toBe('a b · c d');
  });
});
