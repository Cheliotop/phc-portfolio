// Dashboard source failures. A source that fails is named and shown as an error;
// its fallback empty value must never read as "nothing pending" (WEB-9).

export const recordFailure = <T>(failures: string[], label: string, fallback: () => T) => (): T => {
  if (!failures.includes(label)) failures.push(label);
  return fallback();
};

export const failedSourcesMessage = (failures: string[]): string | null => (
  failures.length
    ? `No se pudieron cargar: ${failures.join(', ')}. Los números pueden estar incompletos; una alerta que no aparece no significa que no haya pendientes.`
    : null
);
