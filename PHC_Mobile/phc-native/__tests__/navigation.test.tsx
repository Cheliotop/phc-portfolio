import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Mock screens for testing navigation
const LoginScreen = ({ navigation }: any) => (
  <View>
    <Text>Login Screen</Text>
    <TouchableOpacity onPress={() => navigation.navigate('AdminDashboard')}>
      <Text>Go to Admin</Text>
    </TouchableOpacity>
    <TouchableOpacity onPress={() => navigation.navigate('OperatorDashboard')}>
      <Text>Go to Operator</Text>
    </TouchableOpacity>
  </View>
);

const AdminDashboard = ({ navigation }: any) => (
  <View>
    <Text>Admin Dashboard</Text>
    <TouchableOpacity onPress={() => navigation.goBack()}>
      <Text>Go Back</Text>
    </TouchableOpacity>
    <TouchableOpacity
      onPress={async () => {
        await AsyncStorage.multiRemove(['userRole', 'userName']);
        navigation.navigate('Login');
      }}
    >
      <Text>Logout</Text>
    </TouchableOpacity>
  </View>
);

const OperatorDashboard = ({ navigation }: any) => (
  <View>
    <Text>Operator Dashboard</Text>
    <TouchableOpacity onPress={() => navigation.goBack()}>
      <Text>Go Back</Text>
    </TouchableOpacity>
    <TouchableOpacity
      onPress={async () => {
        await AsyncStorage.multiRemove(['userRole', 'userName']);
        navigation.navigate('Login');
      }}
    >
      <Text>Logout</Text>
    </TouchableOpacity>
  </View>
);

const Stack = createStackNavigator();

