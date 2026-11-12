/**
 * Crash reporting beyond render errors (AUTH-8). Errors thrown in handlers and
 * async code reach the global JS handler, unhandled promise rejections reach
 * Hermes' tracker, and queued reports are sent at startup, whenever the network
 * comes back, and whenever a drain ends.
 */
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '2.0.42' },
    platform: { android: { versionCode: 44 } },
  },
}));

const mockUpsert = jest.fn();
const mockGetSession = jest.fn();

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    auth: { getSession: (...a: unknown[]) => mockGetSession(...a) },
    from: () => ({ upsert: (...a: unknown[]) => mockUpsert(...a) }),
  },
}));

const QUEUE_KEY = 'phc.crashQueue';
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

// Fresh module registry per test, so the install-once flag starts clear. The
// AsyncStorage and NetInfo instances must come from the same registry as the
// module under test, so they are loaded here too.
let AsyncStorage: any;
let NetInfo: any;
let crash: typeof import('../src/utils/crashReport');
const readQueue = async () => JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]');

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  const asyncStorageModule = require('@react-native-async-storage/async-storage');
  AsyncStorage = asyncStorageModule.default ?? asyncStorageModule;
  NetInfo = require('@react-native-community/netinfo').default;
  await AsyncStorage.clear();
  mockGetSession.mockResolvedValue({ data: { session: null } });
  mockUpsert.mockResolvedValue({ error: null });
  (globalThis as any).ErrorUtils = undefined;
  (globalThis as any).HermesInternal = undefined;
  crash = require('../src/utils/crashReport');
});

describe('global error handling', () => {
  it('queues an uncaught JS error with the fatal flag from the global handler', async () => {
    const previous = jest.fn();
    let installed: ((error: unknown, isFatal?: boolean) => void) | undefined;
    (globalThis as any).ErrorUtils = {
      getGlobalHandler: () => previous,
      setGlobalHandler: (handler: typeof installed) => { installed = handler; },
    };

    crash.installCrashReporting();
    installed!(new Error('se cayó el guardado'), true);
    await flushAsync();

    const [report] = await readQueue();
    expect(report.message).toBe('se cayó el guardado');
    expect(report.is_fatal).toBe(true);
    // The default behaviour still runs after the report is queued.
    expect(previous).toHaveBeenCalledWith(expect.any(Error), true);
  });

  it('queues an unhandled promise rejection through Hermes', async () => {
    let onUnhandled: ((id: number, error: unknown) => void) | undefined;
    (globalThis as any).HermesInternal = {
      enablePromiseRejectionTracker: (options: { onUnhandled: typeof onUnhandled }) => {
        onUnhandled = options.onUnhandled;
      },
    };

    crash.installCrashReporting();
    onUnhandled!(7, 'la sincronización falló');
    await flushAsync();

    const [report] = await readQueue();
    expect(report.message).toBe('la sincronización falló');
    expect(report.is_fatal).toBe(false);
  });

  it('installs once, however many times it is called', () => {
    const setGlobalHandler = jest.fn();
    (globalThis as any).ErrorUtils = { getGlobalHandler: () => undefined, setGlobalHandler };

    crash.installCrashReporting();
    crash.installCrashReporting();

    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
  });
});

describe('sending queued reports', () => {
  it('sends what is queued at startup when there is a session', async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([{ client_entry_id: 'crash-old', message: 'de ayer', profile_id: null }]));
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'op-1' } } } });

    crash.installCrashReporting();
    await flushAsync();
    await flushAsync();

    expect(mockUpsert).toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(0);
  });

  it('sends when the network comes back', async () => {
    // Installed while signed out, so the startup pass has nothing to send.
    crash.installCrashReporting();
    await flushAsync();
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([{ client_entry_id: 'crash-net', message: 'offline', profile_id: null }]));
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'op-1' } } } });
    mockUpsert.mockClear();
    const addListener = NetInfo.addEventListener as jest.Mock;
    const listener = addListener.mock.calls[addListener.mock.calls.length - 1][0];

    listener({ isConnected: false });
    await flushAsync();
    expect(mockUpsert).not.toHaveBeenCalled();

    listener({ isConnected: true });
    await flushAsync();
    await flushAsync();

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toHaveLength(0);
  });

  it('sends at the end of every drain, via the queue-change notification', async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([{ client_entry_id: 'crash-drain', message: 'drain', profile_id: null }]));
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'op-1' } } } });
    const { notifyQueueChanged } = require('../src/events/queueEvents');

    crash.installCrashReporting();
    await flushAsync();
    await flushAsync();
    mockUpsert.mockClear();
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([{ client_entry_id: 'crash-drain-2', message: 'again', profile_id: null }]));

    notifyQueueChanged();
    await flushAsync();
    await flushAsync();

    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });
});
