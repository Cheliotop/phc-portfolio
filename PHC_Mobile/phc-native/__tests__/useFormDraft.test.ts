/**
 * Draft persistence rules.
 *
 * These are the ones that hurt if they are wrong: a draft restored into the
 * wrong well would put one pozo's measurements onto another's certificate, and
 * a draft that survives submission would refill a form the operator already
 * sent.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useFormDraft } from '../src/hooks/useFormDraft';

describe('useFormDraft', () => {
  beforeEach(async () => {
    jest.useRealTimers();
    await AsyncStorage.clear();
  });

  it('reports nothing to restore on a clean form', async () => {
    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.restored).toBe(false);
    expect(result.current.initial).toBeNull();
  });

  it('restores what was typed before the form was closed', async () => {
    await AsyncStorage.setItem(
      'phc.draft.ficha:42',
      JSON.stringify({ savedAt: Date.now(), values: { depth: '60' } }),
    );

    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:42'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.restored).toBe(true);
    expect(result.current.initial).toEqual({ depth: '60' });
  });

  it('never restores one well\'s draft into another', async () => {
    await AsyncStorage.setItem(
      'phc.draft.ficha:42',
      JSON.stringify({ savedAt: Date.now(), values: { depth: '60' } }),
    );

    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:43'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.initial).toBeNull();
  });

  it('discards a draft that is too old to trust', async () => {
    const fourDaysAgo = Date.now() - 1000 * 60 * 60 * 24 * 4;
    await AsyncStorage.setItem(
      'phc.draft.ficha:42',
      JSON.stringify({ savedAt: fourDaysAgo, values: { depth: '60' } }),
    );

    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:42'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.restored).toBe(false);
    expect(await AsyncStorage.getItem('phc.draft.ficha:42')).toBeNull();
  });

  it('starts clean rather than blocking on a corrupt draft', async () => {
    await AsyncStorage.setItem('phc.draft.ficha:42', 'not json at all');

    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:42'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.initial).toBeNull();
  });

  it('writes after typing settles', async () => {
    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:7'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.save({ depth: '12' }));
    await waitFor(async () => {
      expect(await AsyncStorage.getItem('phc.draft.ficha:7')).toContain('"depth":"12"');
    });
  });

  it('restores a draft written against the same server version', async () => {
    await AsyncStorage.setItem('phc.draft.ficha:42', JSON.stringify({
      savedAt: Date.now(), values: { depth: '60' }, scope: '42:7:returned-at-monday',
    }));

    const { result } = renderHook(() =>
      useFormDraft<{ depth: string }>('ficha:42', true, '42:7:returned-at-monday'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.initial).toEqual({ depth: '60' });
  });

  it('drops a draft when the server version has moved on', async () => {
    // Administration returned the Ficha again after this draft was written, so
    // it predates discrepancies the operator has not seen. Restoring it would
    // hide them behind their own older numbers.
    await AsyncStorage.setItem('phc.draft.ficha:42', JSON.stringify({
      savedAt: Date.now(), values: { depth: '60' }, scope: '42:7:returned-at-monday',
    }));

    const { result } = renderHook(() =>
      useFormDraft<{ depth: string }>('ficha:42', true, '42:7:returned-at-tuesday'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.restored).toBe(false);
    expect(result.current.initial).toBeNull();
    expect(await AsyncStorage.getItem('phc.draft.ficha:42')).toBeNull();
  });

  it('records the server version it was written against', async () => {
    const { result } = renderHook(() =>
      useFormDraft<{ depth: string }>('ficha:9', true, '9:3:new'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.save({ depth: '12' }));
    await waitFor(async () => {
      expect(await AsyncStorage.getItem('phc.draft.ficha:9')).toContain('"scope":"9:3:new"');
    });
  });

  it('clears the draft so a sent form is not refilled', async () => {
    const { result } = renderHook(() => useFormDraft<{ depth: string }>('ficha:7'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.save({ depth: '12' }));
    await waitFor(async () => {
      expect(await AsyncStorage.getItem('phc.draft.ficha:7')).not.toBeNull();
    });

    await act(async () => {
      await result.current.clear();
    });

    expect(await AsyncStorage.getItem('phc.draft.ficha:7')).toBeNull();
  });
});
