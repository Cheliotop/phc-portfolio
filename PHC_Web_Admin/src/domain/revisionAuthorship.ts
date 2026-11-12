// Who created and who sent a refused work report in Revisión (WEB-22). No imports: the node tests load this file directly.

interface Person {
  full_name?: string | null;
  username?: string | null;
}

const nameOf = (person: Person | null | undefined): string | null => person?.full_name || person?.username || null;

// Shared tablet: the operator who typed the work is not always the login that sent it.
// Null when the same user created and sent it, so no line is shown.
export const sentByLabel = (report: {
  operator_id: string;
  reported_by: string;
  operator?: Person | null;
  reporter?: Person | null;
}): string | null => {
  if (report.reported_by === report.operator_id) return null;
  const creator = nameOf(report.operator) || 'Operador desconocido';
  const sender = nameOf(report.reporter) || 'otro operador';
  return `Creado por ${creator} · enviado por ${sender} desde la tablet del equipo`;
};
