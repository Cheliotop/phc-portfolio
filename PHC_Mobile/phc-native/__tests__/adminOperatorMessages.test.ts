import { operator2ErrorMessage, operatorDeactivationConfirmation } from '../src/components/admin/operatorMessages';

describe('admin operator messages', () => {
  it('asks for confirmation by name and warns about unsynced tablet work', () => {
    expect(operatorDeactivationConfirmation('Ana Pérez')).toContain('¿Desactivar a Ana Pérez?');
    expect(operatorDeactivationConfirmation('Ana Pérez')).toContain('puede enviarse a Revisión');
    expect(operatorDeactivationConfirmation('Ana Pérez')).toContain('¿Querés seguir?');
  });

  it('translates the old secondary-role database refusal into the new crew wording', () => {
    expect(operator2ErrorMessage('Ese operador ya es el responsable del pozo (22023)'))
      .toBe('El operador principal no puede ser también operador 2 del equipo.');
    expect(operator2ErrorMessage('duplicate key project_secondary_operators (23505)'))
      .toBe('Ese operador ya forma parte del equipo de este pozo.');
  });
});
