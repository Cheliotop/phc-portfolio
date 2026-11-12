import { parseParaguayanNumber } from './paraguayNumber.ts';

// Budget (presupuesto) import: a real CSV splitter (quoted fields may hold the
// delimiter), Paraguayan number formats, and every rejected line reported with its
// line number instead of disappearing (audit WEB-6).

export interface BudgetVariant {
  id: number;
  label: string;
  code?: string | null;
  unit: string;
}

export interface BudgetLineDraft {
  id: string;
  lineNumber: number;
  externalCode?: string;
  description: string;
  // null while the admin has to choose between the two readings of "1.200".
  quantity: number | null;
  quantityChoices?: [number, number];
  unit: string;
  catalogVariantId?: number;
  createNew: boolean;
}

export interface RejectedBudgetLine {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface BudgetParseResult {
  lines: BudgetLineDraft[];
  rejected: RejectedBudgetLine[];
}

// RFC 4180 style: "" inside quotes is a literal quote; a delimiter inside quotes is text.
export const splitDelimited = (line: string, delimiter: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"' && current.trim() === '') {
      quoted = true;
      current = '';
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
};

// One delimiter for the whole file, taken from its first non-empty line.
export const detectDelimiter = (text: string): string => {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') || '';
  if (first.includes('\t')) return '\t';
  if (first.includes(';')) return ';';
  return ',';
};

const normalize = (value?: string | null) => (value || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .trim()
  .toLocaleLowerCase('es');

export const parseBudgetText = (text: string, variants: BudgetVariant[]): BudgetParseResult => {
  const delimiter = detectDelimiter(text);
  const lines: BudgetLineDraft[] = [];
  const rejected: RejectedBudgetLine[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === '') return;
    const lineNumber = index + 1;
    const reject = (reason: string) => rejected.push({ lineNumber, raw: raw.trim(), reason });
    const columns = splitDelimited(raw, delimiter);
    if (columns.length < 3) {
      reject('Faltan columnas: código, descripción, cantidad y unidad (o descripción, cantidad y unidad).');
      return;
    }
    // Columns after the unit are ignored on purpose (prices, taxes, balances).
    const [externalCode, description, quantityRaw, unitRaw] = columns.length >= 4
      ? columns
      : ['', columns[0], columns[1], columns[2]];
    if (!description) {
      reject('Falta la descripción del material.');
      return;
    }
    const parsed = parseParaguayanNumber(quantityRaw);
    const exactCode = variants.find((variant) => externalCode && normalize(variant.code) === normalize(externalCode));
    const exactName = variants.find((variant) => normalize(variant.label) === normalize(description));
    const match = exactCode || exactName;
    const base = {
      id: `line_${lineNumber}`,
      lineNumber,
      externalCode: externalCode || undefined,
      description,
      unit: unitRaw || match?.unit || 'unidad',
      catalogVariantId: match?.id,
      createNew: !match,
    };

    if (parsed.kind === 'invalid') {
      reject(`Cantidad inválida: «${quantityRaw}». Usá números como 12, 2,5 o 1.234,56.`);
      return;
    }
    if (parsed.kind === 'ambiguous') {
      if (parsed.asThousands <= 0 && parsed.asDecimal <= 0) {
        reject('La cantidad debe ser mayor que cero.');
        return;
      }
      lines.push({ ...base, quantity: null, quantityChoices: [parsed.asThousands, parsed.asDecimal] });
      return;
    }
    if (!(parsed.value > 0)) {
      reject('La cantidad debe ser mayor que cero.');
      return;
    }
    lines.push({ ...base, quantity: parsed.value });
  });

  return { lines, rejected };
};
