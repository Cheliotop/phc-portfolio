import supabase from '../lib/supabase';
import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { compressImageForUpload } from '../utils/imageCompression';
import { LocalPhotoMissingError } from './photoErrors';
import { removePhotoCopy } from '../utils/photoStorage';

const BUCKET_NAME = 'phc-photos';
// Free-tier Supabase Storage is a 1GB bucket shared across every project this
// client will ever run. Uncompressed camera photos (quality 0.8, no resize)
// run 1-4MB each, which would burn through that budget in a few hundred
// photos. Targeting ~250KB keeps images clearly legible for field/compliance
// review while buying roughly 10x the photo capacity out of the same 1GB.
const UPLOAD_TARGET_KB = 250;

// The upload is always the compressed JPEG, but the name keeps the camera's
// basename so a replay finds the object an earlier attempt stored. Only a name
// the storage policy would refuse (HEIC, GIF, no extension) is rewritten.
const uploadFileName = (localUri: string): string => {
  const base = localUri.split('/').pop() || 'photo.jpg';
  return /\.(jpe?g|png|webp)$/i.test(base) ? base : `${base.replace(/\.[^.]*$/, '')}.jpg`;
};

const assertMatchingReplay = (
  photo: any,
  expected: {
    projectId: number;
    shiftId?: string;
    evidenceKind: 'field' | 'water_sample';
    caption?: string;
  },
) => {
  if (
    photo.project_id !== expected.projectId
    || (photo.shift_id ?? null) !== (expected.shiftId ?? null)
    || photo.evidence_kind !== expected.evidenceKind
    || (photo.caption ?? null) !== (expected.caption ?? null)
  ) {
    throw new Error('La clave de foto ya existe con evidencia diferente.');
  }
};

