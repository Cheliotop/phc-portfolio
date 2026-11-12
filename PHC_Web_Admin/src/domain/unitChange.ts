// Changing a catalog material's unit does not convert the quantities already
// assigned to wells: the server keeps adding to the old rows (audit ADM-5, web side).
export const unitChangeWarning = (previousUnit: string, nextUnit: string): string | null => {
  const before = previousUnit.trim();
  const after = nextUnit.trim();
  if (!before || !after || before.toLocaleLowerCase('es') === after.toLocaleLowerCase('es')) return null;
  return `Cambiar la unidad de «${before}» a «${after}» no convierte las cantidades ya asignadas a los pozos: se seguirán sumando en «${before}». Revisá los pozos que usan este material antes de guardar. ¿Continuar?`;
};
