/**
 * "Is this operator on this well?" as SQL, for the screens that run their own
 * query instead of going through `loadAssignedProjects` (PozosTab needs a join
 * for current depth, so it cannot reuse the function).
 *
 * Exported rather than copied because the copy is what caused this bug: the
 * membership rule changed on the server and three separate hand-written filters
 * had to be found and updated, so one was missed. Takes the operator id TWICE.
 */
export const projectMembershipSql = (alias = ''): string => {
  const prefix = alias ? `${alias}.` : '';
  return `(
      ${prefix}assigned_operator_id = ?
      OR ${prefix}id IN (
        SELECT project_id FROM project_secondary_operators WHERE operator_id = ?
      )
    )`;
};
