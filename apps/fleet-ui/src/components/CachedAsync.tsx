/**
 * `useCachedList` — `useAsync` with a global memory cache, keyed by a
 * caller-supplied string. Navigation back to a previously-loaded list
 * shows the cached data instantly while a fresh fetch happens in the
 * background.
 *
 * Tradeoffs vs. plain `useAsync`:
 *   - Stale-while-revalidate: the cached data is returned even while
 *     a refetch is in flight. The hook exposes `loading: true` while
 *     refetching so callers can show a subtle spinner if they want.
 *   - Same key in two components → they share the same cached entry.
 *     This is the desired behavior 99% of the time (e.g. nav badge
 *     + page table both read the pipelines list).
 *   - Mutations elsewhere should call `invalidateCache(key)` to force
 *     a refresh; the hook auto-refetches on next mount otherwise.
 *
 * Not used: TanStack Query. We have ~6 list endpoints and one user;
 * the lib's complexity isn't justified yet. If we add many more
 * endpoints or background polling we should swap to it.
 */
import { useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { useCacheStore } from "@/store/cache";
import type { AsyncState } from "@/components/Async";

export function useCachedList<T>(
  cacheKey: string,
  fn: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> {
  const cached = useCacheStore((s) => s.entries[cacheKey]);
  const setCache = useCacheStore((s) => s.set);
  const initialData = (cached?.data as T | undefined) ?? null;

  const [data, setData] = useState<T | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(initialData === null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // If we have a cached value, keep showing it; the fetch is a
    // background refresh. If not, hide the (null) data and show the
    // loading skeleton.
    setLoading(true);
    setError(null);
    fn()
      .then((v) => {
        if (cancelled) return;
        setData(v);
        setCache(cacheKey, v);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError("Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, ...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
