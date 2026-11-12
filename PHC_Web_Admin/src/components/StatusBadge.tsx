import { statusLabel, statusToneFor } from '../domain/projectStatus';

export const StatusBadge = ({ status }: { status?: string | null }) => (
  <span className={`badge badge-${statusToneFor(status)}`}>{statusLabel(status)}</span>
);
