/**
 * Operator management on the admin side (ADM-16, ADM-9).
 *
 * The list shows each operator's username, because operators log in with it.
 * The password fields can be revealed, so a typo does not lock someone out.
 * Errors for the add-operator form show inside that form. A delete refusal names
 * the real reason, and a reset whose only failure is the session revoke counts
 * as a reset that worked.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

import { operatorsApi } from '../src/api/supabase-operators';
import { auth } from '../src/api/supabase-auth';
import { adminResetOperatorPassword } from '../src/api/adminResetOperatorPassword';
import { query } from '../src/db/db';
import { showSheet } from '../src/components/shared/Sheet';
import OperadoresTab from '../src/components/admin/OperadoresTab';

jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));

jest.mock('../src/db/db', () => ({
  execute: jest.fn(async () => undefined),
  query: jest.fn(async () => []),
  runInTransaction: jest.fn(async (callback: (tx: { execute: jest.Mock }) => unknown) => callback({ execute: jest.fn() })),
}));
jest.mock('../src/db/repositories/operators', () => ({
  mirrorOperator: jest.fn(),
  updateOperatorStatus: jest.fn(),
}));
jest.mock('../src/api/supabase-operators', () => ({
  operatorsApi: {
    getAll: jest.fn(),
    getAssignedProjectCounts: jest.fn(),
    getByUsername: jest.fn(),
    deleteUnusedOperator: jest.fn(),
    setActive: jest.fn(),
  },
}));
jest.mock('../src/api/supabase-auth', () => ({
  auth: { adminCreateOperator: jest.fn() },
}));
jest.mock('../src/api/adminResetOperatorPassword', () => ({
  adminResetOperatorPassword: jest.fn(),
}));

const operatorRow = {
  id: 'op-1',
  name: 'Ana Operadora',
  role: 'operator',
  status: 'active',
  created_at: '2026-07-01T10:00:00Z',
};

const serverOperator = {
  id: 'op-1',
  full_name: 'Ana Operadora',
  username: 'ana',
  role: 'operator',
  is_active: true,
  created_at: '2026-07-01T10:00:00Z',
};

const renderWithOperator = async () => {
  (query as jest.Mock).mockImplementation(async (sql: string) => (sql.includes('FROM operators o') ? [operatorRow] : []));
  const view = render(<OperadoresTab />);
  await waitFor(() => expect(view.getByText('Ana Operadora')).toBeTruthy());
  return view;
};

describe('OperadoresTab', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.setItem('authToken', 'token-for-test');
    (operatorsApi.getAll as jest.Mock).mockResolvedValue([serverOperator]);
    (operatorsApi.getAssignedProjectCounts as jest.Mock).mockResolvedValue({});
  });

  it('shows the username under the operator name', async () => {
    const view = await renderWithOperator();
    expect(view.getByText('@ana')).toBeTruthy();
  });

  it('reveals the initial password only on request', async () => {
    const view = await renderWithOperator();
    fireEvent.press(view.getByText('+ Agregar'));

    const field = view.getByTestId('new-operator-password-input');
    expect(field.props.secureTextEntry).toBe(true);
    fireEvent.press(view.getByTestId('new-operator-password-toggle'));
    expect(view.getByTestId('new-operator-password-input').props.secureTextEntry).toBe(false);
  });

  it('reveals the reset password only on request', async () => {
    const view = await renderWithOperator();
    fireEvent.press(view.getByText('Restablecer clave'));

    expect(view.getByTestId('reset-password-input').props.secureTextEntry).toBe(true);
    fireEvent.press(view.getByTestId('reset-password-toggle'));
    expect(view.getByTestId('reset-password-input').props.secureTextEntry).toBe(false);
  });

  it('shows a taken username inside the add form, in Spanish', async () => {
    (auth.adminCreateOperator as jest.Mock).mockRejectedValue({
      message: 'A user with this email address has already been registered',
    });
    const view = await renderWithOperator();
    fireEvent.press(view.getByText('+ Agregar'));
    fireEvent.changeText(view.getByPlaceholderText('Nombre completo del operador'), 'Beto Operador');
    fireEvent.changeText(view.getByPlaceholderText('Usuario para iniciar sesión'), 'ana');
    fireEvent.changeText(view.getByPlaceholderText('Contraseña inicial'), 'clave-segura-123');
    fireEvent.press(view.getByText('Agregar'));

    await waitFor(() => expect(view.getByText('Ya existe un operador con ese usuario.')).toBeTruthy());
    expect(showSheet).not.toHaveBeenCalledWith('Error al agregar operador', expect.anything());
  });

  it('names the closing assignment when a delete is refused', async () => {
    (operatorsApi.deleteUnusedOperator as jest.Mock).mockRejectedValue({
      message: 'Ese operador tiene registros asociados y no puede eliminarse. Usá Desactivar.',
    });
    const view = await renderWithOperator();

    // The delete button names the operator it deletes.
    fireEvent.press(view.getByLabelText('Eliminar a Ana Operadora'));
    const buttons = (showSheet as jest.Mock).mock.calls.at(-1)[2];
    buttons[1].onPress();

    await waitFor(() => expect(showSheet).toHaveBeenCalledWith(
      'No se pudo eliminar',
      expect.stringContaining('operador de cierre'),
    ));
  });

  it('treats a password that changed but whose sessions did not close as a reset with a warning', async () => {
    (adminResetOperatorPassword as jest.Mock).mockRejectedValue(
      new Error('Contrasena actualizada, pero no se pudieron cerrar las sesiones abiertas'),
    );
    const view = await renderWithOperator();
    fireEvent.press(view.getByText('Restablecer clave'));
    fireEvent.changeText(view.getByTestId('reset-password-input'), 'clave-nueva-123');
    fireEvent.press(view.getByText('Confirmar nueva contraseña'));

    await waitFor(() => expect(showSheet).toHaveBeenCalledWith(
      'Contraseña actualizada',
      expect.stringContaining('no se pudieron cerrar'),
    ));
    expect(showSheet).not.toHaveBeenCalledWith('Error', expect.anything());
  });
});
