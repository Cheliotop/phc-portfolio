export const operatorDeactivationConfirmation = (name: string): string =>
  `¿Desactivar a ${name}? Si todavía hay trabajo sin sincronizar desde la tablet, puede enviarse a Revisión. Revisá las tareas pendientes antes de continuar. ¿Querés seguir?`;

export const operator2ErrorMessage = (raw: string): string => {
  if (/responsable del pozo|operador 1 del pozo|responsible operator|subcontractor/i.test(raw)) {
    return 'El operador principal no puede ser también operador 2 del equipo.';
  }
  if (/project_secondary_operators/i.test(raw) && /duplicate|23505/i.test(raw)) {
    return 'Ese operador ya forma parte del equipo de este pozo.';
  }
  return raw;
};
