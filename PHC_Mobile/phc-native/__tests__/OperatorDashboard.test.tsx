import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { auth } from '../src/api/supabase-auth';
import { notifyOperatorDataChanged } from '../src/events/operatorDataEvents';
import OperatorDashboard from '../src/screens/OperatorDashboard';
import { drainOutbox } from '../src/sync/drainCoordinator';
import { auditLogout } from '../src/utils/auditLog';

let mockWindowDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
let mockDashboardTabOptions: any;
let mockPressedDashboardTab: string | undefined;

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowDimensions,
}));

const mockShowSheet = jest.fn();
const mockIsTablet = jest.fn(() => false);
jest.mock('../src/utils/device', () => ({ isTablet: () => mockIsTablet() }));
jest.mock('../src/components/shared/OperatorIdleLock', () => ({ OperatorIdleLock: ({ children }: any) => children }));
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: unknown[]) => mockShowSheet(...args),
  SheetHost: () => null,
}));


const mockReset = jest.fn();
const mockQuery = jest.fn();
const mockExecute = jest.fn();
let mockOperatorInitialTab = '';
let mockAssignedProjects: Array<{
  id: string;
  name: string;
  location: string;
  assigned_operator_id: string;
  progress: number;
  status: string;
  created_at: string;
  updated_at: string;
  current_depth: number;
  target_depth: number;
}> = [];

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ reset: mockReset }),
}));

jest.mock('@react-navigation/material-top-tabs', () => {
  const ReactModule = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    createMaterialTopTabNavigator: () => ({
      Screen: () => null,
      Navigator: ({ children, screenOptions }: { children: React.ReactNode; screenOptions: any }) => {
        mockDashboardTabOptions = screenOptions;
        const screens = ReactModule.Children.toArray(children) as Array<React.ReactElement<{
          component: React.ComponentType;
          name: string;
          options?: { tabBarLabel?: string; tabBarIcon?: (props: { color: string }) => React.ReactNode };
        }>>;
        const activeScreen = screens.find((child) => child.props.name === mockOperatorInitialTab);
        const ActiveComponent = activeScreen?.props.component;

        return (
          <View>
            <View testID="dashboard-tab-bar">
              {screens.map((child) => (
                <Pressable
                  key={child.props.name}
                  accessibilityRole="tab"
                  testID={`tab-${child.props.name}`}
                  onPress={() => { mockPressedDashboardTab = child.props.name; }}
                >
                  {child.props.options?.tabBarIcon?.({ color: 'white' })}
                  <Text>{child.props.options?.tabBarLabel || child.props.name}</Text>
                </Pressable>
              ))}
            </View>
            {ActiveComponent ? <ActiveComponent /> : null}
          </View>
        );
      },
    }),
  };
});

jest.mock('../src/components/shared/SyncStatusIndicator', () => {
  const { Text } = require('react-native');
  return {
    SyncStatusIndicator: () => <Text>Sincronización</Text>,
    SyncQueueModal: () => null,
  };
});

jest.mock('../src/api/supabase-auth', () => ({
  auth: { logout: jest.fn() },
}));

jest.mock('../src/utils/auditLog', () => ({
  auditLogout: jest.fn(),
}));

jest.mock('../src/sync/drainCoordinator', () => ({
  drainOutbox: jest.fn(),
}));

const mockCountUnsent = jest.fn(async () => 0);
const mockCountRejected = jest.fn().mockResolvedValue(0);
jest.mock('../src/sync/outboxOwner', () => ({
  countUnsentOutboxRows: () => mockCountUnsent(),
  countRejectedOutboxRows: () => mockCountRejected(),
}));

jest.mock('../src/events/operatorDataEvents', () => ({
  notifyOperatorDataChanged: jest.fn(),
}));

