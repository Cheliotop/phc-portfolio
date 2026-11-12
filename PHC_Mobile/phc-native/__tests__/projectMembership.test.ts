/**
 * A well has two kinds of operator, and every read has to honour both.
 *
 * The 2026-07-25 server migration added subcontractors (`project_secondary_
 * operators`) and widened the `projects` SELECT policy accordingly. The server
 * has returned those wells ever since and `mirrorProjects` has been storing
 * them — but four separate hand-written local filters still said
 * `assigned_operator_id = ?`, so the well arrived on the device and was thrown
 * away on the way back out. The operator was told they had no wells; the admin's
 * Operadores tab counted them as zero and invited a second assignment.
 *
 * Nothing above the device catches this: the server is right, the sync is right,
 * the types are right, and the SQL is valid. So the guard here is structural —
 * it bans the raw filter outright rather than testing one screen's behaviour,
 * because the defect was never in a screen. It was in the fourth copy.
 */
import * as fs from 'fs';
import * as path from 'path';

import { projectMembershipSql } from '../src/api/projectCache';

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('project membership', () => {
  it('matches the responsible operator and the subcontractor', () => {
    const sql = projectMembershipSql();
    expect(sql).toMatch(/assigned_operator_id = \?/);
    expect(sql).toMatch(/project_secondary_operators/);
  });

  it('qualifies every column when given a table alias', () => {
    // PozosTab joins three tables; an unqualified `id` there is ambiguous and
    // SQLite would reject the statement at runtime, not at build time.
    const sql = projectMembershipSql('p');
    expect(sql).toMatch(/p\.assigned_operator_id = \?/);
    expect(sql).toMatch(/p\.id IN/);
    expect(sql).not.toMatch(/[^.]\bid IN/);
  });

  it('takes the operator id exactly twice', () => {
    // Every call site passes [operatorId, operatorId]. If the clause ever grows
    // a third placeholder, the existing callers bind the wrong values and the
    // query silently returns nothing rather than failing.
    expect(projectMembershipSql().match(/\?/g)).toHaveLength(2);
  });

  it('leaves no screen filtering on the responsible operator alone', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      // The clause itself, the mirror that writes the column, and the admin
      // screens that legitimately read or set it are not membership checks.
      const relative = path.relative(SRC, file);
      if (
        relative === path.join('api', 'projectCache.ts')
        || relative === path.join('db', 'projectMembership.ts')
        || relative === path.join('db', 'repositories', 'projects.ts')
        || relative.startsWith('components' + path.sep + 'admin')
        || relative.startsWith('db' + path.sep + 'seedData')
      ) continue;

      fs.readFileSync(file, 'utf8').split('\n').forEach((lineText, index) => {
        const code = lineText.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        // A local SQL filter on the primary operator, e.g. `WHERE
        // assigned_operator_id = ?` or `WHERE p.assigned_operator_id = ?`.
        if (/\b(?:[A-Za-z_]+\.)?assigned_operator_id\s*=\s*\?/.test(code)) {
          offenders.push(
            `  ${relative}:${index + 1}  filters on the responsible operator only`
            + ' — use projectMembershipSql()',
          );
        }
      });
    }

    expect(offenders.length === 0 ? '' : `\n${offenders.join('\n')}\n`).toBe('');
  });
});
