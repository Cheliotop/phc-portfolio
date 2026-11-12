import * as FileSystem from 'expo-file-system/legacy';
import { createClientUuid } from './clientId';

/**
 * The image picker hands back files in the app's cache folder, and Android may
 * clear that folder while work waits offline. A captured photo is therefore
 * copied into the app's documents folder the moment it is taken, and that copy
 * is what a queued record keeps. The copy is removed only after the server has
 * confirmed the photo.
 */
const PHOTO_FOLDER = 'photos/';

const photoFolder = (): string | null =>
  FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${PHOTO_FOLDER}` : null;

/** True when the uri is a copy this module made, and so may delete. */
export const isPhotoCopy = (uri: string): boolean => {
  const folder = photoFolder();
  return folder !== null && uri.startsWith(folder);
};

/**
 * Copies a picked photo into the documents folder and returns the copy's uri.
 * If the copy cannot be made, the picker's uri comes back so the capture still
 * works; that photo is then exposed to cache clearing, which is logged.
 */
export const keepPhotoCopy = async (sourceUri: string): Promise<string> => {
  const folder = photoFolder();
  if (folder === null || isPhotoCopy(sourceUri)) return sourceUri;

  try {
    const existing = await FileSystem.getInfoAsync(folder);
    if (!existing.exists) {
      await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    }
    const target = `${folder}${createClientUuid()}.jpg`;
    await FileSystem.copyAsync({ from: sourceUri, to: target });
    return target;
  } catch (error) {
    console.warn('[PHC] No se pudo guardar una copia de la foto:', error);
    return sourceUri;
  }
};

/**
 * Deletes a copy made by keepPhotoCopy. Anything else (a picker cache file, a
 * storage path) is left alone. A failed delete only leaves a file behind.
 */
export const removePhotoCopy = async (uri: string): Promise<void> => {
  if (!isPhotoCopy(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn('[PHC] No se pudo borrar la copia de la foto:', error);
  }
};
