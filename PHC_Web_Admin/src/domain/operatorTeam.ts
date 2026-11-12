import type { OperatorDirectoryEntry } from '../types/productV2';

export const operatorTeamLabel = (
  primaryId: string | null | undefined,
  secondaryIds: string[],
  operators: OperatorDirectoryEntry[],
): string => {
  const ids = [primaryId, ...secondaryIds].filter((id): id is string => Boolean(id));
  return ids.map((id) => {
    const operator = operators.find((entry) => entry.id === id);
    return operator?.full_name || operator?.username || '—';
  }).join(' · ') || '—';
};
