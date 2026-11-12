/**
 * The photo a queued record points at is no longer on the phone.
 *
 * Camera pictures live in the app's cache folder, which Android may clear while
 * work waits offline. Retrying can never bring the file back, so callers decide
 * what the record does without it instead of retrying forever.
 */
export class LocalPhotoMissingError extends Error {
  constructor(readonly localUri: string) {
    super('La foto ya no está en el dispositivo');
    this.name = 'LocalPhotoMissingError';
  }
}
