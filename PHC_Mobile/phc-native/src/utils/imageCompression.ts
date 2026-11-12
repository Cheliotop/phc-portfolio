import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

export interface CompressionOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: 'jpeg' | 'png';
}

export interface CompressedImage {
  uri: string;
  width: number;
  height: number;
  size: number;
  format: string;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  width: 1200,
  height: 1200,
  quality: 0.8,
  format: 'jpeg',
};

export const compressImage = async (
  uri: string,
  options: CompressionOptions = {}
): Promise<CompressedImage> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Passing both width AND height to expo-image-manipulator's resize
    // stretches the image to that exact box instead of preserving aspect
    // ratio — a 4:3 field photo would get visibly squished toward square
    // (the defaults below are 1200x1200 / 1600x1600). Passing width only
    // lets it scale proportionally, which is what "compress for upload"
    // should mean here.
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [
        {
          resize: {
            width: opts.width,
          },
        },
      ],
      {
        compress: opts.quality,
        format: opts.format === 'png' ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG,
      }
    );

    const fileInfo = await FileSystem.getInfoAsync(manipulated.uri);
    const size = fileInfo.exists ? (fileInfo.size || 0) : 0;

    return {
      uri: manipulated.uri,
      width: manipulated.width,
      height: manipulated.height,
      size,
      format: opts.format || 'jpeg',
    };
  } catch (error) {
    console.error('[ImageCompression] Failed:', error);
    throw error;
  }
};

export const compressImageForUpload = async (
  uri: string,
  maxSizeKB: number = 500
): Promise<CompressedImage> => {
  let quality = 0.9;
  let width = 1600;
  let height = 1600;

  let result = await compressImage(uri, { quality, width, height });

  while (result.size > maxSizeKB * 1024 && quality > 0.2) {
    quality -= 0.1;
    width = Math.floor(width * 0.9);
    height = Math.floor(height * 0.9);
    result = await compressImage(uri, { quality, width, height });
  }

  console.log(`[ImageCompression] Final: ${(result.size / 1024).toFixed(1)}KB (${quality * 100}% quality)`);
  return result;
};
