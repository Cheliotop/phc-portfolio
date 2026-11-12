// Who entered each dossier row and who was on each shift (equipo: two operators per well).
// Names come from the operator directory joined client-side; the rows carry operator_id.

export interface CrewOperator {
  id: string;
  full_name?: string | null;
  username?: string | null;
}

export interface ShiftParticipantRow {
  shift_id: string;
  operator_id: string;
}

export interface DossierCrew {
  names: Map<string, string>;
  participantsByShift: Map<string, string[]>;
}

export const EMPTY_DOSSIER_CREW: DossierCrew = { names: new Map(), participantsByShift: new Map() };

export const operatorDisplayName = (operator: Partial<CrewOperator> | null | undefined): string =>
  operator?.full_name || operator?.username || 'Operador sin nombre';

export const buildDossierCrew = (
  operators: CrewOperator[],
  participants: ShiftParticipantRow[],
): DossierCrew => {
  const names = new Map(operators.map((operator) => [operator.id, operatorDisplayName(operator)]));
  const participantsByShift = new Map<string, string[]>();
  for (const row of participants) {
    const shiftId = String(row.shift_id);
    const list = participantsByShift.get(shiftId) ?? [];
    if (!list.includes(row.operator_id)) list.push(row.operator_id);
    participantsByShift.set(shiftId, list);
  }
  return { names, participantsByShift };
};

const nameOf = (crew: DossierCrew, operatorId: string): string =>
  crew.names.get(operatorId) ?? 'Operador desconocido';

// "Ingresado por": the operator who typed the row. Never a UUID.
export const enteredByLabel = (operatorId: unknown, crew: DossierCrew): string =>
  typeof operatorId === 'string' && operatorId ? nameOf(crew, operatorId) : '—';

// Everyone on a shift. A shift with no participant rows falls back to the operator who started it.
export const shiftCrewLabel = (
  shift: { id?: unknown; operator_id?: unknown },
  crew: DossierCrew,
): string => {
  const ids = crew.participantsByShift.get(String(shift.id))
    ?? (typeof shift.operator_id === 'string' && shift.operator_id ? [shift.operator_id] : []);
  return ids.map((id) => nameOf(crew, id)).join(' · ') || '—';
};

export const arrivedLateLabel = (row: { arrived_late?: unknown }): string =>
  row.arrived_late === true ? 'Llegó tarde' : '—';
