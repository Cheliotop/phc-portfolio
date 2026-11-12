export type CorrectionPreviewEntity = 'drilling_bars' | 'shifts' | 'material_consumption' | 'water_samples' | 'completion_reports';

export interface CorrectionPreview {
  wellName: string;
  recordLabel: string;
  currentValue: string;
  correctedValue: string;
}

const displayValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

const displayShiftStart = (value: unknown) => {
  if (typeof value !== 'string') return displayValue(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-PY', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Asuncion',
  });
};

export const formatCorrectionPreview = (
  entityType: CorrectionPreviewEntity,
  record: Record<string, unknown>,
  fieldName: string,
  correctedValue: unknown,
): CorrectionPreview => {
  const project = record.projects as { name?: string | null; well_name?: string | null } | null;
  let recordLabel: string;
  if (entityType === 'drilling_bars') recordLabel = `Barra ${displayValue(record.bar_number)}`;
  else if (entityType === 'water_samples') recordLabel = `Muestra N.º ${displayValue(record.sample_number)}`;
  else if (entityType === 'shifts') recordLabel = `Turno ${displayShiftStart(record.started_at)}`;
  else if (entityType === 'completion_reports') recordLabel = `Ficha #${displayValue(record.id)}`;
  else recordLabel = `Consumo #${displayValue(record.id)}`;

  return {
    // The name the admin picked in "Pozo", with the well's code when it has one.
    wellName: project?.name
      ? (project.well_name && project.well_name !== project.name ? `${project.name} (${project.well_name})` : project.name)
      : project?.well_name || `Proyecto #${displayValue(record.project_id)}`,
    recordLabel,
    currentValue: displayValue(record[fieldName]),
    correctedValue: displayValue(correctedValue),
  };
};
