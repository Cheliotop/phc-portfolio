/**
 * Keyboard-interaction guard.
 *
 * Reported as "when you finish typing and tap the screen, the keyboard should
 * disappear — now you have to press the back button". That was true of the
 * entire app: 89 TextInputs, and not one had `returnKeyType`,
 * `onSubmitEditing` or any way out of the keyboard, and not one of the 28
 * ScrollViews dismissed it on drag.
 *
 * None of that is visible in a screenshot or catchable by a render test, which
 * is why it survived every audit. It is the layer that separates "the form
 * works" from "the app feels finished".
 *
 * Rules:
 *   single-line TextInput  must set returnKeyType and onSubmitEditing
 *   multiline TextInput    must NOT — there the return key inserts a newline
 *   ScrollView             must set keyboardDismissMode
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'src');

function screens(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return screens(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** Opening tags only, skipping `useRef<TextInput | null>` style generics. */
function openingTags(text: string, tag: string): { index: number; body: string }[] {
  const out: { index: number; body: string }[] = [];
  const needle = `<${tag}`;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return out;
    const after = text.slice(index + needle.length, index + needle.length + 40);
    if (/^\s*(?![|,>])[a-zA-Z/]/.test(after)) {
      out.push({ index, body: text.slice(index, index + 700) });
    }
    from = index + needle.length;
  }
}

const files = screens(SRC);

describe('keyboard interaction', () => {
  it('gives every single-line input a way to close the keyboard', () => {
    const misses: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { index, body } of openingTags(text, 'TextInput')) {
        const head = body.split('/>')[0];
        if (head.includes('multiline')) continue;
        if (head.includes('onSubmitEditing') && head.includes('returnKeyType')) continue;
        const line = text.slice(0, index).split('\n').length;
        misses.push(`  ${path.relative(SRC, file)}:${line}  needs returnKeyType + onSubmitEditing`);
      }
    }
    expect(misses.length === 0 ? '' : `\n${misses.join('\n')}\n`).toBe('');
  });

  it('leaves multiline inputs alone so return still inserts a newline', () => {
    const wrong: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { index, body } of openingTags(text, 'TextInput')) {
        const head = body.split('/>')[0];
        if (!head.includes('multiline')) continue;
        if (!head.includes('onSubmitEditing')) continue;
        const line = text.slice(0, index).split('\n').length;
        wrong.push(`  ${path.relative(SRC, file)}:${line}  multiline must not submit on return`);
      }
    }
    expect(wrong.length === 0 ? '' : `\n${wrong.join('\n')}\n`).toBe('');
  });

  it('dismisses the keyboard when a scroll view is dragged', () => {
    const misses: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { index, body } of openingTags(text, 'ScrollView')) {
        if (body.includes('keyboardDismissMode')) continue;
        const line = text.slice(0, index).split('\n').length;
        misses.push(`  ${path.relative(SRC, file)}:${line}  needs keyboardDismissMode="on-drag"`);
      }
    }
    expect(misses.length === 0 ? '' : `\n${misses.join('\n')}\n`).toBe('');
  });
});
