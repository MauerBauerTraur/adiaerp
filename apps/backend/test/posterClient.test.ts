/**
 * Unit tests for the Poster HTTP client — pure unit tests, no DB, no network.
 *
 * Covered:
 *   - response envelope unwrapping (`{ response: ... }`) and error mapping;
 *   - rate limit gate keeps two parallel calls at least `minIntervalMs` apart;
 *   - timeout aborts the fetch and surfaces a `PosterApiError`;
 *   - the token is NEVER included in thrown error messages.
 */
import { describe, expect, it } from 'vitest';
import { PosterApiError, PosterClient } from '../src/integrations/poster/client.js';

function jsonResponder(payload: unknown, status = 200): typeof fetch {
  return ((_url: unknown, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status }))) as unknown as typeof fetch;
}

describe('PosterClient', () => {
  it('unwraps response: { response: ... }', async () => {
    const client = new PosterClient({
      token: 'acc:xxx',
      fetcher: jsonResponder({ response: [{ spot_id: '1', name: 'Кукча' }] }),
      minIntervalMs: 0,
    });
    const spots = await client.getSpots();
    expect(spots).toHaveLength(1);
    expect(spots[0]?.spot_id).toBe('1');
  });

  it('maps Poster error envelope to PosterApiError with the posterCode', async () => {
    const client = new PosterClient({
      token: 'acc:xxx',
      fetcher: jsonResponder({ error: { code: 10, message: 'Access token is not defined' } }),
      minIntervalMs: 0,
    });
    await expect(client.getSpots()).rejects.toBeInstanceOf(PosterApiError);
    try {
      await client.getSpots();
    } catch (err) {
      expect((err as PosterApiError).posterCode).toBe(10);
      expect((err as Error).message).toContain('[poster:access.getSpots]');
      // CRITICAL: never leak the token to error messages.
      expect((err as Error).message).not.toContain('acc:xxx');
    }
  });

  it('keeps consecutive calls at least minIntervalMs apart (rate limit)', async () => {
    const calls: number[] = [];
    const client = new PosterClient({
      token: 'acc:xxx',
      minIntervalMs: 50,
      fetcher: ((_url: unknown) => {
        calls.push(Date.now());
        return Promise.resolve(new Response(JSON.stringify({ response: [] }), { status: 200 }));
      }) as unknown as typeof fetch,
    });
    // Three parallel calls — the gate should serialise them.
    await Promise.all([client.getSpots(), client.getSpots(), client.getSpots()]);
    expect(calls).toHaveLength(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(45);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(45);
  });

  it('translates an HTTP non-2xx into a clean PosterApiError (no token leak)', async () => {
    const client = new PosterClient({
      token: 'acc:secret-token',
      fetcher: jsonResponder({}, 502),
      minIntervalMs: 0,
    });
    await expect(client.getSpots()).rejects.toThrow(/HTTP 502/);
    try {
      await client.getSpots();
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-token');
    }
  });

  it('aborts after the timeout window', async () => {
    const client = new PosterClient({
      token: 'acc:xxx',
      minIntervalMs: 0,
      timeoutMs: 30,
      // Never resolves on its own — we rely on the AbortSignal to reject.
      fetcher: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch,
    });
    await expect(client.getSpots()).rejects.toThrow(/timed out/);
  });

  it('throws clearly when the token is empty', () => {
    expect(() => new PosterClient({ token: '   ' })).toThrow(/token is missing/);
  });

  it('getAnalytics unwraps the {data, counters} shape and passes day params', async () => {
    let seenUrl: string | undefined;
    const client = new PosterClient({
      token: 'acc:xxx',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        seenUrl = (typeof url === 'string' ? new URL(url) : url).toString();
        return Promise.resolve(
          new Response(
            JSON.stringify({
              response: {
                data: ['31059707.0000', '34788091.0000'],
                counters: { revenue: '65847798.0000', transactions: '120' },
              },
            }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch,
    });
    const a = await client.getAnalytics({
      dateFrom: '20260430',
      dateTo: '20260501',
      interpolate: 'day',
      select: 'revenue',
    });
    expect(a.data).toHaveLength(2);
    expect(a.counters?.revenue).toBe('65847798.0000');
    expect(seenUrl).toContain('dash.getAnalytics');
    expect(seenUrl).toContain('interpolate=day');
    expect(seenUrl).toContain('select=revenue');
    // Token never appears un-redacted in our own surfaces — but here we just
    // assert the request carried the right params.
    expect(seenUrl).toContain('dateFrom=20260430');
  });

  // Sprint 3 audit P2: `menu.getIngredients` surfaced as `fetch failed` on the
  // very first call after process start (Poster's cold-start is 4–5s; old 10s
  // timeout left no headroom). Fix: bump default timeout to 20s AND retry
  // ONCE on transient failures (AbortError / `fetch failed`).
  it('retries once on a transient `fetch failed` and succeeds on the second attempt', async () => {
    let attempts = 0;
    const client = new PosterClient({
      token: 'acc:xxx',
      minIntervalMs: 0,
      fetcher: ((_url: unknown) => {
        attempts += 1;
        if (attempts === 1) {
          // Mimic undici's bare network failure — no `.name = AbortError`.
          return Promise.reject(new Error('fetch failed'));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ response: [{ spot_id: '1', name: 'Кукча' }] }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });
    const spots = await client.getSpots();
    expect(attempts).toBe(2);
    expect(spots).toHaveLength(1);
  });

  it('retries once on AbortError (cold-start timeout) and succeeds on the second attempt', async () => {
    let attempts = 0;
    const client = new PosterClient({
      token: 'acc:xxx',
      minIntervalMs: 0,
      timeoutMs: 30,
      fetcher: ((_url: unknown, init?: RequestInit) => {
        attempts += 1;
        if (attempts === 1) {
          // Never resolve on the first attempt — let the timeout abort it.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          });
        }
        return Promise.resolve(
          new Response(JSON.stringify({ response: [] }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });
    await client.getSpots();
    expect(attempts).toBe(2);
  });

  it('does NOT retry on HTTP 4xx/5xx or Poster `{error}` envelopes', async () => {
    let attempts = 0;
    const client = new PosterClient({
      token: 'acc:xxx',
      minIntervalMs: 0,
      fetcher: ((_url: unknown) => {
        attempts += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 35, message: 'no access' } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });
    await expect(client.getSpots()).rejects.toBeInstanceOf(PosterApiError);
    // Exactly one attempt — Poster error envelopes are deterministic and a
    // retry would only waste a slot against the 5 req/sec ceiling.
    expect(attempts).toBe(1);
  });

  it('default timeout is 20s (Sprint 3 audit P2 — Poster cold-start headroom)', () => {
    // Construct without explicit `timeoutMs` and verify the default has
    // been bumped from 10_000 to 20_000. We probe via behaviour: a fetch
    // that resolves at 12s would have failed against the old default but
    // succeeds against the new one. Rather than wait 12s in the test we
    // assert the constructor stored the right value by inspecting the
    // private field via a type-cast.
    const client = new PosterClient({ token: 'acc:xxx' });
    // Internal field access via `as any` keeps the API surface clean while
    // letting the test pin the default — bumping it back to 10s would
    // re-open the cold-start bug, so the regression guard is justified.
    const timeoutMs = (client as unknown as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBe(20_000);
  });
});
