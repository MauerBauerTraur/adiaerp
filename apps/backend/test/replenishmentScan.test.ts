/**
 * Worker-level test for `runOneCycle()` — the function the cron job invokes.
 *
 * Two branches must be covered:
 *   1. happy path — `runEngineCycle()` resolves; if any work was done a
 *      single line is logged (visibility for the ops dashboard);
 *   2. error path — `runEngineCycle()` rejects; the error is SWALLOWED and
 *      logged so the cron stays alive for the next 5-minute tick.
 *
 * Both branches mock `runEngineCycle` via `vi.mock` so the test stays purely
 * a unit test and does not depend on the test database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEngineCycle } from '../src/services/replenishment.js';
import { cronGuard, runOneCycle } from '../src/workers/replenishmentScan.js';

vi.mock('../src/services/replenishment.js', () => ({
  // Mocked spy — every test sets its own behaviour via mockResolvedValueOnce
  // or mockRejectedValueOnce, keeping the suite self-contained.
  runEngineCycle: vi.fn(),
}));

const mockedRunEngineCycle = vi.mocked(runEngineCycle);

describe('runOneCycle (replenishment-scan worker)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedRunEngineCycle.mockReset();
    // Reset the module-scope re-entrancy flag between tests — otherwise a
    // mid-run failure could leak `running = true` into the next case.
    cronGuard.running = false;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs a summary line when the cycle did at least one thing', async () => {
    mockedRunEngineCycle.mockResolvedValueOnce({ scanned: 3, created: 1, advanced: 2 });

    await runOneCycle();

    expect(mockedRunEngineCycle).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[replenishment-scan]');
    expect(line).toContain('scanned=3');
    expect(line).toContain('created=1');
    expect(line).toContain('advanced=2');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('stays silent when the cycle did nothing (no noisy logs)', async () => {
    mockedRunEngineCycle.mockResolvedValueOnce({ scanned: 0, created: 0, advanced: 0 });

    await runOneCycle();

    expect(mockedRunEngineCycle).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('swallows and logs an error so the cron keeps ticking', async () => {
    mockedRunEngineCycle.mockRejectedValueOnce(new Error('boom'));

    // The promise MUST resolve — if it rejected, node-cron would surface an
    // unhandled rejection and the next 5-minute tick could be skipped.
    await expect(runOneCycle()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[replenishment-scan] cycle failed');
    const reason = String(errorSpy.mock.calls[0]?.[1] ?? '');
    expect(reason).toContain('boom');
  });

  it('skips overlapping ticks — only one cycle runs at a time (C3)', async () => {
    // Make the first cycle take a measurable, controlled amount of time.
    // While it is still running, fire a second `runOneCycle()` and check
    // that the second call is skipped instead of starting a parallel
    // `runEngineCycle()` (which would duplicate replenishment work).
    let resolveFirst!: () => void;
    mockedRunEngineCycle.mockImplementationOnce(
      () =>
        new Promise<{ scanned: number; created: number; advanced: number }>((resolve) => {
          resolveFirst = () => resolve({ scanned: 0, created: 0, advanced: 0 });
        }),
    );

    const firstCall = runOneCycle();
    // Yield to the event loop so the guard flips to `running`.
    await Promise.resolve();
    expect(cronGuard.running).toBe(true);

    const secondCall = runOneCycle();
    await secondCall;
    // The second call must NOT have invoked `runEngineCycle` again.
    expect(mockedRunEngineCycle).toHaveBeenCalledTimes(1);
    const skipLine = (logSpy.mock.calls.find((c) => String(c[0] ?? '').includes('skipping')) ?? [])[0];
    expect(String(skipLine ?? '')).toContain('previous cycle still running');

    // Let the first cycle finish.
    resolveFirst();
    await firstCall;
    expect(cronGuard.running).toBe(false);
  });

  it('after a cycle completes the next tick may run again', async () => {
    mockedRunEngineCycle.mockResolvedValueOnce({ scanned: 0, created: 0, advanced: 0 });
    await runOneCycle();
    expect(cronGuard.running).toBe(false);

    // The next tick still works — the flag was correctly released.
    mockedRunEngineCycle.mockResolvedValueOnce({ scanned: 1, created: 0, advanced: 0 });
    await runOneCycle();
    expect(mockedRunEngineCycle).toHaveBeenCalledTimes(2);
  });

  it('releases the guard even when the cycle throws', async () => {
    mockedRunEngineCycle.mockRejectedValueOnce(new Error('boom2'));
    await runOneCycle();
    expect(cronGuard.running).toBe(false);
  });
});
