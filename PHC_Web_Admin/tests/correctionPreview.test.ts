import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCorrectionPreview } from '../src/domain/correctionPreview.ts';

test('bar correction preview identifies the well, human bar number, and value change', () => {
  assert.deepEqual(formatCorrectionPreview('drilling_bars', {
    id: 42,
    project_id: 8,
    bar_number: 7,
    depth_end: 42,
    projects: { name: 'Pozo B' },
  }, 'depth_end', 43), {
    wellName: 'Pozo B',
    recordLabel: 'Barra 7',
    currentValue: '42',
    correctedValue: '43',
  });
});

test('sample correction preview uses its sample number', () => {
  assert.equal(formatCorrectionPreview('water_samples', {
    id: 10,
    project_id: 3,
    sample_number: 3,
    notes: null,
    projects: { well_name: 'Pozo A' },
  }, 'notes', 'observación').recordLabel, 'Muestra N.º 3');
});

test('shift correction preview uses the start time and handles an empty current value', () => {
  const preview = formatCorrectionPreview('shifts', {
    id: 'shift-id', project_id: 2, started_at: '2026-11-08T10:00:00Z', notes: null,
    projects: { name: 'Pozo C' },
  }, 'notes', 'ajuste');
  assert.match(preview.recordLabel, /^Turno /);
  assert.doesNotMatch(preview.recordLabel, /T10:00:00Z/);
  assert.equal(preview.currentValue, '—');
  assert.equal(preview.correctedValue, 'ajuste');
});

test('the well is named as in the Pozo list, with its code alongside', () => {
  assert.equal(formatCorrectionPreview('drilling_bars', {
    id: 21, project_id: 5, bar_number: 3, notes: null,
    projects: { name: 'Pozo QA Chaco 05', well_name: 'PHC-QA-05' },
  }, 'notes', 'x').wellName, 'Pozo QA Chaco 05 (PHC-QA-05)');
});
