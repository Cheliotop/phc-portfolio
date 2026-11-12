const dateInAsuncion = (date: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export interface MetricsPeriod {
  from: string;
  to: string;
}

export const defaultMetricsPeriod = (now = new Date()): MetricsPeriod => {
  const to = dateInAsuncion(now);
  return { from: `${to.slice(0, 8)}01`, to };
};
