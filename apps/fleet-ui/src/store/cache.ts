/**
 * Tiny list-cache store.
 *
 * Used by `useCachedList` to keep the last successful response for a
 * keyed list around in memory. The point isn't to be a full
 * data-fetching layer (react-query / TanStack Query do that better) —
 * it's to make navigation feel instant: when you go Pipelines → detail
 * → back, the list is right there from cache while a fresh fetch
 * happens in the background.
 *
 * Cache lifecycle:
 *   - Store is global (one entry per `cacheKey`).
 *   - Lives in memory only — refresh the page and it's gone. That's
 *     fine; localStorage caching is an over-correction for short data.
 *   - Each entry tracks `data` + `fetchedAt`. Invalidation = setting
 *     `data` to undefined (forces the next read to refetch).
 *
 * The stored values are typed as `unknown` at the store boundary; the
 * `useCachedList<T>` hook reapplies the type guarantee at the
 * call site. `unknown` keeps the store keys cross-type without the
 * complexity of a generic Zustand store.
 */
import { create } from "zustand";

interface CacheEntry {
  /** undefined = empty / invalidated; null is reserved for "fetched and explicitly empty" if a caller wants that. */
  data: unknown | undefined;
  /** ms since epoch of the last successful fetch. 0 when entry is empty. */
  fetchedAt: number;
}

interface CacheState {
  entries: Record<string, CacheEntry | undefined>;
  /** Replace an entry's data with a fresh fetch. */
  set: (key: string, data: unknown) => void;
  /** Drop a single key (forces refetch on next read). */
  invalidate: (key: string) => void;
  /** Drop everything. Useful on sign-out. */
  clear: () => void;
}

export const useCacheStore = create<CacheState>((set) => ({
  entries: {},
  set: (key, data) =>
    set((s) => ({
      entries: { ...s.entries, [key]: { data, fetchedAt: Date.now() } },
    })),
  invalidate: (key) =>
    set((s) => {
      if (!s.entries[key]) return s;
      const next = { ...s.entries };
      delete next[key];
      return { entries: next };
    }),
  clear: () => set({ entries: {} }),
}));

/** Imperative invalidation, e.g. after a mutation. */
export function invalidateCache(key: string): void {
  useCacheStore.getState().invalidate(key);
}
