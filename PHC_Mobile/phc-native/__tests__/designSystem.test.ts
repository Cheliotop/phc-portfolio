/**
 * Design-system guard.
 *
 * The app already had a complete token system in src/theme/phcTheme.ts, but
 * most screens re-typed raw values instead of importing it. That drift is what
 * made the UI look inconsistent: 37 distinct colours where the theme defines
 * ~25, 29 spacing values against a 7-step scale, and placeholder text at
 * 2.68:1 contrast on navy.
 *
 * These tests fail the build if that drift starts again. If you need a value
 * that is not on a scale, add the step to the theme — do not inline it here.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'src');

/**
 * The PDF generators render a light print palette onto paper and must not
 * inherit the dark navy app theme. The theme file is where values are defined.
 */
const EXEMPT = [
  path.join('src', 'theme', 'phcTheme.ts'),
  path.join('src', 'utils', 'adminListPdf.ts'),
];

/** Pure black is a shadow colour, not a brand decision. */
const ALLOWED_LITERALS = new Set(['#000', '#000000', 'transparent']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    const rel = path.relative(path.join(__dirname, '..'), full);
    return EXEMPT.includes(rel) ? [] : [full];
  });
}

function report(hits: string[][]): string {
  return hits.map(([file, detail]) => `  ${file}: ${detail}`).join('\n');
}

describe('design system', () => {
  const files = sourceFiles(SRC);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('declares no raw hex colours outside the theme', () => {
    const hits: string[][] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (ALLOWED_LITERALS.has(m[0].toLowerCase())) continue;
        // HTML numeric entities such as &#039; are not colours.
        if (m.index !== undefined && text[m.index - 1] === '&') continue;
        const line = text.slice(0, m.index).split('\n').length;
        hits.push([`${path.relative(SRC, file)}:${line}`, `${m[0]} — import the token from phcTheme instead`]);
      }
    }
    expect(hits.length === 0 ? '' : `\n${report(hits)}\n`).toBe('');
  });

  it('declares no off-scale spacing, radius or font-size literals', () => {
    const patterns: [RegExp, string][] = [
      [/\b(?:padding|margin|gap)(?:Top|Bottom|Left|Right|Horizontal|Vertical)?:\s*(\d+)\b/g, 'SPACING'],
      [/\bborderRadius:\s*(\d+)\b/g, 'RADIUS'],
      [/\bfontSize:\s*(\d+)\b/g, 'TYPE'],
    ];
    const hits: string[][] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [pattern, scale] of patterns) {
        for (const m of text.matchAll(pattern)) {
          const line = text.slice(0, m.index).split('\n').length;
          hits.push([`${path.relative(SRC, file)}:${line}`, `numeric literal ${m[1]} — use a ${scale} token`]);
        }
      }
    }
    expect(hits.length === 0 ? '' : `\n${report(hits)}\n`).toBe('');
  });

  it('keeps every text colour token above WCAG AA on the navy surfaces', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { COLORS } = require('../src/theme/phcTheme');
    const luminance = (hex: string) => {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
      const lin = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const ratio = (a: string, b: string) => {
      const [la, lb] = [luminance(a), luminance(b)];
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const surfaces = [COLORS.background, COLORS.surface, COLORS.cardElevated, COLORS.input];
    const textTokens: [string, string][] = [
      ['text', COLORS.text],
      ['textSecondary', COLORS.textSecondary],
      ['textMuted', COLORS.textMuted],
      ['placeholder', COLORS.placeholder],
      ['errorText', COLORS.errorText],
      ['successText', COLORS.successText],
      ['warningText', COLORS.warningText],
    ];

    const failures = textTokens.flatMap(([name, value]) =>
      surfaces
        .map((bg) => ({ bg, r: ratio(value, bg) }))
        .filter(({ r }) => r < 4.5)
        .map(({ bg, r }) => `  ${name} (${value}) on ${bg} = ${r.toFixed(2)}:1, needs 4.5:1`),
    );
    expect(failures.length === 0 ? '' : `\n${failures.join('\n')}\n`).toBe('');
  });

  it('keeps the two most-used text tiers at AAA', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { COLORS } = require('../src/theme/phcTheme');
    const surfaces = [COLORS.background, COLORS.surface, COLORS.cardElevated, COLORS.input];
    const worst = (c: string) => Math.min(...surfaces.map((s) => ratioOf(c, s)));
    const failures = ([['text', COLORS.text], ['textSecondary', COLORS.textSecondary]] as [string, string][])
      .filter(([, v]) => worst(v) < 7)
      .map(([n, v]) => `  ${n} (${v}) worst case ${worst(v).toFixed(2)}:1, needs 7:1`);
    expect(failures.length === 0 ? '' : `\n${failures.join('\n')}\n`).toBe('');
  });

  it('never uses a fill colour as text', () => {
    // `primary` and `accent` are tuned to be filled behind white text. As a
    // text colour on a dark surface they scored 2.02:1 and 3.91:1, and 23
    // places used them that way. `primaryText` is the readable counterpart.
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/(?<![A-Za-z])color:\s*COLORS\.(primary|accent|success|warning|error|danger)\b/.test(line)) {
          hits.push(`  ${path.relative(SRC, file)}:${i + 1}  use COLORS.primaryText / *Text variants for text`);
        }
      });
    }
    expect(hits.length === 0 ? '' : `\n${hits.join('\n')}\n`).toBe('');
  });

  it('keeps surfaces and borders visually separable', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { COLORS } = require('../src/theme/phcTheme');
    // These were all under 1.5:1 before 2026-07-31, which is why nothing on
    // screen had a visible edge. The fill lift is modest because there is very
    // little luminance between the background and the action colour, so the
    // border is what has to stay visible.
    const checks: [string, string, string, number][] = [
      ['card vs background', COLORS.surface, COLORS.background, 1.3],
      ['elevated vs card', COLORS.cardElevated, COLORS.surface, 1.2],
      ['input vs card', COLORS.input, COLORS.surface, 1.25],
      ['border vs card', COLORS.border, COLORS.surface, 2.0],
      ['borderStrong vs card', COLORS.borderStrong, COLORS.surface, 3.0],
      ['primary action vs card', COLORS.primary, COLORS.surface, 1.6],
    ];
    const failures = checks
      .map(([label, a, b, min]) => ({ label, a, b, min, r: ratioOf(a, b) }))
      .filter(({ r, min }) => r < min)
      .map(({ label, a, b, min, r }) => `  ${label}: ${a} vs ${b} = ${r.toFixed(2)}:1, needs ${min}:1`);
    expect(failures.length === 0 ? '' : `\n${failures.join('\n')}\n`).toBe('');
  });
});

/** Shared contrast helper for the assertions above. */
function ratioOf(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
