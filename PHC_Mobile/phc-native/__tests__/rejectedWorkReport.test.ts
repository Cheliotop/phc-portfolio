const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockReport = jest.fn();
const mockGetOwner = jest.fn();
const mockArchive = jest.fn();

jest.mock('../src/db/db', () => ({
  execute: (...args: any[]) => mockExecute(...args),
  query: (...args: any[]) => mockQuery(...args),
}));
jest.mock('../src/api/supabase-rejected-work', () => ({
  rejectedWorkApi: { report: (...args: any[]) => mockReport(...args) },
}));
jest.mock('../src/sync/outboxOwner', () => ({
  getOutboxOwner: () => mockGetOwner(),
  archiveRejectedRows: (...args: any[]) => mockArchive(...args),
}));

import { reportRejectedWork } from '../src/sync/rejectedWorkReport';

const row = (id: string, owner = 'operator-a', payload = '{"project_id":7}') => ({
  id,
  owner_id: owner,
  entity: 'drilling_bar',
  entity_id: 'bar-1',
  op: 'UPSERT',
  payload_json: payload,
  last_error: 'denied (42501)',
  rejected_at: '2026-11-05T10:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwner.mockResolvedValue('operator-b');
  mockExecute.mockResolvedValue({ changes: 1 });
  mockQuery.mockResolvedValue([]);
  mockReport.mockResolvedValue(1);
  mockArchive.mockResolvedValue(undefined);
});

it('copies rejected rows from the queue before reading what to send', async () => {
  await reportRejectedWork();

  expect(mockArchive).toHaveBeenCalledWith('operator-b', expect.any(Function));
  expect(mockArchive.mock.invocationCallOrder[0]).toBeLessThan(mockQuery.mock.invocationCallOrder[0]);
});

it('reports work under the operator it belongs to, not whoever is signed in', async () => {
  mockQuery.mockResolvedValue([row('outbox-1', 'operator-a')]);

  await expect(reportRejectedWork()).resolves.toBe(1);

  expect(mockReport).toHaveBeenCalledWith(expect.objectContaining({
    clientEntryId: 'outbox-1',
    operatorId: 'operator-a',
    payload: { project_id: 7 },
    rejectionReason: 'denied (42501)',
  }));
  expect(mockExecute).toHaveBeenCalledWith(
    expect.stringMatching(/UPDATE rejected_work SET uploaded_at/),
    [expect.any(String), 'outbox-1'],
  );
});

it('only marks what the server received, and carries on after a failure', async () => {
  mockQuery.mockResolvedValue([row('fails'), row('works')]);
  mockReport.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(2);

  await expect(reportRejectedWork()).resolves.toBe(1);

  expect(mockExecute).toHaveBeenCalledTimes(1);
  expect(mockExecute.mock.calls[0][1][1]).toBe('works');
});

it('still reports a row whose stored payload cannot be read', async () => {
  mockQuery.mockResolvedValue([row('broken', 'operator-a', '{not json')]);

  await reportRejectedWork();

  expect(mockReport.mock.calls[0][0].payload).toEqual({ unreadable: '{not json' });
});

it('does not archive when nobody owns the queue yet', async () => {
  mockGetOwner.mockResolvedValue(null);

  await reportRejectedWork();

  expect(mockArchive).not.toHaveBeenCalled();
});

describe('the reason the admin reads (code read W7)', () => {
  const { rejectionReasonText, rejectedWorkDetails } = require('../src/domain/rejectedWork');

  it('translates a known server refusal', () => {
    expect(rejectionReasonText('Access denied to this project (42501)'))
      .toBe('El operador ya no estaba asignado a este pozo.');
  });

  it('reads the Spanish server wording (2026-11-10) as well as the old English one', () => {
    for (const raw of [
      'Offline drilling evidence cannot be added after Ficha submission (55000)',
      'No se pueden agregar barras sin conexión después de enviar la Ficha (55000)',
    ]) expect(rejectionReasonText(raw)).toBe('La Ficha del pozo ya se había enviado.');
    for (const raw of [
      'A closed shift must have its usage report before offline evidence can replay (55000)',
      'El turno cerrado necesita su informe de consumo antes de reenviar barras sin conexión (55000)',
    ]) expect(rejectionReasonText(raw)).toBe('El turno ya estaba cerrado sin informe.');
  });

  it('drops the code and the stack from anything else', () => {
    expect(rejectionReasonText('Algo raro pasó (P0001)')).toBe('Algo raro pasó');
    expect(rejectionReasonText('TypeError: boom\n    at x (bundle:1:2)')).toBe('boom');
    expect(rejectionReasonText(null)).toBe('No indicado');
  });

  it('shows a shift start in local time', () => {
    expect(rejectedWorkDetails({ startedAt: '2026-11-07T13:05:00.000Z' })).toEqual(['Inicio: 07/11/2026 10:05']);
  });
});
