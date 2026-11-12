/**
 * One reader for every quantity the operator types (usage report, handover,
 * pedidos, receipts, bar length, water level).
 *
 * Paraguayan numbers use "." for thousands and "," for decimals, so:
 *   "2,5"      = 2.5
 *   "1500"     = 1500
 *   "1.500,5"  = 1500.5
 *   "1.500.000" = 1500000
 * A dot followed by exactly three digits with no comma ("1.500") could be
 * 1500 or 1.5, so it is refused instead of guessed (audit OPA-6 / OPB-7). A dot
 * with any other number of digits after it ("2.5") is read as a decimal point.
 */

export type QuantityParse =
  | { ok: true; value: number }
  | { ok: false; error: string };

const PLAIN_INTEGER = /^\d+$/;
const COMMA_DECIMAL = /^\d+,\d+$/;
const THOUSANDS_WITH_COMMA = /^\d{1,3}(\.\d{3})+,\d+$/;
const THOUSANDS_ONLY = /^\d{1,3}(\.\d{3})+$/;
const DOT_DECIMAL = /^\d+\.\d+$/;

const EMPTY_ERROR = 'Ingresá una cantidad.';
const INVALID_ERROR = 'La cantidad debe ser un número, por ejemplo 12 o 2,5.';

export const parseQuantity = (raw: string): QuantityParse => {
  // Spaces (including thin and non-breaking ones from the keyboard) are noise.
  const text = (raw ?? '').replace(/[\s  ]/g, '');
  if (text === '') return { ok: false, error: EMPTY_ERROR };

  if (PLAIN_INTEGER.test(text)) return { ok: true, value: Number(text) };

  if (COMMA_DECIMAL.test(text)) {
    return { ok: true, value: Number(text.replace(',', '.')) };
  }

  if (THOUSANDS_WITH_COMMA.test(text)) {
    return { ok: true, value: Number(text.replace(/\./g, '').replace(',', '.')) };
  }

  if (THOUSANDS_ONLY.test(text)) {
    // Several groups ("1.500.000") can only be thousands. A single group ("1.500")
    // is the ambiguous case.
    const groups = text.split('.').length - 1;
    if (groups > 1) return { ok: true, value: Number(text.replace(/\./g, '')) };
    const asThousands = Number(text.replace(/\./g, ''));
    const asDecimal = Number(text);
    return {
      ok: false,
      error: `¿${asThousands} o ${String(asDecimal).replace('.', ',')}? Escribí ${asThousands} o ${String(asDecimal).replace('.', ',')}`,
    };
  }

  if (DOT_DECIMAL.test(text)) {
    return { ok: true, value: Number(text) };
  }

  return { ok: false, error: INVALID_ERROR };
};

/** Rounds to 3 decimals so float noise (2.3 - 0.7) never reaches the screen. */
export const roundQuantity = (value: number): number => Math.round(value * 1000) / 1000;

/** Display form with a decimal comma, at most 3 decimals: 1.5999999 -> "1,6". */
export const formatQuantity = (value: number): string =>
  String(roundQuantity(value)).replace('.', ',');

/**
 * What the field shows under the input before saving: "= 1500" for a clear
 * reading, the refusal text for an ambiguous one, empty for nothing typed.
 */
export const quantityPreview = (raw: string): string => {
  if ((raw ?? '').trim() === '') return '';
  const parsed = parseQuantity(raw);
  return parsed.ok === true ? `= ${formatQuantity(parsed.value)}` : parsed.error;
};
