/** Code read O10: the bottle photo's caption said just "Muestra". */
jest.mock('../src/db/db', () => ({ execute: jest.fn(), query: jest.fn(), queryFirst: jest.fn() }));
import { waterSamplePhotoCaption } from '../src/sync/productV2Sync';

it('names the depth and the time, since the number comes later from the server', () => {
  const caption = waterSamplePhotoCaption({ depthM: 12.5, takenAt: '2026-11-08T13:30:00.000Z' });
  expect(caption).toMatch(/^Muestra de agua · 12\.5 m · /);
  expect(caption).toContain('10:30');
});

it('uses the number when the payload has one', () => {
  expect(waterSamplePhotoCaption({ sampleNumber: 4 })).toBe('Muestra de agua #4');
});