jest.mock('../src/db/db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}));

jest.mock('../src/hooks/useOperatorDataRefresh', () => ({
  useOperatorDataRefresh: (refresh: () => void | Promise<unknown>) => {
    const ReactModule = require('react');
    const refreshRef = ReactModule.useRef(refresh);
    refreshRef.current = refresh;
    ReactModule.useEffect(() => {
      refreshRef.current();
    }, []);
  },
}));

jest.mock('../src/sync/serverBarsCache', () => ({
  cacheServerBars: jest.fn(async () => undefined),
}));

const mockAlert = mockShowSheet;
const mockLogout = auth.logout as jest.MockedFunction<typeof auth.logout>;
const mockAuditLogout = auditLogout as jest.MockedFunction<typeof auditLogout>;
const mockDrainOutbox = drainOutbox as jest.MockedFunction<typeof drainOutbox>;
const mockNotifyOperatorDataChanged = notifyOperatorDataChanged as jest.MockedFunction<typeof notifyOperatorDataChanged>;
const mockNetInfoFetch = NetInfo.fetch as jest.MockedFunction<typeof NetInfo.fetch>;

describe('OperatorDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTablet.mockReturnValue(false);
    mockOperatorInitialTab = '';
    mockWindowDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    mockDashboardTabOptions = undefined;
    mockPressedDashboardTab = undefined;
    mockAssignedProjects = [];
    mockLogout.mockResolvedValue(undefined);
    mockAuditLogout.mockResolvedValue(undefined);
    mockDrainOutbox.mockResolvedValue({ synced: 0, failed: 0, rejected: 0 });
    mockNetInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
      type: 'wifi',
      details: null,
    });
    mockExecute.mockResolvedValue({ changes: 1 });
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM projects')) {
        return mockAssignedProjects.map(({ id }) => ({ id }));
      }
      if (sql.includes('current_depth')) {
        return mockAssignedProjects;
      }
      return [];
    });
    (AsyncStorage.getItem as jest.MockedFunction<typeof AsyncStorage.getItem>).mockImplementation(
      async (key) => {
        if (key === 'userName') return 'Operador QA';
        if (key === 'operatorId') return 'operator-1';
        return null;
      },
    );
  });

  it('renders the current operator identity and all seven workflow tabs', async () => {
    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(getByText('Operador QA')).toBeTruthy());
    expect(getByText('Panel de Operador')).toBeTruthy();
    for (const label of ['Turnos', 'Pozos', 'Progreso', 'Materiales', 'Pedidos', 'Muestras', 'Cierre']) {
      expect(getByText(label)).toBeTruthy();
    }
  });

  it.each([
    ['tablet landscape', 1280, 800],
    ['tablet portrait', 800, 1280],
  ])('shows every operator tab as pressable in %s', async (_label, width, height) => {
    mockWindowDimensions = { width, height, scale: 1, fontScale: 1 };
    const labels = ['Turnos', 'Pozos', 'Progreso', 'Materiales', 'Pedidos', 'Muestras', 'Cierre'];
    const { getByRole, getByText } = render(<OperatorDashboard />);

    for (const label of labels) {
      expect(getByText(label)).toBeTruthy();
      expect(getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(mockDashboardTabOptions.tabBarScrollEnabled).toBe(false);
    expect(mockDashboardTabOptions.tabBarShowIcon).toBe(true);
    expect(mockDashboardTabOptions.tabBarItemStyle).toEqual(expect.objectContaining({ flex: 1, minWidth: 0 }));
    expect(mockDashboardTabOptions.sceneStyle).toEqual(expect.objectContaining({ maxWidth: 880 }));
    expect(getByText('◷')).toBeTruthy();
    fireEvent.press(getByRole('tab', { name: 'Cierre' }));
    expect(mockPressedDashboardTab).toBe('Cierre');
  });

  it('keeps the phone tab layout and scrolling behavior', () => {
    mockWindowDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    render(<OperatorDashboard />);

    expect(mockDashboardTabOptions.tabBarScrollEnabled).toBe(true);
    expect(mockDashboardTabOptions.tabBarShowIcon).toBe(false);
    expect(mockDashboardTabOptions.tabBarStyle).toEqual(expect.arrayContaining([expect.objectContaining({ height: 48 })]));
    expect(mockDashboardTabOptions.sceneStyle).toEqual(expect.objectContaining({ width: '100%', maxWidth: 880 }));
  });

  it('uses the operator fallback when no stored display name exists', async () => {
    (AsyncStorage.getItem as jest.MockedFunction<typeof AsyncStorage.getItem>).mockImplementation(
      async (key) => key === 'operatorId' ? 'operator-1' : null,
    );
    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(getByText('Operador')).toBeTruthy());
  });

  it('loads the assigned well from the current local data seam', async () => {
    mockOperatorInitialTab = 'Pozos';
    mockAssignedProjects = [{
      id: 'well-1',
      name: 'Pozo Norte',
      location: 'Lat: -25.123, Lng: -57.456',
      assigned_operator_id: 'operator-1',
      progress: 45.5,
      status: 'En Progreso',
      created_at: '2026-06-29T12:00:00.000Z',
      updated_at: '2026-07-26T12:00:00.000Z',
      current_depth: 45.5,
      target_depth: 100,
    }];
    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(getByText('Pozo Norte')).toBeTruthy());
    expect(getByText('Lat: -25.123, Lng: -57.456')).toBeTruthy();
    expect(getByText('100m')).toBeTruthy();
    expect(getByText('45.5m')).toBeTruthy();
  });

  it('shows the honest empty state when no well is assigned', async () => {
    mockOperatorInitialTab = 'Pozos';
    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(getByText('Sin Proyecto Asignado')).toBeTruthy());
    expect(getByText('No tenés un proyecto asignado. Hablá con el administrador.')).toBeTruthy();
  });

  it('drains pending work on a connected mount and refreshes visible data', async () => {
    mockDrainOutbox.mockResolvedValue({ synced: 2, failed: 0, rejected: 0 });

    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(mockDrainOutbox).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText('Operador QA')).toBeTruthy());
    expect(mockNotifyOperatorDataChanged).toHaveBeenCalledTimes(1);
  });

  it('does not drain the outbox while offline', async () => {
    mockNetInfoFetch.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
      type: 'none',
      details: null,
    });

    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(mockNetInfoFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText('Operador QA')).toBeTruthy());
    expect(mockDrainOutbox).not.toHaveBeenCalled();
    expect(mockNotifyOperatorDataChanged).not.toHaveBeenCalled();
  });

  it('warns about rejected work on logout instead of a plain confirmation', async () => {
    mockCountRejected.mockResolvedValueOnce(2);
    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(getByText('Operador QA')).toBeTruthy());
    fireEvent.press(getByText('Salir'));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      'Cerrar Sesión',
      expect.stringContaining('El servidor rechazó 2 registro(s)'),
      expect.any(Array),
    ));
  });

  it('audits and signs out only after logout confirmation, then clears navigation history', async () => {
    const { getByText } = render(<OperatorDashboard />);

    await waitFor(() => expect(getByText('Operador QA')).toBeTruthy());
    fireEvent.press(getByText('Salir'));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      'Cerrar Sesión',
      '¿Estás seguro de que querés cerrar sesión?',
      expect.any(Array),
    ));
    expect(mockLogout).not.toHaveBeenCalled();

    const confirm = mockAlert.mock.calls[0][2]?.[1];
    await confirm?.onPress?.();

    expect(mockAuditLogout).toHaveBeenCalledWith('operator-1');
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Login' }] });
  });

  it('confirms a tablet operator switch and leaves queued work untouched', async () => {
    mockIsTablet.mockReturnValue(true);
    const { getByText } = render(<OperatorDashboard />);
    await waitFor(() => expect(getByText('Operador QA')).toBeTruthy());
    fireEvent.press(getByText('Cambiar operador'));
    expect(mockShowSheet).toHaveBeenCalledWith(
      'Cambiar operador',
      expect.any(String),
      expect.any(Array),
    );
    const confirm = mockShowSheet.mock.calls.at(-1)?.[2]?.[1];
    await confirm?.onPress?.();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Login' }] });
    expect(mockCountUnsent).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
