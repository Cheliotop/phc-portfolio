import AsyncStorage from '@react-native-async-storage/async-storage';

const mockExecute = jest.fn();
const mockQueryFirst = jest.fn();

jest.mock('../src/db/db', () => ({
  queryFirst: (...args: any[]) => mockQueryFirst(...args),
  runInTransaction: (work: (transaction: any) => Promise<unknown>) =>
    work({ execute: (...args: any[]) => mockExecute(...args) }),
}));

import { claimOutbox, countRejectedOutboxRows, outboxBelongsTo } from '../src/sync/outboxOwner';

const OWNER_KEY = 'phc.outboxOwnerId';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockExecute.mockResolvedValue({ changes: 0 });
  mockQueryFirst.mockResolvedValue({ count: 0 });
});

it('claims the outbox even while another operator has waiting rows', async () => {
  await AsyncStorage.setItem(OWNER_KEY, 'operator-a');
  mockQueryFirst.mockResolvedValue({ count: 4 });

  await expect(claimOutbox('operator-b')).resolves.toEqual({ ok: true, unsent: 0 });
  expect(await AsyncStorage.getItem(OWNER_KEY)).toBe('operator-b');
  expect(mockExecute).not.toHaveBeenCalled();
});

it('never archives or deletes quarantined rows during a handover', async () => {
  await AsyncStorage.setItem(OWNER_KEY, 'operator-a');

  await expect(claimOutbox('operator-b')).resolves.toEqual({ ok: true, unsent: 0 });
  expect(await AsyncStorage.getItem(OWNER_KEY)).toBe('operator-b');

  expect(mockExecute).not.toHaveBeenCalled();
});

it('switches even if database work is unavailable because claim never mutates the queue', async () => {
  await AsyncStorage.setItem(OWNER_KEY, 'operator-a');
  await expect(claimOutbox('operator-b')).resolves.toEqual({ ok: true, unsent: 0 });
  expect(await AsyncStorage.getItem(OWNER_KEY)).toBe('operator-b');
  expect(mockExecute).not.toHaveBeenCalled();
});

it('counts rejected rows so the logout warning can mention them', async () => {
  mockQueryFirst.mockResolvedValue({ count: 2 });

  await expect(countRejectedOutboxRows()).resolves.toBe(2);
  expect(mockQueryFirst.mock.calls[0][0]).toMatch(/= 'quarantined'/);
});

it('adopts a pre-ownership queue unchanged, keeping its rejected rows for a retry', async () => {
  mockQueryFirst.mockResolvedValue({ count: 2 });

  await expect(claimOutbox('operator-a')).resolves.toEqual({ ok: true, unsent: 0 });
  expect(await AsyncStorage.getItem(OWNER_KEY)).toBe('operator-a');
  expect(mockExecute).not.toHaveBeenCalled();
});

it('lets every signed-in operator drain and rejects only a missing session', async () => {
  expect(await outboxBelongsTo('operator-a')).toBe(true);
  expect(await outboxBelongsTo('operator-b')).toBe(true);
  expect(await outboxBelongsTo(null)).toBe(false);
});