export const photosApi = {
  async uploadProjectPhoto(
    projectId: number,
    localUri: string,
    caption?: string,
    options: {
      clientEntryId?: string;
      shiftId?: string;
      evidenceKind?: 'field' | 'water_sample';
    } = {},
  ): Promise<{ photo: any; message?: string }> {
    const stableId = (options.clientEntryId || String(Date.now())).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${projectId}/${stableId}_${uploadFileName(localUri)}`;

    // A response can be lost after both Storage and the metadata insert
    // succeed. Resolve that replay before uploading so one client key never
    // creates duplicate evidence rows.
    const { data: existing, error: lookupError } = await supabase
      .from('photos')
      .select('*')
      .eq('storage_path', fileName)
      .maybeSingle();

    // Android may clear the cache folder that holds camera pictures while work
    // waits offline. Retrying can't bring the file back, but only call it gone
    // once the server has said no earlier attempt stored it.
    if (!existing && localUri.startsWith('file://')
        && !(await FileSystem.getInfoAsync(localUri)).exists) {
      if (lookupError) throw lookupError;
      throw new LocalPhotoMissingError(localUri);
    }

    if (existing) {
      assertMatchingReplay(existing, {
        projectId,
        shiftId: options.shiftId,
        evidenceKind: options.evidenceKind ?? 'field',
        caption,
      });
      const { data: existingUrl } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(fileName, 60 * 60);
      await removePhotoCopy(localUri);
      return {
        photo: {
          id: existing.id,
          url: existingUrl?.signedUrl,
          filename: fileName,
          original_name: existing.original_name,
        },
        message: 'Foto ya sincronizada',
      };
    }

    const compressed = await compressImageForUpload(localUri, UPLOAD_TARGET_KB);
    const uploadUri = compressed.uri;

    const fileInfo = await FileSystem.getInfoAsync(uploadUri);
    if (!fileInfo.exists) {
      throw new Error('File not found');
    }

    const fileContent = await FileSystem.readAsStringAsync(uploadUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const arrayBuffer = decode(fileContent);

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, arrayBuffer, {
        contentType: 'image/jpeg',
        upsert: false,
      });

    if (error && !/already exists|duplicate/i.test(error.message || '')) {
      console.warn('[PHC] Storage upload failed:', fileName, JSON.stringify(error));
      throw error;
    }

    // The bucket is private (correctly — these are client field-site photos),
    // so getPublicUrl() would return a URL that 403s when fetched. Use a
    // time-limited signed URL instead; re-sign later via getSignedUrl()
    // rather than caching this one indefinitely.
    const { data: urlData } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(fileName, 60 * 60); // 1 hour

    const photoRecord = {
      storage_path: fileName,
      filename: fileName,
      original_name: localUri.split('/').pop() || 'photo.jpg',
      file_size: fileInfo.size || 0,
      mime_type: 'image/jpeg',
      project_id: projectId,
      shift_id: options.shiftId ?? null,
      evidence_kind: options.evidenceKind ?? 'field',
      caption: caption ?? null,
    };

    const { data: photo, error: dbError } = await supabase
      .from('photos')
      .insert(photoRecord)
      .select()
      .single();

    if (dbError) {
      if (!/duplicate|unique|23505/i.test(`${dbError.code || ''} ${dbError.message || ''}`)) {
        throw dbError;
      }
      // A second local sync worker may win the metadata race after both saw
      // no row. The database path is unique; bind the winner's immutable row
      // to this exact evidence payload instead of inserting a duplicate.
      const { data: racedPhoto, error: racedError } = await supabase
        .from('photos')
        .select('*')
        .eq('storage_path', fileName)
        .single();
      if (racedError || !racedPhoto) throw dbError;
      assertMatchingReplay(racedPhoto, {
        projectId,
        shiftId: options.shiftId,
        evidenceKind: options.evidenceKind ?? 'field',
        caption,
      });
      await removePhotoCopy(localUri);
      return {
        photo: {
          id: racedPhoto.id,
          url: urlData?.signedUrl,
          filename: fileName,
          original_name: racedPhoto.original_name,
        },
        message: 'Foto ya sincronizada',
      };
    }

    // The server has the photo row now, so the local copy is no longer needed.
    // A failure above keeps the copy, because the next attempt still uploads it.
    await removePhotoCopy(localUri);
    return {
      photo: {
        id: photo.id,
        url: urlData?.signedUrl,
        filename: fileName,
        original_name: localUri.split('/').pop() || 'photo.jpg',
      },
    };
  },

  /**
   * Every photo on a well, newest first, with the name of whoever took it.
   *
   * Until this existed, nothing on the admin side listed a photo at all — an
   * operator could document a shift and the office had no way to look at the
   * result, which is indistinguishable from the upload having failed.
   *
   * Pages of 30 (`offset`/`limit`): a well with 100+ full-size photos must not
   * download all of them at once on mobile data.
   *
   * Storage paths are returned rather than URLs on purpose: a signed URL lasts
   * an hour, so the caller signs each one when it is actually about to be
   * shown. Signing them here would hand out links that expire while the
   * gallery is still open.
   */
  async listProjectPhotos(projectId: number, options: { offset?: number; limit?: number } = {}) {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 30);
    const { data, error } = await supabase
      .from('photos')
      .select(
        'id, storage_path, caption, created_at, evidence_kind, shift_id,'
        + ' uploaded_by, profiles!photos_uploaded_by_fkey(username, full_name)',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
  },

  /**
   * Sign many paths in one request, for a gallery.
   *
   * Signing them one at a time is a round trip per photo, which on a phone on
   * mobile data is the difference between a gallery that opens and one that
   * looks broken. Returns a path -> URL map; a path that fails to sign is
   * simply absent, so one unreadable photo cannot blank the whole screen.
   */
  async getSignedUrls(
    storagePaths: string[],
    expiresInSeconds = 60 * 60,
  ): Promise<Record<string, string>> {
    if (!storagePaths.length) return {};
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrls(storagePaths, expiresInSeconds);
    if (error) throw error;

    const urls: Record<string, string> = {};
    for (const entry of data || []) {
      // `path` echoes the input; `error` is per-item and non-fatal.
      if (entry?.path && entry.signedUrl && !entry.error) {
        urls[entry.path] = entry.signedUrl;
      }
    }
    return urls;
  },

  // Re-sign a stored photo's URL. Signed URLs expire (1 hour above), so any
  // screen that lists photos fetched on a previous session (e.g. admin
  // reviewing older project photos) should call this rather than reuse a
  // stale signed URL from the `photos` table.
  async getSignedUrl(storagePath: string, expiresInSeconds = 60 * 60) {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw error;
    return data?.signedUrl;
  },
};
