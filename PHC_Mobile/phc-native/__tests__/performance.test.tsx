import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PhotoCapture from '../src/components/shared/PhotoCapture';
import { execute, query, resetConnection } from '../src/db/db';

const measure = async (work: () => void | Promise<void>) => {
  const start = performance.now();
  await work();
  return performance.now() - start;
};

describe('Performance smoke tests', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    await resetConnection();
  });

  test('PhotoCapture renders within a practical budget', async () => {
    // Warm up before measuring. The first render in the process also pays for
    // React's one-time setup and, on a cold Jest cache, the lazy transform of
    // the React Native module graph — 1148 ms against this 500 ms budget on a
    // clean checkout, which made this the only test in the suite that failed on
    // the first run and passed on every run afterwards. It would fail CI on any
    // fresh clone.
    //
    // The next test renders the same component in ~4 ms, so that startup cost is
    // not PhotoCapture's. Measuring warm asserts what this test actually claims:
    // that rendering PhotoCapture is not pathologically slow.
    const warmup = render(
      <PhotoCapture onPhotoTaken={jest.fn()} photos={[]} maxPhotos={5} />
    );
    warmup.unmount();

    const elapsed = await measure(async () => {
      render(
        <PhotoCapture
          onPhotoTaken={jest.fn()}
          photos={['file:///tmp/photo-1.jpg', 'file:///tmp/photo-2.jpg']}
          maxPhotos={5}
        />
      );
    });

    expect(elapsed).toBeLessThan(500);
  });

  test('PhotoCapture add action responds quickly', async () => {
    const { getByText } = render(
      <PhotoCapture
        onPhotoTaken={jest.fn()}
        photos={[]}
        maxPhotos={5}
      />
    );

    const elapsed = await measure(async () => {
      await act(async () => {
        fireEvent.press(getByText('+ Agregar'));
      });
    });

    expect(elapsed).toBeLessThan(200);
    expect(getByText('Agregar Foto')).toBeTruthy();
  });

  test('mocked database query and execute stay responsive', async () => {
    const elapsed = await measure(async () => {
      await query('SELECT * FROM projects WHERE deleted = 0');
      await execute('UPDATE projects SET updated_at = ? WHERE id = ?', [
        '2026-06-29T12:00:00.000Z',
        'project_1',
      ]);
    });

    expect(elapsed).toBeLessThan(500);
  });

  test('concurrent AsyncStorage writes stay responsive', async () => {
    const elapsed = await measure(async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          AsyncStorage.setItem(`perf-key-${index}`, `value-${index}`)
        )
      );
    });

    expect(elapsed).toBeLessThan(500);
  });
});
