import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '@/lib/api-client';

interface ApiQueryState<T> {
  data: T | null;
  /** True while the first or a refetch request is in flight. */
  isLoading: boolean;
  /** Localized error message, or null. */
  error: string | null;
  /** Re-run the request. */
  refetch: () => void;
}

/**
 * Minimal data-fetching hook for GET endpoints. Cancels in-flight
 * requests on unmount or path change to avoid setting state on an
 * unmounted component. No caching — Faza-1 keeps the data layer simple.
 *
 * @param path  API path; pass `null` to skip the request entirely.
 */
export function useApiQuery<T>(path: string | null): ApiQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);

    apiRequest<T>(path, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          err instanceof ApiError
            ? err.message
            : 'Ma’lumotni yuklab bo‘lmadi.';
        setError(message);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [path, reloadKey]);

  return { data, isLoading, error, refetch };
}
