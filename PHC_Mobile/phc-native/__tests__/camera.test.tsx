import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import PhotoCapture from '../src/components/shared/PhotoCapture';

const mockShowSheet = jest.fn();
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: unknown[]) => mockShowSheet(...args),
  SheetHost: () => null,
}));


// Mock ImagePicker
jest.mock('expo-image-picker');

describe('PhotoCapture Component', () => {
  const mockOnPhotoTaken = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default successful responses
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted'
    });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/camera/photo.jpg' }]
    });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/gallery/photo.jpg' }]
    });
  });

  describe('Initial Render', () => {
    test('should display photo counter correctly', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      expect(getByText('Fotos (0/5)')).toBeTruthy();
      expect(getByText('+ Agregar')).toBeTruthy();
    });

    test('should show empty state when no photos', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      expect(getByText('Sin fotos agregadas')).toBeTruthy();
    });

    test('should display photos when provided', () => {
      const mockPhotos = [
        'mock://photo1.jpg',
        'mock://photo2.jpg'
      ];

      const { getByText, getAllByTestId } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={mockPhotos}
          maxPhotos={5}
        />
      );

      expect(getByText('Fotos (2/5)')).toBeTruthy();

      // Should display photo thumbnails
      const photoElements = getAllByTestId(/photo-\d+/);
      expect(photoElements).toHaveLength(2);
    });

    test('should use custom maxPhotos prop', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={3}
        />
      );

      expect(getByText('Fotos (0/3)')).toBeTruthy();
    });

    test('should default to 5 maxPhotos when not specified', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
        />
      );

      expect(getByText('Fotos (0/5)')).toBeTruthy();
    });
  });

  describe('Photo Addition Modal', () => {
    test('should open modal when add button pressed', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));

      expect(getByText('Agregar Foto')).toBeTruthy();
      expect(getByText('Tomar Foto')).toBeTruthy();
      expect(getByText('Seleccionar de Galería')).toBeTruthy();
      expect(getByText('Cancelar')).toBeTruthy();
    });

    test('should close modal when cancel pressed', () => {
      const { getByText, queryByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      // Open modal
      fireEvent.press(getByText('+ Agregar'));
      expect(getByText('Agregar Foto')).toBeTruthy();

      // Close modal
      fireEvent.press(getByText('Cancelar'));

      // Modal should be closed
      expect(queryByText('Agregar Foto')).toBeFalsy();
    });

    test('should prevent adding photos when limit reached', () => {
      const maxPhotos = 3;
      const fullPhotos = [
        'mock://photo1.jpg',
        'mock://photo2.jpg',
        'mock://photo3.jpg'
      ];

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={fullPhotos}
          maxPhotos={maxPhotos}
        />
      );

      fireEvent.press(getByText('+ Agregar'));

      expect(mockShowSheet).toHaveBeenCalledWith(
        'Límite alcanzado',
        'Máximo 3 fotos permitidas. Quitá una foto para agregar otra.',
        [{ text: 'Entendido' }]
      );
    });
  });

  describe('Camera Functionality', () => {
    test('should request camera permissions before taking photo', async () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(ImagePicker.requestCameraPermissionsAsync).toHaveBeenCalled();
      });
    });

    test('should handle camera permission denied', async () => {
      (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'denied'
      });

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(mockShowSheet).toHaveBeenCalledWith(
          'Permisos requeridos',
          'Se necesita acceso a la cámara para tomar fotos. Habilitá los permisos en la configuración de este dispositivo.',
          expect.any(Array)
        );
      });

      expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    });

    test('should launch camera with correct options', async () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith({
          mediaTypes: ['images'], // MediaTypeOptions is deprecated in expo-image-picker 16
          allowsEditing: true,
          aspect: [4, 3],
          quality: 0.8,
          exif: false,
        });
      });
    });

    test('should call onPhotoTaken when photo captured successfully', async () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(mockOnPhotoTaken).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/tmp\/photos\/.+\.jpg$/));
      });
    });

    test('should handle camera cancellation gracefully', async () => {
      (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
        canceled: true
      });

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(ImagePicker.launchCameraAsync).toHaveBeenCalled();
      });

      expect(mockOnPhotoTaken).not.toHaveBeenCalled();
    });

    test('should handle camera errors', async () => {
      const mockError = new Error('Camera not available');
      (ImagePicker.launchCameraAsync as jest.Mock).mockRejectedValue(mockError);

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(mockShowSheet).toHaveBeenCalledWith(
          'Error al tomar foto',
          'No se pudo capturar la foto. Intentá de nuevo; si sigue fallando, cerrá y abrí la app.',
          expect.any(Array)
        );
      });
    });

    test('should handle non-Error objects in camera catch block', async () => {
      (ImagePicker.launchCameraAsync as jest.Mock).mockRejectedValue('String error');

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(mockShowSheet).toHaveBeenCalledWith(
          'Error al tomar foto',
          'No se pudo capturar la foto. Intentá de nuevo; si sigue fallando, cerrá y abrí la app.',
          expect.any(Array)
        );
      });
    });
  });

  describe('Gallery Functionality', () => {
    test('should launch image library with correct options', async () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Seleccionar de Galería'));

      await waitFor(() => {
        expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
          mediaTypes: ['images'], // MediaTypeOptions is deprecated in expo-image-picker 16
          allowsEditing: true,
          aspect: [4, 3],
          quality: 0.8,
          exif: false,
        });
      });
    });

    test('should call onPhotoTaken when gallery photo selected', async () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Seleccionar de Galería'));

      await waitFor(() => {
        expect(mockOnPhotoTaken).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/tmp\/photos\/.+\.jpg$/));
      });
    });

    test('should handle gallery cancellation gracefully', async () => {
      (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
        canceled: true
      });

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Seleccionar de Galería'));

      await waitFor(() => {
        expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalled();
      });

      expect(mockOnPhotoTaken).not.toHaveBeenCalled();
    });

    test('should handle gallery errors', async () => {
      const mockError = new Error('Gallery access denied');
      (ImagePicker.launchImageLibraryAsync as jest.Mock).mockRejectedValue(mockError);

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Seleccionar de Galería'));

      await waitFor(() => {
        expect(mockShowSheet).toHaveBeenCalledWith(
          'Error al seleccionar foto',
          'No se pudo seleccionar la foto. Intentá de nuevo.',
          expect.any(Array)
        );
      });
    });
  });

  describe('Photo Display', () => {
    test('should display photo thumbnails with correct indices', () => {
      const mockPhotos = [
        'mock://photo1.jpg',
        'mock://photo2.jpg',
        'mock://photo3.jpg'
      ];

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={mockPhotos}
          maxPhotos={5}
        />
      );

      expect(getByText('1')).toBeTruthy(); // First photo index
      expect(getByText('2')).toBeTruthy(); // Second photo index
      expect(getByText('3')).toBeTruthy(); // Third photo index
    });

    test('should display correct photo count in header', () => {
      const mockPhotos = [
        'mock://photo1.jpg',
        'mock://photo2.jpg'
      ];

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={mockPhotos}
          maxPhotos={5}
        />
      );

      expect(getByText('Fotos (2/5)')).toBeTruthy();
    });

    test('should handle empty photo URI gracefully', () => {
      const mockPhotos = [
        'mock://photo1.jpg',
        '', // Empty URI
        'mock://photo3.jpg'
      ];

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={mockPhotos}
          maxPhotos={5}
        />
      );

      // Should still display all photos including empty one
      expect(getByText('Fotos (3/5)')).toBeTruthy();
      expect(getByText('1')).toBeTruthy();
      expect(getByText('2')).toBeTruthy();
      expect(getByText('3')).toBeTruthy();
    });
  });

  describe('Modal Behavior', () => {
    test('should close modal after taking photo', async () => {
      const { getByText, queryByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      // Open modal
      fireEvent.press(getByText('+ Agregar'));
      expect(getByText('Agregar Foto')).toBeTruthy();

      // Take photo
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(mockOnPhotoTaken).toHaveBeenCalled();
      });

      // Modal should be closed after photo taken
      expect(queryByText('Agregar Foto')).toBeFalsy();
    });

    test('should close modal after selecting from gallery', async () => {
      const { getByText, queryByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      // Open modal
      fireEvent.press(getByText('+ Agregar'));
      expect(getByText('Agregar Foto')).toBeTruthy();

      // Select from gallery
      fireEvent.press(getByText('Seleccionar de Galería'));

      await waitFor(() => {
        expect(mockOnPhotoTaken).toHaveBeenCalled();
      });

      // Modal should be closed after photo selected
      expect(queryByText('Agregar Foto')).toBeFalsy();
    });

    test('should handle modal close via onRequestClose', () => {
      const { getByText, getByTestId, queryByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      // Open modal
      fireEvent.press(getByText('+ Agregar'));

      // Simulate modal onRequestClose (hardware back button on Android)
      const modal = getByTestId('photo-modal');
      fireEvent(modal, 'onRequestClose');

      // Modal should be closed
      expect(queryByText('Agregar Foto')).toBeFalsy();
    });
  });

  describe('Performance Considerations', () => {
    test('should handle large number of photos efficiently', () => {
      const manyPhotos = Array.from({ length: 10 }, (_, i) => `mock://photo${i}.jpg`);

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={manyPhotos}
          maxPhotos={10}
        />
      );

      expect(getByText('Fotos (10/10)')).toBeTruthy();

      // Should render without performance issues
      expect(getByText('10')).toBeTruthy(); // Last photo index
    });

    test('should prevent memory leaks with proper cleanup', () => {
      const { unmount } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={['mock://photo.jpg']}
          maxPhotos={5}
        />
      );

      // Component should unmount without errors
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    test('should handle null or undefined photos array', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={null as any}
          maxPhotos={5}
        />
      );

      // Should not crash and show empty state
      expect(getByText('Sin fotos agregadas')).toBeTruthy();
    });

    test('should handle maxPhotos of 0', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={0}
        />
      );

      fireEvent.press(getByText('+ Agregar'));

      expect(mockShowSheet).toHaveBeenCalledWith(
        'Límite alcanzado',
        'Máximo 0 fotos permitidas. Quitá una foto para agregar otra.',
        [{ text: 'Entendido' }]
      );
    });

    test('should handle very large maxPhotos value', () => {
      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={1000}
        />
      );

      expect(getByText('Fotos (0/1000)')).toBeTruthy();
    });

    test('should handle missing assets in ImagePicker response', async () => {
      (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
        canceled: false,
        assets: [] // Empty assets array
      });

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(ImagePicker.launchCameraAsync).toHaveBeenCalled();
      });

      // Should not call onPhotoTaken if no assets
      expect(mockOnPhotoTaken).not.toHaveBeenCalled();
    });

    test('should handle malformed asset response', async () => {
      (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
        canceled: false,
        assets: [{ uri: null }] // Null URI
      });

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(ImagePicker.launchCameraAsync).toHaveBeenCalled();
      });

      expect(mockOnPhotoTaken).not.toHaveBeenCalled();
      expect(mockShowSheet).toHaveBeenCalledWith(
        'Error al tomar foto',
        'No se pudo capturar la foto. Intentá de nuevo; si sigue fallando, cerrá y abrí la app.',
        expect.any(Array)
      );
    });
  });

  describe('Console Logging', () => {
    test('should log errors for debugging', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const mockError = new Error('Test error');
      (ImagePicker.launchCameraAsync as jest.Mock).mockRejectedValue(mockError);

      const { getByText } = render(
        <PhotoCapture
          onPhotoTaken={mockOnPhotoTaken}
          photos={[]}
          maxPhotos={5}
        />
      );

      fireEvent.press(getByText('+ Agregar'));
      fireEvent.press(getByText('Tomar Foto'));

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('[PHC] Error taking photo:', mockError);
      });

      consoleErrorSpy.mockRestore();
    });
  });
});
