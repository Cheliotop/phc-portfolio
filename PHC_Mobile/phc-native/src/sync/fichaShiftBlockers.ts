import { unresolvedShiftOperatorsOnWell } from '../db/repositories/shifts';
import { reconcileServerClosedShifts } from './serverClosedShifts';

export interface FichaShiftBlockers {
  blockers: Array<{ operator_id: string; name: string | null }>;
  /** False when another operator's row could not be checked with the server. */
  confirmed: boolean;
}

/**
 * Who still has an unresolved shift on the well, for the Ficha's pre-check (OPB-8).
 *
 * Another operator's row can be stale on this tablet: the server may have closed it,
 * as an admin's force-close does, since the last drain, and a stale row must not
 * block the Ficha (audit H5). So when another operator shows up, the server is asked
 * first, the same way every drain does. Offline the local rows stand, and the next
 * drain with signal clears a stale one.
 */
export const fichaShiftBlockers = async (
  projectId: number | string,
  operatorId: string | null,
): Promise<FichaShiftBlockers> => {
  const blockers = await unresolvedShiftOperatorsOnWell(projectId);
  if (!blockers.some((blocker) => blocker.operator_id !== operatorId)) {
    return { blockers, confirmed: true };
  }
  try {
    await reconcileServerClosedShifts();
  } catch {
    return { blockers, confirmed: false };
  }
  return { blockers: await unresolvedShiftOperatorsOnWell(projectId), confirmed: true };
};
