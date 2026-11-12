import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultMetricsPeriod } from '../src/domain/metricsPeriod.ts';

test('default period is the first day of the current Asuncion month through today', () => {
  assert.deepEqual(defaultMetricsPeriod(new Date('2026-11-09T12:00:00Z')), {
    from: '2026-11-01', to: '2026-11-09',
  });
});

test('default period respects the Asuncion date near UTC midnight', () => {
  assert.deepEqual(defaultMetricsPeriod(new Date('2026-11-01T02:30:00Z')), {
    from: '2026-10-01', to: '2026-10-31',
  });
});
