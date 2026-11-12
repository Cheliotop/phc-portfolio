import { runInTransaction } from '../db/db';
import { ensureOperatorStub } from '../db/repositories/operators';
import { mirrorUnresolvedShift } from '../db/repositories/shifts';
import { shiftsApi } from '../api/supabase-shifts';
import { createClientEntryId, createClientUuid } from '../utils/clientId';
import { isPermanentRejection } from './rejection';

/**
 * Starting a shift needs the server, with no offline exception: shifts on a well
 * must never overlap, because the admin pays hours from them, and only the server
 * can see another operator's phone. So nothing is written locally until the server
 * has said yes, and a failed attempt leaves nothing behind to sync later.
 *
 * A retry after a lost response is safe. The server returns the operator's
 * unresolved shift instead of creating a second one, so `resumed` covers it.
 */
export type ShiftStartOutcome =
  | { kind: 'started' }
  | { kind: 'resumed' }
  | { kind: 'no_connection' }
  | { kind: 'refused'; message: string };

/** The first words of start_shift's refusal; see 20261106120000. */
const OVERLAP_REFUSAL = /^Todavía no podés iniciar/;

const refusalMessage = (error: unknown): string => {
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof message === 'string' && OVERLAP_REFUSAL.test(message)) return message;
  if (code === '42501') return 'Este pozo ya no está asignado a vos. Hablá con el administrador.';
  if (code === '55000') return 'Este pozo no está abierto para iniciar un turno. Hablá con el administrador.';
  return 'El servidor no aceptó el inicio del turno. Intentá de nuevo o avisale al administrador.';
};

export const startShiftOnServer = async (input: {
  projectId: number;
  operatorId: string;
  operatorName: string;
}): Promise<ShiftStartOutcome> => {
  const shiftId = createClientUuid();
  const deviceStartedAt = new Date().toISOString();

  let shift;
  try {
    shift = await shiftsApi.start({
      projectId: input.projectId,
      shiftId,
      clientEntryId: createClientEntryId('shift'),
      deviceStartedAt,
      enteredBy: input.operatorId,
    });
  } catch (error) {
    return isPermanentRejection(error)
      ? { kind: 'refused', message: refusalMessage(error) }
      : { kind: 'no_connection' };
  }

  // A failure here is local, so it is left to surface. The server has the shift,
  // and the next load finds it through the unresolved shift refresh.
  const now = new Date().toISOString();
  await runInTransaction(async (transaction) => {
    await ensureOperatorStub({
      id: input.operatorId,
      name: input.operatorName,
      currentTime: now,
    }, transaction.execute);
    await mirrorUnresolvedShift(shift, now, transaction.execute);
  });
  return { kind: shift.id === shiftId ? 'started' : 'resumed' };
};
