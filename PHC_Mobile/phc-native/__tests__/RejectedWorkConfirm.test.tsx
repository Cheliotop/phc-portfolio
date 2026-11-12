import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { rejectedWorkApi } from '../src/api/supabase-rejected-work';
import RejectedWorkTab from '../src/components/admin/RejectedWorkTab';
import { showSheet } from '../src/components/shared/Sheet';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(callback, [callback]);
  },
}));

jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));

jest.mock('../src/api/supabase-rejected-work', () => ({
  rejectedWorkApi: {
    listPending: jest.fn(),
    decide: jest.fn(),
  },
}));

const pendingItem = {
  id: 'r1',
  entity: 'drilling_bars',
  payload: { bar_number: 4, depth_start: 12, depth_end: 15 },
  rejection_reason: null,
  rejected_at: '2026-11-08T10:00:00Z',
  sent_later_at: null,
  created_at: '2026-11-08T10:00:00Z',
  operator_id: 'op-1',
  reported_by: 'op-2',
  project_id: 7,
  operator: { username: 'ana', full_name: 'Ana' },
  project: { name: 'Pozo Sur', well_name: null },
};

describe('RejectedWorkTab confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (rejectedWorkApi.listPending as jest.Mock).mockResolvedValue([pendingItem]);
    (rejectedWorkApi.decide as jest.Mock).mockResolvedValue({});
  });

  it('asks before accepting a refused bar, and names the well and the effect', async () => {
    const { getByText, findByText } = render(<RejectedWorkTab />);
    await findByText('Pozo Sur · Ana');

    fireEvent.press(getByText('Aceptar'));

    expect(rejectedWorkApi.decide).not.toHaveBeenCalled();
    expect(showSheet).toHaveBeenCalledWith(
      'Aceptar registro',
      expect.stringContaining('Pozo Sur'),
      expect.any(Array),
    );
    const buttons = (showSheet as jest.Mock).mock.calls[0][2];
    buttons[1].onPress();
    await waitFor(() => expect(rejectedWorkApi.decide).toHaveBeenCalledWith('r1', 'accepted', undefined));
  });

  it('describes a bar sent by the other operator as a team report, not from a phone', async () => {
    const { findByText } = render(<RejectedWorkTab />);
    expect(await findByText('Lo envió otro integrante del equipo desde el dispositivo de este operador.')).toBeTruthy();
  });
});
