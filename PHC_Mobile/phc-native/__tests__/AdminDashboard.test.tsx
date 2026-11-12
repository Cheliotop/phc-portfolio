import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { auth } from '../src/api/supabase-auth';
import AdminDashboard from '../src/screens/AdminDashboard';

let mockWindowDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
let mockDashboardTabOptions: any;
let mockPressedDashboardTab: string | undefined;

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowDimensions,
}));

const mockShowSheet = jest.fn();
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: unknown[]) => mockShowSheet(...args),
  SheetHost: () => null,
}));


const mockReset = jest.fn();

jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn(),
}));

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
        return (
        <View>
          {ReactModule.Children.map(
            children,
            (child: React.ReactElement<{ name: string; options?: { tabBarLabel?: string; tabBarIcon?: (props: { color: string }) => React.ReactNode } }>) => (
              <Pressable
                key={child.props.name}
                accessibilityRole="tab"
                testID={`tab-${child.props.name}`}
                onPress={() => { mockPressedDashboardTab = child.props.name; }}
              >
                {child.props.options?.tabBarIcon?.({ color: 'white' })}
                <Text>{child.props.options?.tabBarLabel || child.props.name}</Text>
              </Pressable>
            ),
          )}
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

const mockAlert = mockShowSheet;
const mockLogout = auth.logout as jest.MockedFunction<typeof auth.logout>;

describe('AdminDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWindowDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    mockDashboardTabOptions = undefined;
    mockPressedDashboardTab = undefined;
    mockLogout.mockResolvedValue(undefined);
  });

  it('renders the current admin header and all seven administration tabs', () => {
    const { getByText, getByTestId } = render(<AdminDashboard />);

    expect(getByText('Administración')).toBeTruthy();
    expect(getByText('Panel de Control')).toBeTruthy();
    for (const label of ['Resumen', 'Proyectos', 'Catálogo', 'Operación', 'Operadores', 'Pedidos', 'Cierres', 'Revisión']) {
      expect(getByText(label)).toBeTruthy();
    }
    // Exportar / Clave / Salir now live behind one menu rather than sitting on
    // every screen. Signing out in particular should not be a stray tap away
    // on a phone that gets passed around a work site.
    expect(getByTestId('admin-header-menu')).toBeTruthy();
  });

  it.each([
    ['tablet landscape', 1280, 800],
    ['tablet portrait', 800, 1280],
  ])('shows every admin tab as pressable in %s', (_label, width, height) => {
    mockWindowDimensions = { width, height, scale: 1, fontScale: 1 };
    const labels = ['Resumen', 'Proyectos', 'Catálogo', 'Operación', 'Operadores', 'Pedidos', 'Cierres', 'Revisión'];
    const { getByRole, getByText } = render(<AdminDashboard />);

    for (const label of labels) {
      expect(getByText(label)).toBeTruthy();
      expect(getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(mockDashboardTabOptions.tabBarScrollEnabled).toBe(false);
    expect(mockDashboardTabOptions.tabBarShowIcon).toBe(true);
    expect(mockDashboardTabOptions.tabBarItemStyle).toEqual(expect.objectContaining({ flex: 1, minWidth: 0 }));
    expect(mockDashboardTabOptions.sceneStyle).toEqual(expect.objectContaining({ maxWidth: 880 }));
    expect(getByText('◷')).toBeTruthy();
    fireEvent.press(getByRole('tab', { name: 'Revisión' }));
    expect(mockPressedDashboardTab).toBe('RejectedWork');
  });

  it('keeps the phone tab layout and scrolling behavior', () => {
    render(<AdminDashboard />);

    expect(mockDashboardTabOptions.tabBarScrollEnabled).toBe(true);
    expect(mockDashboardTabOptions.tabBarShowIcon).toBe(false);
    expect(mockDashboardTabOptions.tabBarStyle).toEqual(expect.arrayContaining([expect.objectContaining({ height: 48 })]));
    expect(mockDashboardTabOptions.sceneStyle).toEqual(expect.objectContaining({ width: '100%', maxWidth: 880 }));
  });

  /**
   * Open the header menu and invoke one of its entries by label. The entry's
   * onPress is called inside act() because several of them set state that has
   * to be flushed before the resulting modal is queryable.
   */
  const pressMenuItem = (getByTestId: ReturnType<typeof render>['getByTestId'], label: string) => {
    fireEvent.press(getByTestId('admin-header-menu'));
    const entries = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] ?? [];
    const entry = entries.find((option) => option.text === label);
    expect(entry).toBeTruthy();
    act(() => {
      void entry?.onPress?.();
    });
  };

  it('reaches export through the header menu', () => {
    const { getByTestId } = render(<AdminDashboard />);

    pressMenuItem(getByTestId, 'Exportar');

    expect(mockAlert).toHaveBeenLastCalledWith(
      'Exportar',
      'Elegí qué exportar',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Exportar PDF · Proyectos' }),
        expect.objectContaining({ text: 'Exportar PDF · Pedidos' }),
        expect.objectContaining({ text: 'Exportar CSV · Proyectos' }),
        expect.objectContaining({ text: 'Exportar CSV · Pedidos' }),
        expect.objectContaining({ text: 'Cancelar', style: 'cancel' }),
      ]),
    );
  });

  it('offers PDF above CSV, since PDF is what gets printed and filed', () => {
    const { getByTestId } = render(<AdminDashboard />);

    pressMenuItem(getByTestId, 'Exportar');

    const options = (mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] ?? [])
      .map((option) => option.text)
      .filter((text): text is string => Boolean(text) && text !== 'Cancelar');
    expect(options[0]).toContain('PDF');
    expect(options[1]).toContain('PDF');
    expect(options[2]).toContain('CSV');
  });

  it('validates the admin password form before calling Supabase', () => {
    const { getByText, getByTestId } = render(<AdminDashboard />);

    pressMenuItem(getByTestId, 'Cambiar clave');
    fireEvent.press(getByText('Guardar'));

    // The refusal shows inside the password card, where the admin is typing.
    expect(getByText('La contraseña debe tener al menos 8 caracteres')).toBeTruthy();
    expect(mockAlert).not.toHaveBeenCalledWith('Error', expect.anything());
  });

  it('signs out only after confirmation and resets to Login without back history', async () => {
    const { getByTestId } = render(<AdminDashboard />);

    pressMenuItem(getByTestId, 'Cerrar sesión');

    expect(mockAlert).toHaveBeenLastCalledWith(
      'Cerrar Sesión',
      '¿Seguro que querés cerrar sesión?',
      expect.any(Array),
    );
    expect(mockLogout).not.toHaveBeenCalled();

    const logoutCall = mockAlert.mock.calls.find((call) => call[0] === 'Cerrar Sesión');
    const confirm = logoutCall?.[2]?.[1];
    await confirm?.onPress?.();

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Login' }] });
  });
});
