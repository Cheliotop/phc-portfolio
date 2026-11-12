/**
 * JavaScript runtime compatibility guard.
 *
 * Releases before v2.0.42 ran JavaScriptCore and exposed a class of failures
 * that Node-based tests could not reproduce. Expo SDK 54 removes bundled JSC,
 * so current releases use Hermes, but the portable source rules remain useful
 * for upgrade compatibility and installed older builds.
 *
 * This is invisible to the rest of the pipeline, which is what makes it
 * dangerous: Jest runs on Node and TypeScript's lib declares these methods, so
 * a call to one of them typechecks, passes 272 tests, builds a correctly signed
 * release, and then throws on the device. On 2026-07-31 `String.replaceAll` in
 * OperacionTab's `humanize` did exactly that — it ran during render, so the
 * ErrorBoundary took down the whole tab. The same call sat unnoticed in
 * adminListPdf's `escapeHtml`, one tap away from breaking every list export.
 *
 * If you need one of these, write the portable form instead:
 *   value.replaceAll(a, b)   ->  value.split(a).join(b)
 *   arr.at(-1)               ->  arr[arr.length - 1]
 *   Object.hasOwn(o, k)      ->  Object.prototype.hasOwnProperty.call(o, k)
 *
 * Reconsider the conservative method list after the Hermes release has been
 * verified on physical hardware.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Method name -> portable replacement to suggest in the failure message. */
const UNSAFE: Record<string, string> = {
  replaceAll: 'split(x).join(y)',
  at: 'arr[arr.length - 1] for negative indices',
  hasOwn: 'Object.prototype.hasOwnProperty.call(obj, key)',
  structuredClone: 'an explicit deep copy',
  findLast: 'a reversed copy with find()',
  findLastIndex: 'a reversed copy with findIndex()',
  toSorted: '[...arr].sort()',
  toReversed: '[...arr].reverse()',
  toSpliced: '[...arr].splice()',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('JavaScript runtime compatibility', () => {
  it('ships Expo SDK 54 releases with Hermes', () => {
    const gradle = fs.readFileSync(path.join(ROOT, 'android', 'gradle.properties'), 'utf8');
    expect(gradle).toMatch(/hermesEnabled\s*=\s*true/);
  });

  /**
   * `toLocaleString('es-PY', …)` is worse than a missing method: it does not
   * throw. Without full ICU the engine ignores the locale and returns English,
   * so the app keeps working and quietly shows "Jul 31, 2026" to a Paraguayan
   * user — including in the PDFs the client receives.
   *
   * The 2026-07-31 review claimed this class was already guarded. It was not:
   * the guard above only covers missing *methods*, so four call sites survived
   * and one of them was found by a person reading the Historial screen. Format
   * with utils/dateFormat, which needs no locale data at all.
   *
   * `toLocaleLowerCase`/`toLocaleUpperCase` are deliberately allowed: they are
   * used for search normalisation, not display, and behave correctly for the
   * Latin alphabet without ICU.
   */
  it('formats no date through the locale formatter', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // dateFormat.ts documents the trap in prose; it does not call it.
      if (path.basename(file) === 'dateFormat.ts') continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((lineText, index) => {
        const code = lineText.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/\.toLocale(?:String|DateString|TimeString)\s*\(/.test(code)) {
          hits.push(
            `  ${path.relative(SRC, file)}:${index + 1}  the locale is ignored`
            + ' without ICU — use formatDisplayDate/formatDisplayDateTime',
          );
        }
        if (/\bnew Intl\./.test(code)) {
          hits.push(
            `  ${path.relative(SRC, file)}:${index + 1}  Intl is not available`
            + " — it throws \"Can't find variable: Intl\"",
          );
        }
      });
    }
    expect(hits.length === 0 ? '' : `\n${hits.join('\n')}\n`).toBe('');
  });

  it('calls no method missing from the bundled JavaScriptCore', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((lineText, index) => {
        // Ignore comment lines so the guidance in these very comments is fine.
        const code = lineText.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const [method, alternative] of Object.entries(UNSAFE)) {
          const called = new RegExp(`(?:\\.|\\bObject\\.|\\b)${method}\\s*\\(`).test(code);
          if (!called) continue;
          // `.at(` is common in unrelated identifiers; require a real call site.
          if (method === 'at' && !/\.\s*at\s*\(\s*-/.test(code)) continue;
          hits.push(
            `  ${path.relative(SRC, file)}:${index + 1}  ${method}() — use ${alternative}`,
          );
        }
      });
    }
    expect(hits.length === 0 ? '' : `\n${hits.join('\n')}\n`).toBe('');
  });
});