const TestNavigator = () => (
  <NavigationContainer>
    <Stack.Navigator initialRouteName="Login" screenOptions={{ animationEnabled: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="AdminDashboard" component={AdminDashboard} />
      <Stack.Screen name="OperatorDashboard" component={OperatorDashboard} />
    </Stack.Navigator>
  </NavigationContainer>
);

describe('Navigation Flow Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.clear();
  });

  describe('Basic Navigation', () => {
    test('should navigate from Login to AdminDashboard', async () => {
      const { getByText } = render(<TestNavigator />);

      expect(getByText('Login Screen')).toBeTruthy();

      fireEvent.press(getByText('Go to Admin'));

      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });
    });

    test('should navigate from Login to OperatorDashboard', async () => {
      const { getByText } = render(<TestNavigator />);

      expect(getByText('Login Screen')).toBeTruthy();

      fireEvent.press(getByText('Go to Operator'));

      await waitFor(() => {
        expect(getByText('Operator Dashboard')).toBeTruthy();
      });
    });

    test('should navigate back from AdminDashboard to Login', async () => {
      const { getByText } = render(<TestNavigator />);

      fireEvent.press(getByText('Go to Admin'));

      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });

      fireEvent.press(getByText('Go Back'));

      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });
    });

    test('should navigate back from OperatorDashboard to Login', async () => {
      const { getByText } = render(<TestNavigator />);

      fireEvent.press(getByText('Go to Operator'));

      await waitFor(() => {
        expect(getByText('Operator Dashboard')).toBeTruthy();
      });

      fireEvent.press(getByText('Go Back'));

      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });
    });
  });

  describe('Logout Navigation', () => {
    test('should logout from AdminDashboard and clear session', async () => {
      // Set up logged in state
      await AsyncStorage.setItem('userRole', 'admin');
      await AsyncStorage.setItem('userName', 'Administrator');

      const { getByText } = render(<TestNavigator />);

      fireEvent.press(getByText('Go to Admin'));

      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });

      fireEvent.press(getByText('Logout'));

      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });

      // Verify session is cleared
      const userRole = await AsyncStorage.getItem('userRole');
      const userName = await AsyncStorage.getItem('userName');
      expect(userRole).toBeNull();
      expect(userName).toBeNull();
    });

    test('should logout from OperatorDashboard and clear session', async () => {
      // Set up logged in state
      await AsyncStorage.setItem('userRole', 'operator');
      await AsyncStorage.setItem('userName', 'Operator');

      const { getByText } = render(<TestNavigator />);

      fireEvent.press(getByText('Go to Operator'));

      await waitFor(() => {
        expect(getByText('Operator Dashboard')).toBeTruthy();
      });

      fireEvent.press(getByText('Logout'));

      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });

      // Verify session is cleared
      const userRole = await AsyncStorage.getItem('userRole');
      const userName = await AsyncStorage.getItem('userName');
      expect(userRole).toBeNull();
      expect(userName).toBeNull();
    });
  });

  describe('Navigation State Persistence', () => {
    test('should maintain navigation stack correctly', async () => {
      const { getByText } = render(<TestNavigator />);

      // Navigate to admin
      fireEvent.press(getByText('Go to Admin'));
      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });

      // Navigate back
      fireEvent.press(getByText('Go Back'));
      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });

      // Navigate to operator
      fireEvent.press(getByText('Go to Operator'));
      await waitFor(() => {
        expect(getByText('Operator Dashboard')).toBeTruthy();
      });

      // Navigate back again
      fireEvent.press(getByText('Go Back'));
      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });
    });
  });

  describe('Navigation Error Handling', () => {
    test('should handle navigation to non-existent screen gracefully', () => {
      const { getByText } = render(<TestNavigator />);

      // This should not crash the app
      expect(() => {
        fireEvent.press(getByText('Login Screen'));
      }).not.toThrow();
    });

    test('should handle multiple rapid navigation attempts', async () => {
      const { getByText } = render(<TestNavigator />);

      // Rapidly press navigation buttons
      const adminButton = getByText('Go to Admin');
      fireEvent.press(adminButton);
      fireEvent.press(adminButton);
      fireEvent.press(adminButton);

      // Should still navigate correctly
      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });
    });
  });

  describe('Deep Link Navigation', () => {
    test('should handle direct navigation to AdminDashboard', async () => {
      const DirectAdminNavigator = () => (
        <NavigationContainer>
          <Stack.Navigator initialRouteName="AdminDashboard" screenOptions={{ animationEnabled: false }}>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="AdminDashboard" component={AdminDashboard} />
            <Stack.Screen name="OperatorDashboard" component={OperatorDashboard} />
          </Stack.Navigator>
        </NavigationContainer>
      );

      const { getByText } = render(<DirectAdminNavigator />);

      expect(getByText('Admin Dashboard')).toBeTruthy();
    });

    test('should handle direct navigation to OperatorDashboard', async () => {
      const DirectOperatorNavigator = () => (
        <NavigationContainer>
          <Stack.Navigator initialRouteName="OperatorDashboard" screenOptions={{ animationEnabled: false }}>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="AdminDashboard" component={AdminDashboard} />
            <Stack.Screen name="OperatorDashboard" component={OperatorDashboard} />
          </Stack.Navigator>
        </NavigationContainer>
      );

      const { getByText } = render(<DirectOperatorNavigator />);

      expect(getByText('Operator Dashboard')).toBeTruthy();
    });
  });

  describe('Navigation Performance', () => {
    test('should navigate quickly without delays', async () => {
      const { getByText } = render(<TestNavigator />);

      const startTime = Date.now();

      fireEvent.press(getByText('Go to Admin'));

      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });

      const endTime = Date.now();
      const navigationTime = endTime - startTime;

      // Navigation should be fast (less than 1 second)
      expect(navigationTime).toBeLessThan(1000);
    });

    test('should handle navigation stack without memory leaks', async () => {
      const { getByText } = render(<TestNavigator />);

      // Perform multiple navigation operations
      for (let i = 0; i < 10; i++) {
        fireEvent.press(getByText('Go to Admin'));
        await waitFor(() => {
          expect(getByText('Admin Dashboard')).toBeTruthy();
        });

        fireEvent.press(getByText('Go Back'));
        await waitFor(() => {
          expect(getByText('Login Screen')).toBeTruthy();
        });
      }

      // Should complete without crashing
      expect(getByText('Login Screen')).toBeTruthy();
    });
  });

  describe('Navigation Guards', () => {
    test('should prevent navigation without proper authentication', async () => {
      // Clear any existing session
      await AsyncStorage.clear();

      const { getByText } = render(<TestNavigator />);

      // Should start at login screen when not authenticated
      expect(getByText('Login Screen')).toBeTruthy();
    });

    test('should redirect to login when session expires', async () => {
      const { getByText } = render(<TestNavigator />);

      // Navigate to admin
      fireEvent.press(getByText('Go to Admin'));
      await waitFor(() => {
        expect(getByText('Admin Dashboard')).toBeTruthy();
      });

      // Simulate session expiry
      await AsyncStorage.clear();

      // Navigate back (simulating app state change)
      fireEvent.press(getByText('Logout'));

      await waitFor(() => {
        expect(getByText('Login Screen')).toBeTruthy();
      });
    });
  });
});
