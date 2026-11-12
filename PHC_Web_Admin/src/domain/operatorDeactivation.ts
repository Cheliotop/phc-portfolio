export interface DeactivationContext {
  name: string;
  openShiftCount: number;
  wellNames: string[];
}

// Builds the confirmation text shown before an operator is deactivated (ADM-3).
export const deactivationConfirmation = ({ name, openShiftCount, wellNames }: DeactivationContext): string => {
  const warnings = [
    openShiftCount ? `Tiene ${openShiftCount} turno(s) sin resolver.` : '',
    wellNames.length ? `Es operador 1 o 2 en: ${wellNames.join(', ')}.` : '',
    'El trabajo que todavía no se sincronizó desde la tablet puede ir a Revisión.',
  ].filter(Boolean);
  return `¿Desactivar a ${name}?\n\n${warnings.join('\n')}\n\n¿Querés continuar?`;
};
