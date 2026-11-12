import assert from 'node:assert/strict';
import test from 'node:test';
import { asuncionLocalInput, validateForceCloseEnd } from '../src/domain/forceClose.ts';

const start = '2026-11-08T12:00:00.000Z'; // 09:00 in Asunción
const now = new Date('2026-11-08T18:00:00.000Z'); // 15:00 in Asunción

test('the default end time is now, in Paraguay time', () => {
  assert.equal(asuncionLocalInput(now), '2026-11-08T15:00');
});

test('an end time between start and now is accepted and sent as an ISO instant', () => {
  assert.deepEqual(validateForceCloseEnd(start, '2026-11-08T14:30', now), {
    ok: true, endedAtIso: '2026-11-08T17:30:00.000Z',
  });
});

test('an end time before the shift start is refused', () => {
  assert.equal(validateForceCloseEnd(start, '2026-11-08T08:00', now).ok, false);
});

test('an end time in the future is refused', () => {
  assert.equal(validateForceCloseEnd(start, '2026-11-08T16:00', now).ok, false);
});

test('a shift longer than 12 hours is refused', () => {
  const longStart = '2026-11-07T20:00:00.000Z'; // 17:00 on 7 Nov
  assert.equal(validateForceCloseEnd(longStart, '2026-11-08T14:00', now).ok, false);
  assert.equal(validateForceCloseEnd(longStart, '2026-11-08T05:00', now).ok, true);
});

test('an empty or malformed value is refused', () => {
  assert.equal(validateForceCloseEnd(start, '', now).ok, false);
  assert.equal(validateForceCloseEnd(start, '08/11/2026 14:00', now).ok, false);
});
