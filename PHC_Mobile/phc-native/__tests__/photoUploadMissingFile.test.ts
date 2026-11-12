/**
 * Android may clear the cache folder that holds camera pictures while a bar waits
 * offline. The upload must say so plainly, so the bar can go without the photo,
 * but never when an earlier attempt already stored it.
 */
const mockMaybeSingle = jest.fn();
const mockSignedUrl = jest.fn(async () => ({ data: { signedUrl: 'https://signed/url' } }));

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => mockMaybeSingle() }) }),
    }),
    storage: { from: () => ({ createSignedUrl: mockSignedUrl }) },
  },
}));

import * as FileSystem from 'expo-file-system/legacy';
import { LocalPhotoMissingError } from '../src/api/photoErrors';
import { photosApi } from '../src/api/supabase-photos';

const getInfo = FileSystem.getInfoAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getInfo.mockImplementation(async () => ({ exists: true, size: 1024 }));
});

it('reports a camera file that is gone and was never uploaded', async () => {
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  getInfo.mockResolvedValue({ exists: false });

  await expect(photosApi.uploadProjectPhoto(7, 'file:///cache/ImagePicker/a.jpg', 'Barra 3', {
    clientEntryId: 'bar-1-photo-1',
  })).rejects.toBeInstanceOf(LocalPhotoMissingError);
});

it('returns the earlier upload when the file is gone but the server has it', async () => {
  mockMaybeSingle.mockResolvedValue({
    data: {
      id: 41, project_id: 7, shift_id: null, evidence_kind: 'field', caption: 'Barra 3', original_name: 'a.jpg',
    },
    error: null,
  });
  getInfo.mockResolvedValue({ exists: false });

  const result = await photosApi.uploadProjectPhoto(7, 'file:///cache/ImagePicker/a.jpg', 'Barra 3', {
    clientEntryId: 'bar-1-photo-1',
  });

  expect(result.photo).toEqual(expect.objectContaining({ id: 41, filename: '7/bar-1-photo-1_a.jpg' }));
});

it('keeps retrying when it could not ask the server about an earlier upload', async () => {
  const outage = { message: 'Failed to fetch', code: '' };
  mockMaybeSingle.mockResolvedValue({ data: null, error: outage });
  getInfo.mockResolvedValue({ exists: false });

  await expect(photosApi.uploadProjectPhoto(7, 'file:///cache/ImagePicker/a.jpg', 'Barra 3', {
    clientEntryId: 'bar-1-photo-1',
  })).rejects.toBe(outage);
});
