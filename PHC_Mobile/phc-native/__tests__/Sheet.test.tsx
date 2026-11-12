/**
 * The sheet replaces 135 `Alert.alert` calls, so it has to behave like Alert in
 * every way those call sites depend on — otherwise a mechanical migration
 * changes behaviour silently across the whole app.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { SheetHost, showSheet } from '../src/components/shared/Sheet';

describe('Sheet', () => {
  it('keeps its actions clear of the navigation bar', async () => {
    const { getByTestId } = render(
      <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 48, left: 0 }}>
        <SheetHost />
      </SafeAreaInsetsContext.Provider>,
    );

    act(() => showSheet('Listo', 'Guardado'));

    await waitFor(() => expect(getByTestId('sheet-panel')).toBeTruthy());
    expect(StyleSheet.flatten(getByTestId('sheet-panel').props.style).paddingBottom).toBe(24 + 48);
  });

  it('still opens with no safe area information', async () => {
    const { getByTestId } = render(<SheetHost />);

    act(() => showSheet('Listo', 'Guardado'));

    await waitFor(() => expect(getByTestId('sheet-panel')).toBeTruthy());
    expect(StyleSheet.flatten(getByTestId('sheet-panel').props.style).paddingBottom).toBe(24);
  });

  it('shows a title and message like Alert.alert does', async () => {
    const { getByText } = render(<SheetHost />);

    act(() => showSheet('Listo', 'Contraseña actualizada correctamente'));

    await waitFor(() => expect(getByText('Listo')).toBeTruthy());
    expect(getByText('Contraseña actualizada correctamente')).toBeTruthy();
  });

  it('supplies a dismiss action when the caller gave no buttons', async () => {
    // 97 of the 135 call sites pass only a title and message. Alert gives those
    // an OK button for free; without this they would be undismissable.
    const { getByText } = render(<SheetHost />);

    act(() => showSheet('Error', 'No se pudo guardar'));

    await waitFor(() => expect(getByText('Entendido')).toBeTruthy());
  });

  it('runs the pressed button and closes', async () => {
    const onPress = jest.fn();
    const { getByText, queryByText } = render(<SheetHost />);

    act(() => showSheet('Confirmar', undefined, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sí, cerrar', style: 'destructive', onPress },
    ]));

    await waitFor(() => expect(getByText('Sí, cerrar')).toBeTruthy());
    fireEvent.press(getByText('Sí, cerrar'));

    expect(onPress).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(queryByText('Sí, cerrar')).toBeNull());
  });

  it('closes without running anything when cancelled', async () => {
    const onPress = jest.fn();
    const { getByText, queryByText } = render(<SheetHost />);

    act(() => showSheet('Cerrar Sesión', '¿Estás seguro?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sí', onPress },
    ]));

    await waitFor(() => expect(getByText('Cancelar')).toBeTruthy());
    fireEvent.press(getByText('Cancelar'));

    expect(onPress).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByText('Cancelar')).toBeNull());
  });

  it('shows a sheet raised before the host mounted', async () => {
    // The api layer can raise an error during startup, before the tree exists.
    // Alert handles that; dropping the message would lose real failures.
    act(() => showSheet('Sin conexión', 'Reintentando…'));

    const { getByText } = render(<SheetHost />);

    await waitFor(() => expect(getByText('Sin conexión')).toBeTruthy());
  });

  it('buzzes according to what it is announcing', async () => {
    const Haptics = require('expo-haptics');
    const { getByText } = render(<SheetHost />);

    act(() => showSheet('Error', 'No se pudo guardar'));
    await waitFor(() => expect(getByText('Error')).toBeTruthy());
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('error');

    fireEvent.press(getByText('Entendido'));
    act(() => showSheet('Listo', 'Guardado'));
    await waitFor(() => expect(getByText('Listo')).toBeTruthy());
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  });
});
