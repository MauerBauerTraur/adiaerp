import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { RecipeAuditJob, RecipeAuditState } from '@/lib/types';
import { normalizeState } from './recipeAuditModel';

export const RECIPE_AUDIT_API = '/api/integrations/poster/recipe-audit';

/** How often the running job is re-read. */
export const RECIPE_AUDIT_POLL_MS = 2000;

export interface RecipeAuditQuery {
  /** Last full state; `null` until the first load succeeds. */
  state: RecipeAuditState | null;
  /** True only for the first load. */
  isLoading: boolean;
  /**
   * Last fetch error. With no `state` yet it is a load failure; otherwise the
   * last good state stays on screen and polling keeps retrying.
   */
  error: string | null;
  isRunning: boolean;
  reload: () => void;
  /** Show a job the server just started (POST run/apply/restore) and poll it. */
  adoptJob: (job: RecipeAuditJob) => void;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : "Ma'lumotni yuklab bo'lmadi.";
}

/**
 * The full GET /recipe-audit (reports + restore info) is read on open and
 * once after a job ends. While a job runs only the light GET /recipe-audit/job
 * is polled, every `pollMs`, each poll scheduled after the previous one
 * settles. A finished job keeps showing as running until the full state
 * arrives, so its outcome is never paired with the previous report.
 */
export function useRecipeAudit(pollMs: number = RECIPE_AUDIT_POLL_MS): RecipeAuditQuery {
  const [state, setState] = useState<RecipeAuditState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullKey, setFullKey] = useState(0);
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<Partial<RecipeAuditState>>(RECIPE_AUDIT_API, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState(normalizeState(data));
        setError(null);
        // Re-arm the poll loop in case the job is (still) running.
        setPollTick((t) => t + 1);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(messageOf(err));
        // If a job is still shown as running, the poll loop retries this.
        setPollTick((t) => t + 1);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [fullKey]);

  const isRunning = state?.job?.status === 'running';

  useEffect(() => {
    if (!isRunning) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      apiRequest<{ job: RecipeAuditJob | null }>(`${RECIPE_AUDIT_API}/job`, {
        signal: controller.signal,
      })
        .then(({ job }) => {
          if (controller.signal.aborted) return;
          setError(null);
          if (job !== null && job.status === 'running') {
            setState((prev) => (prev === null ? prev : { ...prev, job }));
            setPollTick((t) => t + 1);
          } else {
            // Finished: read reports + restore info once, together with it.
            setFullKey((k) => k + 1);
          }
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(messageOf(err));
          setPollTick((t) => t + 1);
        });
    }, pollMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isRunning, pollTick, pollMs]);

  const reload = useCallback(() => setFullKey((k) => k + 1), []);

  const adoptJob = useCallback((job: RecipeAuditJob) => {
    setState((prev) => ({ ...normalizeState(prev ?? {}), job }));
    setError(null);
    if (job.status !== 'running') setFullKey((k) => k + 1);
  }, []);

  return { state, isLoading, error, isRunning, reload, adoptJob };
}
