import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrintableListHtml, writePrintableList } from '../src/utils/printableLists.ts';

// The list opens in an about:blank window that inherits the site CSP (script-src 'self'),
// so an inline onclick never runs (WEB-13). The click must be attached from the opener.
test('the printed list has no inline event handler', () => {
  const html = buildPrintableListHtml('Listado', 'x', ['ID'], [[1]]);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.match(html, /<button[^>]*id="print-list-button"[^>]*>Imprimir \/ guardar PDF<\/button>/);
});

test('the print button is wired from the opener', () => {
  const listeners: Array<{ id: string; type: string; fn: () => void }> = [];
  const timers: Array<() => void> = [];
  let printed = 0;
  const button = {
    addEventListener(type: string, fn: () => void) { listeners.push({ id: 'button', type, fn }); },
  };
  const target = {
    opener: 'opener',
    document: {
      open() {},
      write() {},
      close() {},
      getElementById(id: string) { return id === 'print-list-button' ? button : null; },
    },
    focus() {},
    print() { printed += 1; },
  };
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { setTimeout: (fn: () => void) => { timers.push(fn); return 0; } };
  try {
    writePrintableList(target as any, buildPrintableListHtml('Listado', 'x', ['ID'], [[1]]));
  } finally {
    (globalThis as any).window = previousWindow;
  }
  assert.equal(target.opener, null);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, 'click');
  listeners[0].fn();
  assert.equal(printed, 1);
  timers[0]();
  assert.equal(printed, 2);
});
