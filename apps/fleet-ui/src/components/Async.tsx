import { useEffect, useState } from "react";
import { ApiError } from "@/api/client";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Minimal data-fetching hook. We deliberately avoid pulling in a full
 * data-fetching library (react-query et al) for MVP — the app is small and
 * the logic here fits in 30 lines.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((v) => {
        if (!cancelled) setData(v);
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
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export function AsyncBoundary<T>({
  state,
  children,
}: {
  state: AsyncState<T>;
  children: (value: T) => React.ReactNode;
}) {
  if (state.loading && state.data === null) {
    return <div className="text-sm text-muted py-12 text-center">Loading…</div>;
  }
  if (state.error) {
    return (
      <div className="card p-6 text-sm">
        <div className="text-danger font-medium">Error</div>
        <div className="text-muted mt-1">{state.error}</div>
        <button className="btn mt-3" onClick={state.reload}>
          Retry
        </button>
      </div>
    );
  }
  if (state.data === null) return null;
  return <>{children(state.data)}</>;
}
