/**
 * One quantity reader for every quantity field (audit OPA-6 / OPB-7). Paraguayan
 * numbers: "." groups thousands, "," is the decimal. "1.500" is ambiguous and is
 * refused, not read as 1.5.
 */
import { formatQuantity, parseQuantity, quantityPreview, roundQuantity } from '../src/utils/quantity';

const valueOf = (raw: string) => {
  const parsed = parseQuantity(raw);
  if (parsed.ok === false) throw new Error(`expected a value for "${raw}", got: ${parsed.error}`);
  return parsed.value;
};

describe('parseQuantity', () => {
  it.each([
    ['2,5', 2.5],
    ['12', 12],
    ['0', 0],
    ['1500', 1500],
    ['1.500,5', 1500.5],
    ['1.234.567', 1234567],
    ['1.234.567,89', 1234567.89],
    ['2.5', 2.5],
    ['0.25', 0.25],
    ['  3,5 ', 3.5],
  ])('reads "%s" as %s', (raw, expected) => {
    expect(valueOf(raw)).toBe(expected);
  });

  it('refuses "1.500" (dot plus exactly three digits) and says both readings', () => {
    const parsed = parseQuantity('1.500');
    expect(parsed).toEqual({ ok: false, error: '¿1500 o 1,5? Escribí 1500 o 1,5' });
  });

  it('refuses "0.500" the same way', () => {
    expect(parseQuantity('0.500')).toEqual({ ok: false, error: '¿500 o 0,5? Escribí 500 o 0,5' });
  });

  it('refuses empty input and garbage', () => {
    expect(parseQuantity('').ok).toBe(false);
    expect(parseQuantity('   ').ok).toBe(false);
    expect(parseQuantity('abc').ok).toBe(false);
    expect(parseQuantity('-3').ok).toBe(false);
    expect(parseQuantity('1,2,3').ok).toBe(false);
  });
});

describe('rounding and display', () => {
  it('removes float noise from remaining quantities', () => {
    expect(roundQuantity(2.3 - 0.7)).toBe(1.6);
    expect(roundQuantity(1 - 0.7)).toBe(0.3);
  });

  it('shows at most three decimals with a decimal comma', () => {
    expect(formatQuantity(2.3 - 0.7)).toBe('1,6');
    expect(formatQuantity(1500)).toBe('1500');
    expect(formatQuantity(0.1234)).toBe('0,123');
  });

  it('previews the parsed value, or the refusal for an ambiguous one', () => {
    expect(quantityPreview('2,5')).toBe('= 2,5');
    expect(quantityPreview('1.500,5')).toBe('= 1500,5');
    expect(quantityPreview('1.500')).toBe('¿1500 o 1,5? Escribí 1500 o 1,5');
    expect(quantityPreview('')).toBe('');
  });
});
