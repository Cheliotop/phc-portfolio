type OperatorDataListener = () => void;

const listeners = new Set<OperatorDataListener>();

export const notifyOperatorDataChanged = () => {
  listeners.forEach((listener) => listener());
};

export const subscribeToOperatorDataChanges = (listener: OperatorDataListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
