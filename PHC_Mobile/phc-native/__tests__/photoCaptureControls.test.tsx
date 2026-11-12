/**
 * Photo capture on the operator screens: the picked photo is kept on the device,
 * photos can be previewed and removed one by one, and a camera permission that
 * can still be asked for is asked for again from the sheet.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import PhotoCapture from '../src/components/shared/PhotoCapture';

const mockShowSheet = jest.fn();
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: unknown[]) => mockShowSheet(...args),
  SheetHost: () => null,
}));

jest.mock('expo-image-picker');

const PHOTO_FOLDER = `${FileSystem.documentDirectory}photos/`;

const lastSheet = () => mockShowSheet.mock.calls[mockShowSheet.mock.calls.length - 1];
const sheetButton = (text: string) =>
  (lastSheet()[2] as Array<{ text: string; onPress?: () => void }>).find((b) => b.text === text);

beforeEach(() => {
  jest.clearAllMocks();
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: true });
  (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///cache/ImagePicker/new.jpg' }],
  });
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///cache/gallery/new.jpg' }],
  });
});

describe('keeping the picked photo', () => {
  it('hands the parent a copy in the documents folder, not the picker cache file', async () => {
    const onPhotoTaken = jest.fn();
    const { getByText } = render(<PhotoCapture onPhotoTaken={onPhotoTaken} photos={[]} />);

    fireEvent.press(getByText('+ Agregar'));
    fireEvent.press(getByText('Tomar Foto'));

    await waitFor(() => expect(onPhotoTaken).toHaveBeenCalledTimes(1));
    const uri: string = onPhotoTaken.mock.calls[0][0];
    expect(uri.startsWith(PHOTO_FOLDER)).toBe(true);
    expect(FileSystem.copyAsync).toHaveBeenCalledWith({ from: 'file:///cache/ImagePicker/new.jpg', to: uri });
  });

  it('keeps gallery photos the same way', async () => {
    const onPhotoTaken = jest.fn();
    const { getByText } = render(<PhotoCapture onPhotoTaken={onPhotoTaken} photos={[]} />);

    fireEvent.press(getByText('+ Agregar'));
    fireEvent.press(getByText('Seleccionar de Galería'));

    await waitFor(() => expect(onPhotoTaken).toHaveBeenCalledTimes(1));
    expect(onPhotoTaken.mock.calls[0][0].startsWith(PHOTO_FOLDER)).toBe(true);
  });

  it('no longer shows a success sheet after each photo', async () => {
    const { getByText } = render(<PhotoCapture onPhotoTaken={jest.fn()} photos={[]} />);

    fireEvent.press(getByText('+ Agregar'));
    fireEvent.press(getByText('Tomar Foto'));

    await waitFor(() => expect(ImagePicker.launchCameraAsync).toHaveBeenCalled());
    await waitFor(() => expect(FileSystem.copyAsync).toHaveBeenCalled());
    expect(mockShowSheet).not.toHaveBeenCalledWith('Éxito', expect.anything(), expect.anything());
  });
});

describe('removing and previewing photos', () => {
  const photos = ['file:///documents/photos/a.jpg', 'file:///documents/photos/b.jpg'];

  it('shows no remove control when the parent cannot remove photos', () => {
    const { queryByLabelText } = render(<PhotoCapture onPhotoTaken={jest.fn()} photos={photos} />);

    expect(queryByLabelText('Quitar foto 1')).toBeNull();
  });

  it('asks before removing a photo, and removes only the one chosen', () => {
    const onPhotoRemoved = jest.fn();
    const { getByLabelText } = render(
      <PhotoCapture onPhotoTaken={jest.fn()} onPhotoRemoved={onPhotoRemoved} photos={photos} />,
    );

    fireEvent.press(getByLabelText('Quitar foto 2'));

    expect(onPhotoRemoved).not.toHaveBeenCalled();
    expect(mockShowSheet).toHaveBeenCalledWith(
      'Quitar foto',
      expect.stringContaining('la foto 2'),
      expect.any(Array),
    );

    sheetButton('Quitar')!.onPress!();
    expect(onPhotoRemoved).toHaveBeenCalledWith('file:///documents/photos/b.jpg');
  });

  it('leaves the photo in place when the operator cancels the removal', () => {
    const onPhotoRemoved = jest.fn();
    const { getByLabelText } = render(
      <PhotoCapture onPhotoTaken={jest.fn()} onPhotoRemoved={onPhotoRemoved} photos={photos} />,
    );

    fireEvent.press(getByLabelText('Quitar foto 1'));

    expect(sheetButton('Cancelar')).toBeTruthy();
    expect(onPhotoRemoved).not.toHaveBeenCalled();
  });

  it('opens a full preview when a thumbnail is tapped', () => {
    const { getByLabelText, getByText } = render(
      <PhotoCapture onPhotoTaken={jest.fn()} onPhotoRemoved={jest.fn()} photos={photos} />,
    );

    fireEvent.press(getByLabelText('Ver foto 2'));

    expect(getByText('Foto 2 de 2')).toBeTruthy();
  });
});

describe('camera permission', () => {
  it('offers "Intentar de nuevo" that opens the camera when the permission can still be asked', async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock)
      .mockResolvedValueOnce({ status: 'denied', canAskAgain: true })
      .mockResolvedValue({ status: 'granted', canAskAgain: true });
    const { getByText } = render(<PhotoCapture onPhotoTaken={jest.fn()} photos={[]} />);

    fireEvent.press(getByText('+ Agregar'));
    fireEvent.press(getByText('Tomar Foto'));

    await waitFor(() => expect(sheetButton('Intentar de nuevo')).toBeTruthy());
    sheetButton('Intentar de nuevo')!.onPress!();

    await waitFor(() => expect(ImagePicker.launchCameraAsync).toHaveBeenCalled());
  });

  it('sends a permanent denial to the phone settings instead of asking again', async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied', canAskAgain: false });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as any);
    const { getByText } = render(<PhotoCapture onPhotoTaken={jest.fn()} photos={[]} />);

    fireEvent.press(getByText('+ Agregar'));
    fireEvent.press(getByText('Tomar Foto'));

    await waitFor(() => expect(sheetButton('Abrir configuración')).toBeTruthy());
    expect(sheetButton('Intentar de nuevo')).toBeUndefined();

    sheetButton('Abrir configuración')!.onPress!();
    expect(openSettings).toHaveBeenCalled();
    openSettings.mockRestore();
  });
});
