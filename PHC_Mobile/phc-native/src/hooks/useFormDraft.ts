/**
 * Keeps a half-finished form.
 *
 * Every form in this app was all-or-nothing: close it, lose it. That is a bad
 * trade anywhere and a terrible one here, where the phone is used outdoors on
 * battery, work interrupts constantly, and the longest form is 26 fields.
 *
 * We could not establish whether these are filled in one sitting or across a
 * day — the person who knows is the operator, not the person building it. So
 * this is deliberately safe under either answer: if it is one sitting the
 * draft costs nothing and is never seen, and if it is not, nothing is lost.
 *
 * Drafts are local only. They are not evidence and never sync; the record is
 * created when the form is submitted, exactly as before.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'phc.draft.';
/** Long enough that yesterday's abandoned draft does not reappear as today's. */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 3;

interface StoredDraft<T> {
  savedAt: number;
  values: T;
  /** Which server version this draft was written against. See `scope` below. */
  scope?: string;
}

export interface FormDraft<T> {
  /** True until the stored draft has been read; render the form disabled meanwhile. */
  loading: boolean;
  /** A draft was found and restored, so the UI can say so rather than silently refilling. */
  restored: boolean;
  /** Persist the current values. Safe to call on every keystroke; writes are debounced. */
  save: (values: T) => void;
  /** Drop the draft. Call after a successful submit, never before. */
  clear: () => Promise<void>;
  /** The restored values, or null when there was nothing to restore. */
  initial: T | null;
}

/**
 * @param key    stable per form and per subject, e.g. `ficha:42`. A draft for
 *               one well must never be restored into another.
 * @param enabled pass false while the form has nothing worth keeping.
 * @param scope  identity of the server version the draft was written against.
 *
 * `scope` settles the draft-versus-server question. A form that prefills from
 * the server — Ficha does, when a report is returned for correction — has two
 * candidate sources of truth, and picking wrong either discards the operator's
 * corrections or hides the fact that administration returned it again with new
 * discrepancies.
 *
 * Passing the server version's identity makes the rule mechanical: the draft is
 * only restored when it was written against exactly the state now on screen.
 * If the server has moved on since, the draft is stale and is dropped. This is
 * deliberately not a timestamp comparison, which a field phone with a wrong
 * clock could defeat.
 */
export function useFormDraft<T extends object>(key: string, enabled = true, scope?: string): FormDraft<T> {
  const storageKey = `${PREFIX}${key}`;
  // What was read, and for which key and server version. `loading` is worked out
  // during render from this, not set by an effect: on the render where the key,
  // the version or `enabled` changes, it is already true. Set from an effect, the
  // form saw one render of "not loading" with the old values and filled itself
  // before the draft was read, so the draft was never applied.
  const identity = `${storageKey}\u0000${scope ?? ''}`;
  const [read, setRead] = useState<{ identity: string; initial: T | null; restored: boolean } | null>(null);
  const current = enabled && read?.identity === identity ? read : null;
  const loading = enabled && !current;
  const initial = current?.initial ?? null;
  const restored = Boolean(current?.restored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      let values: T | null = null;
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (cancelled) return;
        if (raw) {
          const parsed = JSON.parse(raw) as StoredDraft<T>;
          const fresh = Date.now() - parsed.savedAt <= MAX_AGE_MS;
          const sameServerVersion = scope === undefined || parsed.scope === scope;
          if (fresh && sameServerVersion) {
            values = parsed.values;
          } else {
            // Either too old to trust, or written against a server state that
            // has since changed. Both mean the form should start from the
            // server rather than from this.
            await AsyncStorage.removeItem(storageKey);
          }
        }
      } catch {
        // A corrupt draft must never block the form. Start clean instead.
        await AsyncStorage.removeItem(storageKey).catch(() => undefined);
      } finally {
        if (!cancelled) setRead({ identity, initial: values, restored: values !== null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storageKey, enabled, scope, identity]);

  // Debounced: called per keystroke, but writing on every character would put
  // the form's typing latency at the mercy of disk speed.
  const save = useCallback((values: T) => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void AsyncStorage.setItem(
        storageKey,
        JSON.stringify({ savedAt: Date.now(), values, scope } satisfies StoredDraft<T>),
      ).catch(() => undefined);
    }, 600);
  }, [storageKey, enabled, scope]);

  const clear = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    setRead((previous) => (previous ? { ...previous, restored: false } : previous));
    await AsyncStorage.removeItem(storageKey).catch(() => undefined);
  }, [storageKey]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { loading, restored, save, clear, initial };
}
