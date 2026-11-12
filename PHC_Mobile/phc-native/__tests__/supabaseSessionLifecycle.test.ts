const mockStartAutoRefresh = jest.fn();
const mockStopAutoRefresh = jest.fn();
const mockAddEventListener = jest.fn();
const mockCreateClient = jest.fn(() => ({
  auth: { startAutoRefresh: mockStartAutoRefresh, stopAutoRefresh: mockStopAutoRefresh },
}));
const mockProcessLock = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
  processLock: mockProcessLock,
}));

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: mockAddEventListener,
  },
  Platform: { OS: 'android' },
}));

describe('Supabase React Native session lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('uses the Supabase process lock and refreshes only while foregrounded', () => {
    require('../src/lib/supabase');

    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        auth: expect.objectContaining({ lock: mockProcessLock }),
      }),
    );
    expect(mockStartAutoRefresh).toHaveBeenCalledTimes(1);
    expect(mockAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    const onAppStateChange = mockAddEventListener.mock.calls[0][1];
    onAppStateChange('background');
    expect(mockStopAutoRefresh).toHaveBeenCalledTimes(1);

    onAppStateChange('active');
    expect(mockStartAutoRefresh).toHaveBeenCalledTimes(2);
  });
});
