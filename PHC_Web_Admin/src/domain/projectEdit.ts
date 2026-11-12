import { parseDecimal } from '../utils/parseDecimal.ts';

// Edit-project rules (audit WEB-14). A field the admin clears must reach the server
// as null; leaving it out of the update keeps the old value on screen-less data.
export const nullIfBlank = (value: string): string | null => value.trim() || null;

export const projectEditTextFields = (values: {
  location: string;
  wellName: string;
  client: string;
  coordinates: string;
  barDiameter: string;
}) => ({
  location: nullIfBlank(values.location),
  well_name: nullIfBlank(values.wellName),
  client: nullIfBlank(values.client),
  coordinates: nullIfBlank(values.coordinates),
  default_bar_diameter: nullIfBlank(values.barDiameter),
});

// "Ajustar total": an emptied field must not become 0 (Number('') === 0).
export const materialTotalFromInput = (text: string): number | null => {
  const total = parseDecimal(text);
  return total !== undefined && total >= 0 ? total : null;
};

// Reactivating a cancelled well whose Ficha was already sent leaves that Ficha
// signable again; say so before confirming.
export const reactivationWarning = (hasSubmittedFicha: boolean): string =>
  hasSubmittedFicha ? ' Tiene una Ficha enviada sin firmar: seguirá disponible para firmar.' : '';
