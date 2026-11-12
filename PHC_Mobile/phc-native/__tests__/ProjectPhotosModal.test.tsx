/**
 * Before this component existed, nothing on the admin side displayed a photo.
 * An operator could document a shift, the upload would succeed, the row would
 * be written — and the office had no way to look at it, which from the outside
 * is indistinguishable from the upload having failed.
 *
 * The two cases that matter most here are the unhappy ones: a well with no
 * photos yet must not look like an error, and a photo whose file cannot be
 * signed must still be listed rather than silently dropped. "This photo is
 * missing" is information; a shorter grid is not.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockListProjectPhotos = jest.fn();
const mockGetSignedUrls = jest.fn();

jest.mock('../src/api/supabase-photos', () => ({
  photosApi: {
    listProjectPhotos: (...a: unknown[]) => mockListProjectPhotos(...a),
    getSignedUrls: (...a: unknown[]) => mockGetSignedUrls(...a),
  },
}));

import ProjectPhotosModal from '../src/components/admin/ProjectPhotosModal';

const photo = (over: Record<string, unknown> = {}) => ({
  id: 1,
  storage_path: '7/abc_photo.jpg',
  caption: 'Cambio de terreno a 42m',
  created_at: '2026-07-31T14:05:00Z',
  evidence_kind: 'field',
  uploaded_by: 'op-1',
  profiles: { username: 'juan', full_name: 'Juan Duarte' },
  ...over,
});

describe('ProjectPhotosModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListProjectPhotos.mockResolvedValue([]);
    mockGetSignedUrls.mockResolvedValue({});
  });

  it('shows the photo with who took it and when', async () => {
    mockListProjectPhotos.mockResolvedValue([photo()]);
    mockGetSignedUrls.mockResolvedValue({ '7/abc_photo.jpg': 'https://signed/one' });

    const view = render(
      <ProjectPhotosModal visible projectId={7} projectName="Pozo San Isidro" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(view.getByText('Juan Duarte')).toBeTruthy());
    expect(view.getByText('Pozo San Isidro')).toBeTruthy();
    // Dates go through formatDisplayDateTime, never the locale formatter.
    expect(view.getByText(/31\/07\/2026/)).toBeTruthy();
    expect(view.getByText('Avance')).toBeTruthy();
  });

  it('signs every path in one request rather than one per photo', async () => {
    // A round trip per photo is the difference, on mobile data at a well,
    // between a gallery that opens and one that looks broken.
    mockListProjectPhotos.mockResolvedValue([
      photo({ id: 1, storage_path: 'a.jpg' }),
      photo({ id: 2, storage_path: 'b.jpg' }),
      photo({ id: 3, storage_path: 'c.jpg' }),
    ]);

    render(<ProjectPhotosModal visible projectId={7} projectName="Pozo" onClose={jest.fn()} />);

    await waitFor(() => expect(mockGetSignedUrls).toHaveBeenCalledTimes(1));
    expect(mockGetSignedUrls).toHaveBeenCalledWith(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('still lists a photo whose file could not be signed', async () => {
    mockListProjectPhotos.mockResolvedValue([photo()]);
    mockGetSignedUrls.mockResolvedValue({}); // signing failed for this one

    const view = render(
      <ProjectPhotosModal visible projectId={7} projectName="Pozo" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(view.getByText('No disponible')).toBeTruthy());
    expect(view.getByText('Juan Duarte')).toBeTruthy();
  });

  it('says a well has no photos yet instead of looking broken', async () => {
    const view = render(
      <ProjectPhotosModal visible projectId={7} projectName="Pozo" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(view.getByText('Todavía no hay fotos en este pozo.')).toBeTruthy());
    // And says where they come from, so the admin knows nothing is missing.
    expect(view.getByText(/Progreso o Muestras/)).toBeTruthy();
  });

  it('offers a retry when loading fails', async () => {
    mockListProjectPhotos.mockRejectedValue(new Error('network'));

    const view = render(
      <ProjectPhotosModal visible projectId={7} projectName="Pozo" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(view.getByText('Reintentar')).toBeTruthy());
  });

  it('fetches nothing until it is opened', async () => {
    render(<ProjectPhotosModal visible={false} projectId={7} projectName="Pozo" onClose={jest.fn()} />);
    await waitFor(() => expect(mockListProjectPhotos).not.toHaveBeenCalled());
  });

  it('loads 30 photos at a time and adds the next page with "Cargar más"', async () => {
    const all = Array.from({ length: 35 }, (_, index) => photo({
      id: index + 1,
      storage_path: `p${index + 1}.jpg`,
      caption: null,
    }));
    mockListProjectPhotos.mockImplementation(async (_id: number, options: { offset: number; limit: number }) =>
      all.slice(options.offset, options.offset + options.limit));
    mockGetSignedUrls.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((path) => [path, `https://signed/${path}`])));

    const view = render(<ProjectPhotosModal visible projectId={7} projectName="Pozo" onClose={jest.fn()} />);

    await waitFor(() => expect(view.getAllByLabelText('Foto del pozo')).toHaveLength(30));
    expect(mockListProjectPhotos).toHaveBeenCalledWith(7, { offset: 0, limit: 30 });

    fireEvent.press(view.getByText('Cargar más'));
    // A short last page (5 < 30) removes the button: that is the signal the page landed.
    await waitFor(() => expect(view.queryByText('Cargar más')).toBeNull());
    expect(mockListProjectPhotos).toHaveBeenLastCalledWith(7, { offset: 30, limit: 30 });
    expect(view.getAllByLabelText('Foto del pozo')).toHaveLength(35);
  });

  it('ignores a late reply for the well that was open before', async () => {
    let resolveOld: (rows: unknown[]) => void = () => {};
    mockListProjectPhotos.mockImplementation((projectId: number) => {
      if (projectId === 7) {
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve([photo({ id: 99, storage_path: 'new.jpg', profiles: { full_name: 'Nueva Pozo 8' } })]);
    });
    mockGetSignedUrls.mockResolvedValue({});

    const view = render(<ProjectPhotosModal visible projectId={7} projectName="Pozo 7" onClose={jest.fn()} />);
    view.rerender(<ProjectPhotosModal visible projectId={8} projectName="Pozo 8" onClose={jest.fn()} />);
    await waitFor(() => expect(view.getByText('Nueva Pozo 8')).toBeTruthy());

    // The reply for well 7 arrives last. It must not replace well 8's photos.
    resolveOld([photo({ id: 1, storage_path: 'old.jpg', profiles: { full_name: 'Vieja Pozo 7' } })]);
    // The late reply signs its own photos only after its list arrives: wait for that call.
    await waitFor(() => expect(mockGetSignedUrls).toHaveBeenCalledTimes(2));
    expect(view.queryByText('Vieja Pozo 7')).toBeNull();
    expect(view.getByText('Nueva Pozo 8')).toBeTruthy();
  });
});
