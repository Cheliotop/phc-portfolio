import assert from 'node:assert/strict';
import test from 'node:test';
import { correctionFields, fieldKind, parseCorrectionValue } from '../src/domain/correctionValue.ts';

test('numbers accept a decimal comma and store a real number', () => {
  const result = parseCorrectionValue('drilling_bars', 'depth_end', '2,5');
  assert.deepEqual(result, { ok: true, value: 2.5, display: '2,5' });
});

test('an ambiguous "1.200" is refused for a number field, asking for a clear form', () => {
  const result = parseCorrectionValue('drilling_bars', 'depth_end', '1.200');
  assert.equal(result.ok, false);
});

test('integer fields refuse decimals', () => {
  assert.equal(parseCorrectionValue('water_samples', 'sample_number', '3,5').ok, false);
  assert.deepEqual(parseCorrectionValue('water_samples', 'sample_number', '3'), { ok: true, value: 3, display: '3' });
});

test('dates use DD/MM/AAAA and are sent as ISO', () => {
  assert.deepEqual(parseCorrectionValue('material_consumption', 'date', '08/11/2026'), {
    ok: true, value: '2026-11-08', display: '08/11/2026',
  });
});

test('dates are read day first: 13/11/2026 is 13 November, never MM/DD', () => {
  assert.deepEqual(parseCorrectionValue('material_consumption', 'date', '13/11/2026'), {
    ok: true, value: '2026-11-13', display: '13/11/2026',
  });
  assert.equal(parseCorrectionValue('material_consumption', 'date', '31/02/2026').ok, false);
  assert.equal(parseCorrectionValue('material_consumption', 'date', '2026-11-08').ok, false);
});

test('datetimes use DD/MM/AAAA HH:MM with the Paraguay offset', () => {
  assert.deepEqual(parseCorrectionValue('shifts', 'ended_at', '08/11/2026 14:00'), {
    ok: true, value: '2026-11-08T14:00:00-03:00', display: '08/11/2026 14:00',
  });
  assert.equal(parseCorrectionValue('shifts', 'ended_at', '08/11/2026').ok, false);
});

test('booleans take Sí or No only', () => {
  assert.deepEqual(parseCorrectionValue('material_consumption', 'approximate', 'Sí'), { ok: true, value: true, display: 'Sí' });
  assert.deepEqual(parseCorrectionValue('material_consumption', 'approximate', 'no'), { ok: true, value: false, display: 'No' });
  assert.equal(parseCorrectionValue('material_consumption', 'approximate', 'true').ok, false);
});

test('text stays text, even when it looks like a number or boolean', () => {
  assert.deepEqual(parseCorrectionValue('drilling_bars', 'notes', 'true'), { ok: true, value: 'true', display: 'true' });
  assert.deepEqual(parseCorrectionValue('drilling_bars', 'notes', '0012'), { ok: true, value: '0012', display: '0012' });
});

test('JSON fields parse, and broken JSON is refused', () => {
  assert.deepEqual(parseCorrectionValue('completion_reports', 'casing_layout', '[{"tipo":"PVC"}]'), {
    ok: true, value: [{ tipo: 'PVC' }], display: '[{"tipo":"PVC"}]',
  });
  assert.equal(parseCorrectionValue('completion_reports', 'casing_layout', '[PVC').ok, false);
});

test('empty values are refused', () => {
  assert.equal(parseCorrectionValue('drilling_bars', 'depth_end', '   ').ok, false);
});

test('the completion form offers the fields the server allows, including the ten missing ones', () => {
  const fields = correctionFields('completion_reports');
  for (const field of ['casing_above_ground_m', 'blind_casing_m', 'filter_casing_m', 'sediment_trap_m', 'centralizer_count', 'bottom_plug_details', 'bentonite_quantity', 'gravel_quantity', 'compressor_hours', 'pump_hours']) {
    assert.ok(fields.includes(field), `missing ${field}`);
  }
  assert.equal(fieldKind('completion_reports', 'centralizer_count'), 'integer');
});
