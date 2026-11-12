/**
 * A captured photo is copied out of the picker's cache folder at capture time, so
 * Android clearing the cache cannot take an offline bar's photo with it. Only the
 * copies this module made may be deleted.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { isPhotoCopy, keepPhotoCopy, removePhotoCopy } from '../src/utils/photoStorage';

const copyAsync = FileSystem.copyAsync as jest.Mock;
const deleteAsync = FileSystem.deleteAsync as jest.Mock;
const getInfoAsync = FileSystem.getInfoAsync as jest.Mock;
const makeDirectoryAsync = FileSystem.makeDirectoryAsync as jest.Mock;
const PHOTO_FOLDER = `${FileSystem.documentDirectory}photos/`;

beforeEach(() => {
  jest.clearAllMocks();
  getInfoAsync.mockResolvedValue({ exists: true });
});

describe('keepPhotoCopy', () => {
  it('copies a picker file into the documents folder and returns the copy', async () => {
    const copy = await keepPhotoCopy('file:///cache/ImagePicker/a.jpg');

    expect(copy.startsWith(PHOTO_FOLDER)).toBe(true);
    expect(copy).toMatch(/\.jpg$/);
    expect(copy).not.toBe('file:///cache/ImagePicker/a.jpg');
    expect(copyAsync).toHaveBeenCalledWith({ from: 'file:///cache/ImagePicker/a.jpg', to: copy });
  });

  it('gives every capture its own file name', async () => {
    const first = await keepPhotoCopy('file:///cache/ImagePicker/a.jpg');
    const second = await keepPhotoCopy('file:///cache/ImagePicker/a.jpg');

    expect(first).not.toBe(second);
  });

  it('creates the folder the first time, when it is missing', async () => {
    getInfoAsync.mockResolvedValue({ exists: false });

    await keepPhotoCopy('file:///cache/ImagePicker/a.jpg');

    expect(makeDirectoryAsync).toHaveBeenCalledWith(PHOTO_FOLDER, { intermediates: true });
  });

  it('falls back to the picker uri when the copy fails, so the capture still works', async () => {
    copyAsync.mockRejectedValueOnce(new Error('disk full'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(keepPhotoCopy('file:///cache/ImagePicker/a.jpg'))
      .resolves.toBe('file:///cache/ImagePicker/a.jpg');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not copy a file that is already a copy', async () => {
    const existing = `${PHOTO_FOLDER}abc.jpg`;

    await expect(keepPhotoCopy(existing)).resolves.toBe(existing);
    expect(copyAsync).not.toHaveBeenCalled();
  });
});

describe('removePhotoCopy', () => {
  it('deletes a copy this module made', async () => {
    const copy = `${PHOTO_FOLDER}abc.jpg`;

    await removePhotoCopy(copy);

    expect(deleteAsync).toHaveBeenCalledWith(copy, { idempotent: true });
  });

  it('never deletes a picker cache file', async () => {
    await removePhotoCopy('file:///cache/ImagePicker/a.jpg');
    await removePhotoCopy('content://media/external/images/1');

    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('swallows a failed delete, since a leftover file is harmless', async () => {
    deleteAsync.mockRejectedValueOnce(new Error('busy'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(removePhotoCopy(`${PHOTO_FOLDER}abc.jpg`)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

it('recognises only uris inside the copy folder', () => {
  expect(isPhotoCopy(`${PHOTO_FOLDER}abc.jpg`)).toBe(true);
  expect(isPhotoCopy('file:///cache/ImagePicker/a.jpg')).toBe(false);
});
