import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Modal,
  ActivityIndicator,
  Linking,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { showSheet } from './Sheet';
import { keepPhotoCopy, removePhotoCopy } from '../../utils/photoStorage';

interface PhotoCaptureProps {
  /** Receives the uri of a copy kept on the device, not the picker's cache file. */
  onPhotoTaken: (uri: string) => void;
  /**
   * Called after the operator confirms removing a photo. Without it, the
   * remove control is not shown.
   */
  onPhotoRemoved?: (uri: string) => void;
  photos: string[];
  maxPhotos?: number;
}

const PhotoOption = ({ title, onPress, icon }: { title: string; onPress: () => void; icon: string }) => (
  <TouchableOpacity style={styles.optionButton} onPress={onPress}>
    <Text style={styles.optionIcon}>{icon}</Text>
    <Text style={styles.optionText}>{title}</Text>
  </TouchableOpacity>
);

const PhotoCapture: React.FC<PhotoCaptureProps> = ({
  onPhotoTaken,
  onPhotoRemoved,
  photos,
  maxPhotos = 5
}) => {
  const [modalVisible, setModalVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentOperation, setCurrentOperation] = useState<'camera' | 'gallery' | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const safePhotos = Array.isArray(photos) ? photos : [];
  const previewUri = previewIndex !== null ? safePhotos[previewIndex] : undefined;

  const showDeniedSheet = (canAskAgain: boolean) => {
    const message = 'Se necesita acceso a la cámara para tomar fotos. Habilitá los permisos en la configuración de este dispositivo.';
    if (canAskAgain) {
      showSheet('Permisos requeridos', message, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Intentar de nuevo',
          // The retry asks for the camera itself, so a granted permission opens it.
          onPress: () => {
            setTimeout(() => takePhoto(), 300);
          }
        }
      ]);
      return;
    }
    // The system will not ask again after a permanent denial, so the only way
    // forward is the phone's settings.
    showSheet('Permisos requeridos', message, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Abrir configuración',
        onPress: () => {
          Linking.openSettings().catch((error) => {
            console.error('[PHC] No se pudo abrir la configuración:', error);
          });
        }
      }
    ]);
  };

  const requestPermissions = async (): Promise<boolean> => {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { status, canAskAgain } = await ImagePicker.requestCameraPermissionsAsync();

        if (status === 'granted') {
          return true;
        } else {
          showDeniedSheet(canAskAgain !== false);
          return false;
        }
      } catch (error) {
        console.error(`[PHC] Error requesting camera permission (attempt ${attempt}):`, error);

        if (attempt === MAX_RETRIES) {
          showSheet(
            'Error de permisos',
            'No se pudo solicitar permisos de cámara. Revisá la configuración de este dispositivo.'
          );
          return false;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }

    return false;
  };

  const takePhoto = async () => {

    if (isLoading) {
      return;
    }

    setIsLoading(true);
    setCurrentOperation('camera');
    setModalVisible(false);

    try {
      const hasPermission = await requestPermissions();
      if (!hasPermission) {
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        // MediaTypeOptions is deprecated in expo-image-picker 16; the supported
        // form is an array of MediaType ('images' | 'videos' | 'livePhotos').
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
        exif: false, // Reduce data size
      });


      if (!result.canceled && result.assets && result.assets[0]) {
        const photoUri = result.assets[0].uri;

        // Validate photo URI
        if (!photoUri || !photoUri.startsWith('file://') && !photoUri.startsWith('content://')) {
          throw new Error('Invalid photo URI received');
        }

        onPhotoTaken(await keepPhotoCopy(photoUri));
      }
    } catch (error: any) {
      console.error('[PHC] Error taking photo:', error);

      // The camera's own message is English and technical; it stays in the log.
      showSheet(
        'Error al tomar foto',
        'No se pudo capturar la foto. Intentá de nuevo; si sigue fallando, cerrá y abrí la app.',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Intentar de nuevo',
            onPress: () => {
              setTimeout(() => takePhoto(), 500);
            }
          }
        ]
      );
    } finally {
      setIsLoading(false);
      setCurrentOperation(null);
    }
  };

  const pickFromGallery = async () => {

    if (isLoading) {
      return;
    }

    setIsLoading(true);
    setCurrentOperation('gallery');
    setModalVisible(false);

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        // MediaTypeOptions is deprecated in expo-image-picker 16; the supported
        // form is an array of MediaType ('images' | 'videos' | 'livePhotos').
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
        exif: false, // Reduce data size
      });


      if (!result.canceled && result.assets && result.assets[0]) {
        const photoUri = result.assets[0].uri;

        // Validate photo URI
        if (!photoUri || !photoUri.startsWith('file://') && !photoUri.startsWith('content://')) {
          throw new Error('Invalid photo URI received from gallery');
        }

        onPhotoTaken(await keepPhotoCopy(photoUri));
      }
    } catch (error: any) {
      console.error('[PHC] Error picking photo from gallery:', error);


      showSheet(
        'Error al seleccionar foto',
        'No se pudo seleccionar la foto. Intentá de nuevo.',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Intentar de nuevo',
            onPress: () => {
              setTimeout(() => pickFromGallery(), 500);
            }
          }
        ]
      );
    } finally {
      setIsLoading(false);
      setCurrentOperation(null);
    }
  };

  const handleAddPhoto = () => {
    if (isLoading) {
      return;
    }

    if (safePhotos.length >= maxPhotos) {
      showSheet(
        'Límite alcanzado',
        `Máximo ${maxPhotos} fotos permitidas. Quitá una foto para agregar otra.`,
        [{ text: 'Entendido' }]
      );
      return;
    }

    setModalVisible(true);
  };

  const askRemovePhoto = (index: number) => {
    const uri = safePhotos[index];
    if (!uri || !onPhotoRemoved) {
      return;
    }
    showSheet(
      'Quitar foto',
      `Se va a quitar la foto ${index + 1}. Si la quitás, no se guarda con este registro.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Quitar',
          style: 'destructive',
          onPress: () => {
            onPhotoRemoved(uri);
            void removePhotoCopy(uri);
          }
        }
      ]
    );
  };

  // The preview closes before the confirmation opens, so the sheet is not hidden behind it.
  const removeFromPreview = (index: number) => {
    setPreviewIndex(null);
    setTimeout(() => askRemovePhoto(index), 350);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Fotos ({safePhotos.length}/{maxPhotos})</Text>
        <TouchableOpacity style={styles.addButton} onPress={handleAddPhoto}>
          <Text style={styles.addButtonText}>+ Agregar</Text>
        </TouchableOpacity>
      </View>

      {safePhotos.length > 0 && (
        <View style={styles.photosContainer}>
          {safePhotos.map((uri, index) => (
            <View key={`${index}-${uri}`} style={styles.photoWrapper} testID={`photo-${index + 1}`}>
              <TouchableOpacity
                accessibilityRole="imagebutton"
                accessibilityLabel={`Ver foto ${index + 1}`}
                onPress={() => setPreviewIndex(index)}
              >
                <Image source={{ uri }} style={styles.photo} />
              </TouchableOpacity>
              <Text style={styles.photoIndex}>{index + 1}</Text>
              {onPhotoRemoved && (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Quitar foto ${index + 1}`}
                  style={styles.photoRemove}
                  onPress={() => askRemovePhoto(index)}
                >
                  <Text style={styles.photoRemoveText}>✕</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      )}

      {safePhotos.length === 0 && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}></Text>
          <Text style={styles.emptyText}>Sin fotos agregadas</Text>
        </View>
      )}

      <Modal
        testID="photo-preview-modal"
        visible={previewUri !== undefined}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewIndex(null)}
      >
        <View style={styles.previewOverlay}>
          {previewUri !== undefined && previewIndex !== null && (
            <>
              <Image
                source={{ uri: previewUri }}
                style={styles.previewImage}
                resizeMode="contain"
                accessibilityLabel={`Foto ${previewIndex + 1}`}
              />
              <Text style={styles.previewCaption}>
                Foto {previewIndex + 1} de {safePhotos.length}
              </Text>
              <View style={styles.previewActions}>
                {onPhotoRemoved && (
                  <TouchableOpacity
                    style={[styles.previewButton, styles.previewDanger]}
                    onPress={() => removeFromPreview(previewIndex)}
                  >
                    <Text style={styles.previewButtonText}>Quitar foto</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.previewButton}
                  onPress={() => setPreviewIndex(null)}
                >
                  <Text style={styles.previewButtonText}>Cerrar</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </Modal>

      <Modal
        testID="photo-modal"
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Agregar Foto</Text>

            <PhotoOption
              title="Tomar Foto"
              icon=""
              onPress={() => {
                setModalVisible(false);
                takePhoto();
              }}
            />

            <PhotoOption
              title="Seleccionar de Galería"
              icon=""
              onPress={() => {
                setModalVisible(false);
                pickFromGallery();
              }}
            />

            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.cancelText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Loading Overlay */}
      {isLoading && (
        <Modal
          visible={isLoading}
          transparent
          animationType="fade"
          onRequestClose={() => {}}
        >
          <View style={styles.loadingOverlay}>
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={COLORS.primary} />
              <Text style={styles.loadingText}>
                {currentOperation === 'camera'
                  ? 'Abriendo cámara...'
                  : currentOperation === 'gallery'
                  ? 'Abriendo galería...'
                  : 'Procesando...'}
              </Text>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: SPACING.xl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  label: {
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  addButton: { minHeight: 48, justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
  },
  addButtonText: {
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
  },
  photosContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  photoWrapper: {
    position: 'relative',
  },
  photo: {
    width: 80,
    height: 80,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
  },
  photoIndex: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: COLORS.text,
    fontSize: TYPE.caption,
    fontWeight: 'bold',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.sm,
  },
  photoRemove: {
    position: 'absolute',
    top: -12,
    right: -12,
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoRemoveText: {
    backgroundColor: COLORS.danger,
    color: COLORS.text,
    fontSize: TYPE.label,
    fontWeight: 'bold',
    width: 26,
    height: 26,
    lineHeight: 26,
    textAlign: 'center',
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
  },
  previewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  previewImage: {
    width: '100%',
    flex: 1,
  },
  previewCaption: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    marginVertical: SPACING.md,
  },
  previewActions: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: SPACING.lg,
  },
  previewButton: {
    minHeight: 48,
    minWidth: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.neutral,
  },
  previewDanger: {
    backgroundColor: COLORS.danger,
  },
  previewButtonText: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
  },
  emptyState: {
    alignItems: 'center',
    padding: SPACING.xl,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
  },
  emptyIcon: {
    fontSize: TYPE.display,
    marginBottom: SPACING.sm,
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  modalContent: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.xxl,
  },
  modalTitle: {
    fontSize: TYPE.h2,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.xl,
    textAlign: 'center',
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    padding: SPACING.lg,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  optionIcon: {
    fontSize: TYPE.h1,
    marginRight: SPACING.lg,
  },
  optionText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.text,
    fontWeight: '500',
  },
  cancelButton: {
    backgroundColor: COLORS.neutral,
    padding: SPACING.lg,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  cancelText: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
  },
  loadingOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.xxl,
    alignItems: 'center',
    minWidth: 200,
  },
  loadingText: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    marginTop: SPACING.md,
    textAlign: 'center',
    fontWeight: '500',
  },
});

export default PhotoCapture;
