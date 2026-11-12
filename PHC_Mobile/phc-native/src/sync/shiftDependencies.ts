import { queryFirst } from '../db/db';

/**
 * Whether a shift's handover is still waiting to upload.
 *
 * The server refuses bars and the close of a shift whose handover it hasn't
 * confirmed, with 55000, which the queue treats as final (code read S1). The phone
 * shows the handover confirmed straight away, so bars recorded while it cools down
 * after a failure used to go first and land in review, out of order. A handover the
 * server refused for good holds nothing: the operator confirms it again from the
 * shift screen, which queues a new one.
 */
export const handoverStillQueued = async (localShiftId: string): Promise<boolean> => {
  const row = await queryFirst<{ found: number }>(
    `SELECT 1 AS found FROM sync_outbox
     WHERE entity = 'shift_handover' AND entity_id = ?
       AND COALESCE(state, 'pending') <> 'quarantined'
     LIMIT 1`,
    [localShiftId],
  );
  return Number(row?.found) === 1;
};
