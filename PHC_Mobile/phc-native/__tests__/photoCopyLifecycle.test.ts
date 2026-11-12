/**
 * The local copy of a photo is deleted only after the server has the photo row.
 * Until then it is kept, because the next attempt still needs the file.
 */
const mockMaybeSingle = jest.fn();
const mockInsertSingle = jest.fn();
const mockUpload = jest.fn();

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => mockMaybeSingle() }) }),
      insert: () => ({ select: () => ({ single: () => mockInsertSingle() }) }),
    }),
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockUpload(...args),
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed/url' } }),
      }),
    },
  },
}));

jest.mock('../src/utils/imageCompression', () => ({
  compressImageForUpload: async (uri: string) => ({ uri }),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { photosApi } from '../src/api/supabase-photos';

const PHOTO_FOLDER = `${FileSystem.documentDirectory}photos/`;
const OWNED = `${PHOTO_FOLDER}copy-1.jpg`;
const CACHE = 'file:///cache/ImagePicker/a.jpg';
const deleteAsync = FileSystem.deleteAsync as jest.Mock;

beforeAll(() => {
  (FileSystem as any).readAsStringAsync = jest.fn(async () => 'AAAA');
  (FileSystem as any).EncodingType = { Base64: 'base64' };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockUpload.mockResolvedValue({ error: null });
  mockInsertSingle.mockResolvedValue({ data: { id: 9 }, error: null });
});

const upload = (localUri: string) => photosApi.uploadProjectPhoto(7, localUri, 'Barra 3', {
  clientEntryId: 'bar-1-photo-1',
});

it('deletes the local copy once the photo row is stored', async () => {
  await upload(OWNED);

  expect(deleteAsync).toHaveBeenCalledWith(OWNED, { idempotent: true });
});

it('keeps the local copy when the upload fails, so the retry can send it', async () => {
  mockUpload.mockResolvedValue({ error: { message: 'Network request failed' } });

  await expect(upload(OWNED)).rejects.toBeTruthy();
  expect(deleteAsync).not.toHaveBeenCalledWith(OWNED, expect.anything());
});

it('keeps the local copy when the metadata insert fails', async () => {
  mockInsertSingle.mockResolvedValue({ data: null, error: { code: '42501', message: 'nope' } });

  await expect(upload(OWNED)).rejects.toBeTruthy();
  expect(deleteAsync).not.toHaveBeenCalledWith(OWNED, expect.anything());
});

it('deletes the copy when an earlier attempt already stored the photo', async () => {
  mockMaybeSingle.mockResolvedValue({
    data: { id: 41, project_id: 7, shift_id: null, evidence_kind: 'field', caption: 'Barra 3', original_name: 'a.jpg' },
    error: null,
  });

  await upload(OWNED);

  expect(mockUpload).not.toHaveBeenCalled();
  expect(deleteAsync).toHaveBeenCalledWith(OWNED, { idempotent: true });
});

it('never deletes a picker cache file', async () => {
  await upload(CACHE);

  expect(deleteAsync).not.toHaveBeenCalled();
});
