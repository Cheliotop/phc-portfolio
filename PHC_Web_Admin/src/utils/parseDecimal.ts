// Parses user-typed decimal inputs. Accepts both comma ("12,5") and dot
// ("12.5") separators, trims whitespace, and never throws: blank input
// means "no value" (undefined), anything unparseable is also undefined so
// callers can show a validation error instead of saving NaN.
export const parseDecimal = (raw: string): number | undefined => {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Strictly-positive variant used by measurement fields (depths, lengths).
export const parsePositiveDecimal = (raw: string): number | undefined => {
  const parsed = parseDecimal(raw);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};
