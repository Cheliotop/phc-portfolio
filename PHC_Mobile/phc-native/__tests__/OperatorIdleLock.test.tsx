import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';
import { OperatorIdleLock } from '../src/components/shared/OperatorIdleLock';

const mockVerify = jest.fn();
const mockReset = jest.fn();
const mockIsTablet = jest.fn(() => true);
jest.mock('../src/utils/device', () => ({ isTablet: () => mockIsTablet() }));
jest.mock('../src/utils/operatorVault', () => ({ verifyVaultPassword: (...args: unknown[]) => mockVerify(...args) }));
jest.mock('../src/api/supabase-auth', () => ({ auth: { logout: jest.fn(async () => undefined) } }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ reset: mockReset }) }));

describe('operator tablet idle lock', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    mockVerify.mockReset();
    mockIsTablet.mockReturnValue(true);
    mockReset.mockReset();
    await AsyncStorage.clear();
    await AsyncStorage.multiSet([
      ['userId', 'operator-1'], ['userName', 'Ana Rojas'], ['userLoginName', 'ana'],
      ['phc.operatorLastActiveAt', String(Date.now())],
    ]);
  });
  afterEach(() => { jest.useRealTimers(); });

  it('locks after ten minutes and unlocks only with the operator password', async () => {
    mockVerify.mockResolvedValue({ id: 'operator-1' });
    const screen = render(<OperatorIdleLock><Text>Formulario abierto</Text></OperatorIdleLock>);
    expect(screen.getByText('Formulario abierto')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(10 * 60 * 1000); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText('Tableta bloqueada')).toBeTruthy());
    expect(screen.getByText('Formulario abierto')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('Contraseña'), 'pass');
    fireEvent.press(screen.getByText('Desbloquear'));
    await waitFor(() => expect(screen.queryByText('Tableta bloqueada')).toBeNull());
    expect(mockVerify).toHaveBeenCalledWith('ana', 'pass');
  });

  it('does not lock a phone after ten minutes', async () => {
    mockIsTablet.mockReturnValue(false);
    const screen = render(<OperatorIdleLock><Text>Formulario abierto</Text></OperatorIdleLock>);
    await act(async () => { jest.advanceTimersByTime(15 * 60 * 1000); await Promise.resolve(); });
    expect(screen.queryByText('Tableta bloqueada')).toBeNull();
    expect(screen.getByText('Formulario abierto')).toBeTruthy();
  });
});
