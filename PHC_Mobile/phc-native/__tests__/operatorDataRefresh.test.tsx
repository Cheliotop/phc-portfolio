import React from 'react';
import { View } from 'react-native';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { notifyOperatorDataChanged } from '../src/events/operatorDataEvents';
import { useOperatorDataRefresh } from '../src/hooks/useOperatorDataRefresh';

let mockIsFocused = true;

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockIsFocused,
}));

const Probe = ({ refresh }: { refresh: () => void | Promise<void> }) => {
  useOperatorDataRefresh(refresh);
  return <View testID="probe" />;
};

describe('useOperatorDataRefresh', () => {
  beforeEach(() => {
    mockIsFocused = true;
  });

  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it('loads on first focus and refreshes on refocus', async () => {
    const refresh = jest.fn();
    const screen = render(<Probe refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    mockIsFocused = false;
    screen.rerender(<Probe refresh={refresh} />);
    mockIsFocused = true;
    screen.rerender(<Probe refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('refreshes the visible tab after a background sync changes operator data', async () => {
    const refresh = jest.fn();
    render(<Probe refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    act(() => notifyOperatorDataChanged());

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('queues one post-sync refresh when the initial load is still running', async () => {
    let finishInitialLoad: (() => void) | undefined;
    const refresh = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishInitialLoad = resolve;
      }))
      .mockResolvedValue(undefined);
    render(<Probe refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    act(() => notifyOperatorDataChanged());
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => finishInitialLoad?.());

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('defers a background-sync refresh while blurred until the tab is focused', async () => {
    const refresh = jest.fn();
    const screen = render(<Probe refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    mockIsFocused = false;
    screen.rerender(<Probe refresh={refresh} />);
    act(() => notifyOperatorDataChanged());
    expect(refresh).toHaveBeenCalledTimes(1);

    mockIsFocused = true;
    screen.rerender(<Probe refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });
});
