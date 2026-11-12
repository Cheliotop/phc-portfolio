const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockQueryFirst = jest.fn();
const mockDeleteOutbox = jest.fn();
const mockMarkOutboxFailed = jest.fn();
const mockCreateBar = jest.fn();

jest.mock('../src/db/db', () => ({
  execute: (...args: any[]) => mockExecute(...args),
  query: (...args: any[]) => mockQuery(...args),
  queryFirst: (...args: any[]) => mockQueryFirst(...args),
}));

jest.mock('../src/db/operations', () => ({
  selectDrainableOutboxRows: jest.requireActual('../src/db/operations').selectDrainableOutboxRows,
  deleteOutbox: (...args: any[]) => mockDeleteOutbox(...args),
  markOutboxFailed: (...args: any[]) => mockMarkOutboxFailed(...args),
}));

jest.mock('../src/api/supabase-drilling-bars', () => ({
  drillingBarsApi: {
    create: (...args: any[]) => mockCreateBar(...args),
  },
}));

jest.mock('../src/api/supabase-photos', () => ({
  photosApi: {
    uploadProjectPhoto: jest.fn(),
  },
}));

import { syncPendingDrillingBars } from '../src/sync/drillingSync';

const queuedBar = {
  id: 'outbox-bar',
  entity: 'drilling_bar',
  entity_id: 'local-bar',
  op: 'create',
  payload_json: JSON.stringify({
    project_id: 23,
    shift_id: 'server-shift',
    client_entry_id: 'offline-bar',
    soil_type: 'Roca',
    length: 6,
    timestamp_local: '2026-07-13T18:26:00-04:00',
  }),
  retries: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({ changes: 1 });
  mockDeleteOutbox.mockResolvedValue(undefined);
  mockMarkOutboxFailed.mockResolvedValue(undefined);
});

it('syncs a bar when its shift has a server id even if a queued shift end left sync_status pending', async () => {
  mockQuery.mockResolvedValue([queuedBar]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift', sync_status: 'pending' });
  mockCreateBar.mockResolvedValue({
    data: {
      id: 119,
      bar_number: 2,
      depth_start: 6,
      depth_end: 12,
      length: 6,
    },
  });

  const result = await syncPendingDrillingBars();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockCreateBar).toHaveBeenCalledWith(
    expect.objectContaining({ shift_id: 'server-shift', client_entry_id: 'offline-bar' }),
    null,
  );
  expect(mockDeleteOutbox).toHaveBeenCalledWith('outbox-bar');
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

it('waits without burning a retry when the parent shift has not reached the server', async () => {
  mockQuery.mockResolvedValue([queuedBar]);
  mockQueryFirst.mockResolvedValue({ server_id: null, sync_status: 'pending' });

  const result = await syncPendingDrillingBars();

  // A dependency wait is neither a success nor a failure: it must not burn a
  // retry (markOutboxFailed) NOR be counted in the "fallidos" badge.
  expect(result).toEqual({ synced: 0, failed: 0 });
  expect(mockCreateBar).not.toHaveBeenCalled();
  expect(mockDeleteOutbox).not.toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});

/**
 * A shift started offline gets a local id; the server assigns its own on sync.
 * Everything sent afterwards has to carry the SERVER id.
 *
 * The two tests above both used 'server-shift' as the local id AND the server
 * id, so they could never tell the two apart — which is why this shipped. On a
 * real handset on 2026-08-01 a subcontractor's offline bar came back as
 * "new row violates row-level security policy" with 0 retries: the photos
 * INSERT policy requires EXISTS (SELECT 1 FROM shifts WHERE id = shift_id),
 * and a local id matches nothing, so the write was permanently quarantined.
 *
 * The sync already waited for proof the shift existed remotely. It just never
 * carried the id it had gone to the trouble of proving.
 */
const barWithLocalShift = {
  ...queuedBar,
  payload_json: JSON.stringify({
    ...JSON.parse(queuedBar.payload_json),
    shift_id: 'local-shift-uuid',
  }),
};

const barWithLocalShiftAndPhoto = {
  ...queuedBar,
  payload_json: JSON.stringify({
    ...JSON.parse(queuedBar.payload_json),
    shift_id: 'local-shift-uuid',
    photo_paths: ['file:///data/user/0/com.phc/cache/bar1.jpg'],
  }),
};

it('sends the server shift id, not the local one', async () => {
  mockQuery.mockResolvedValue([barWithLocalShift]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-uuid', sync_status: 'synced' });
  mockCreateBar.mockResolvedValue({ data: { id: 120, bar_number: 3, depth_start: 12, depth_end: 18, length: 6 } });

  const result = await syncPendingDrillingBars();

  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(mockCreateBar).toHaveBeenCalledWith(
    expect.objectContaining({ shift_id: 'server-shift-uuid' }),
    null,
  );
  expect(mockCreateBar).not.toHaveBeenCalledWith(
    expect.objectContaining({ shift_id: 'local-shift-uuid' }),
  );
});

it('attaches the server shift id to the photo, which is what RLS checks', async () => {
  const { photosApi } = require('../src/api/supabase-photos');
  photosApi.uploadProjectPhoto.mockResolvedValue({ photo: { id: 7, url: 'https://x/p.jpg' } });

  mockQuery.mockResolvedValue([barWithLocalShiftAndPhoto]);
  mockQueryFirst.mockResolvedValue({ server_id: 'server-shift-uuid', sync_status: 'synced' });
  mockCreateBar.mockResolvedValue({ data: { id: 121, bar_number: 4, depth_start: 18, depth_end: 24, length: 6 } });

  await syncPendingDrillingBars();

  expect(photosApi.uploadProjectPhoto).toHaveBeenCalledWith(
    23,
    expect.any(String),
    expect.any(String),
    expect.objectContaining({ shiftId: 'server-shift-uuid' }),
  );
});
