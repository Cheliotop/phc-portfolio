/**
 * ADM-2: signing a Ficha completes the well and can't be undone, and the mobile
 * card only shows legacy fields — no v2 values, corrections or discrepancies.
 * Signing therefore happens in the web admin; this tab only lists Fichas.
 */
import { render } from '@testing-library/react-native';
import React from 'react';

const mockSign = jest.fn();
const mockGetAll = jest.fn();

jest.mock('../src/components/shared/Sheet', () => ({ showSheet: jest.fn() }));
jest.mock('../src/api/supabase-completion', () => ({
  completionApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    signAndComplete: (...args: any[]) => mockSign(...args),
  },
}));

import CompletionReportsTab from '../src/components/admin/CompletionReportsTab';

const report = (id: number, name: string, status = 'submitted') => ({
  id, project_id: id, status, admin_signature: null, projects: { name }, profiles: { full_name: 'Ana' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAll.mockResolvedValue({ data: [report(1, 'Pozo Norte'), report(2, 'Pozo Sur', 'returned')] });
  mockSign.mockResolvedValue({});
});

it('offers no signature action and points the admin to the web panel', async () => {
  const screen = render(<CompletionReportsTab />);
  await screen.findByText('Pozo Norte');

  expect(screen.queryByText('Firmar como admin')).toBeNull();
  expect(screen.queryByText(/^Firmar/)).toBeNull();
  expect(screen.queryByPlaceholderText('Nombre y aclaración del administrador')).toBeNull();
  expect(screen.getAllByText('Revisá y firmá la Ficha desde el panel web.')).toHaveLength(2);
  expect(mockSign).not.toHaveBeenCalled();
});

it('keeps the Fichas readable, including one sent back to the operator', async () => {
  const screen = render(<CompletionReportsTab />);
  await screen.findByText('Pozo Sur');

  expect(screen.getByText('Pozo Norte')).toBeTruthy();
  expect(screen.getByText('Pozo Sur')).toBeTruthy();
  expect(screen.getByText(/Devuelta al operador/)).toBeTruthy();
  expect(screen.getByText(/Enviado \(pendiente de firma\)/)).toBeTruthy();
  expect(screen.getAllByText(/Firma admin:/).length).toBeGreaterThan(0);
});
