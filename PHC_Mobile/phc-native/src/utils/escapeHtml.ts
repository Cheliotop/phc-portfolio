// Escape text for HTML handed to expo-print. Every value that reaches a
// generated PDF goes through this: project names, notes and signatures are
// typed by people, and an unescaped "<" corrupts the document.
//
// Keep split/join rather than replaceAll for compatibility with installed
// devices and any older JavaScript runtime retained during staged upgrades.
// Ampersand must stay first.
export const escapeHtml = (value: unknown): string => String(value ?? '')
  .split('&').join('&amp;')
  .split('<').join('&lt;')
  .split('>').join('&gt;')
  .split('"').join('&quot;')
  .split("'").join('&#039;');
