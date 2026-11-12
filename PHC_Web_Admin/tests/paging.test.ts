import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAllPages, inBatches } from '../src/domain/paging.ts';

const source = (total: number) => Array.from({ length: total }, (_, index) => index);
const serve = (rows: number[]) => async (from: number, to: number) => rows.slice(from, to + 1);

test('reads past the first page', async () => {
  const rows = await fetchAllPages(serve(source(2500)), 1000);
  assert.equal(rows.length, 2500);
  assert.equal(rows[2499], 2499);
});

test('a full last page is followed by an empty one and still ends', async () => {
  const rows = await fetchAllPages(serve(source(2000)), 1000);
  assert.equal(rows.length, 2000);
});

test('an empty result is an empty list', async () => {
  assert.deepEqual(await fetchAllPages(serve([]), 1000), []);
});

test('inBatches splits a long id list and keeps every id once, in order', () => {
  const ids = Array.from({ length: 250 }, (_, index) => `s${index}`);
  const batches = inBatches(ids);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 50]);
  assert.deepEqual(batches.flat(), ids);
  assert.deepEqual(inBatches([]), []);
});
