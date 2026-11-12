/**
 * Something may have changed in the upload queue: a drain finished, or a screen
 * queued or sent work itself. The header badge listens, so it doesn't keep showing
 * a count that is already gone.
 */
type QueueListener = () => void;

const listeners = new Set<QueueListener>();

export const notifyQueueChanged = () => {
  listeners.forEach((listener) => listener());
};

export const subscribeToQueueChanges = (listener: QueueListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
