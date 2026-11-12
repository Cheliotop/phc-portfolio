/**
 * Requests must have a deadline, and known-offline requests must not wait for it.
 *
 * `fetch` has no timeout. With no signal a request does not fail — it hangs on
 * DNS or an unanswered connect until the OS gives up, which on Android is well
 * over a minute. Found on a handset on 2026-08-01: Muestras, Materiales,
 * Pedidos and Cierre all sat on "Cargando…" indefinitely with no signal.
 *
 * The screens were not missing an offline path. Three of the four already read
 * SQLite and already handled a failed refresh — they never reached the catch,
 * because the await never returned.
 */
const listeners: ((state: { isConnected: boolean | null }) => void)[] = [];

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (cb: (s: { isConnected: boolean | null }) => void) => {
      listeners.push(cb);
      return () => undefined;
    },
  },
}));

const capturedOptions: Record<string, any> = {};
jest.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: any) => {
    Object.assign(capturedOptions, options);
    return { auth: { startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn() } };
  },
  processLock: jest.fn(),
}));

import '../src/lib/supabase';

const setConnectivity = (isConnected: boolean | null) => {
  listeners.forEach((cb) => cb({ isConnected }));
};

const clientFetch = () => capturedOptions.global.fetch as typeof fetch;

describe('request deadline', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('installs a custom fetch on the client', () => {
    expect(typeof capturedOptions.global?.fetch).toBe('function');
  });

  it('fails immediately when the device knows it is offline', async () => {
    // Not after fifteen seconds. The screens fall back to SQLite at once
    // instead of spinning to reach a conclusion the OS already had.
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    setConnectivity(false);

    await expect(clientFetch()('https://x.supabase.co/rest/v1/projects')).rejects.toThrow('Sin conexión');
    expect(spy).not.toHaveBeenCalled();
  });

  it('still attempts the request when connectivity is unknown', async () => {
    // A false negative from NetInfo must cost a timeout, not a feature.
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    setConnectivity(null);

    await expect(clientFetch()('https://x.supabase.co/rest/v1/projects')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalled();
  });

  it('aborts a hanging request instead of waiting forever', async () => {
    jest.useFakeTimers();
    setConnectivity(true);

    let passedSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_input, init?: RequestInit) => {
      passedSignal = init?.signal ?? undefined;
      return new Promise(() => {}); // never settles, exactly like no signal
    }) as unknown as typeof fetch;

    void clientFetch()('https://x.supabase.co/rest/v1/projects');
    expect(passedSignal?.aborted).toBe(false);

    jest.advanceTimersByTime(15_000);
    expect(passedSignal?.aborted).toBe(true);
  });

  it('reports a timeout in Spanish, not as "Aborted"', async () => {
    // Screens render error.message straight to the operator. "Aborted" and
    // "Network request failed" are English and say nothing about what to do.
    setConnectivity(true);
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('Aborted'), { name: 'AbortError' }),
    ) as unknown as typeof fetch;

    await expect(clientFetch()('https://x.supabase.co/rest/v1/projects'))
      .rejects.toThrow(/Sin conexión/);
  });

  it('translates a bare network failure the same way', async () => {
    setConnectivity(true);
    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as unknown as typeof fetch;

    await expect(clientFetch()('https://x.supabase.co/rest/v1/projects'))
      .rejects.toThrow(/Sin conexión/);
  });

  it('leaves a real server error alone', async () => {
    // Only no-signal failures are translated; a 500 must keep its own message
    // so a genuine fault is not disguised as a connectivity problem.
    setConnectivity(true);
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;

    await expect(clientFetch()('https://x.supabase.co/rest/v1/projects')).rejects.toThrow('boom');
  });

  it('gives storage far longer, so a slow photo upload is not killed', async () => {
    // An operator cannot re-photograph a hole they have already cased.
    jest.useFakeTimers();
    setConnectivity(true);

    let passedSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_input, init?: RequestInit) => {
      passedSignal = init?.signal ?? undefined;
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    void clientFetch()('https://x.supabase.co/storage/v1/object/phc-photos/2/a.jpg');

    jest.advanceTimersByTime(15_000);
    expect(passedSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(105_000);
    expect(passedSignal?.aborted).toBe(true);
  });
});
