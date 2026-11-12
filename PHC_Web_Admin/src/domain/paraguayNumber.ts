// Numbers as Paraguayan accounting exports and admins type them: "." groups
// thousands and "," marks decimals ("1.234,56" = 1234.56). "2,5" and "2.5" are
// decimals. A single dot followed by exactly three digits ("1.200") is ambiguous:
// it may be 1200 or 1.2, so the caller must ask the admin instead of guessing
// (audit WEB-6).
export type ParsedNumber =
  | { kind: 'ok'; value: number }
  | { kind: 'ambiguous'; asThousands: number; asDecimal: number }
  | { kind: 'invalid' };

const GROUPED_WITH_DECIMAL = /^-?\d{1,3}(\.\d{3})+,\d+$/;
const DECIMAL_COMMA = /^-?\d+,\d+$/;
const DOT_GROUPS = /^-?\d{1,3}(\.\d{3})+$/;
const PLAIN_DECIMAL_DOT = /^-?\d+\.\d+$/;
const INTEGER = /^-?\d+$/;

export const parseParaguayanNumber = (raw: string): ParsedNumber => {
  const text = raw.trim();
  if (!text) return { kind: 'invalid' };
  if (GROUPED_WITH_DECIMAL.test(text)) {
    return { kind: 'ok', value: Number(text.replace(/\./g, '').replace(',', '.')) };
  }
  if (DECIMAL_COMMA.test(text)) return { kind: 'ok', value: Number(text.replace(',', '.')) };
  if (DOT_GROUPS.test(text)) {
    const dots = text.split('.').length - 1;
    if (dots === 1) {
      return { kind: 'ambiguous', asThousands: Number(text.replace('.', '')), asDecimal: Number(text) };
    }
    return { kind: 'ok', value: Number(text.replace(/\./g, '')) };
  }
  if (PLAIN_DECIMAL_DOT.test(text) || INTEGER.test(text)) return { kind: 'ok', value: Number(text) };
  return { kind: 'invalid' };
};
