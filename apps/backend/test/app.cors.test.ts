/**
 * F4.11 Bug-MAJ-02 — CORS allowlist regression test.
 *
 * The previous configuration locked CORS to a SINGLE `WEB_ORIGIN` string, so
 * the moment a browser hit the app via `127.0.0.1` instead of `localhost`
 * (or vice versa) preflight failed. The fix: comma-separated list parsed
 * into an allowlist; both `localhost` and `127.0.0.1` for every relevant
 * port are accepted in local dev.
 *
 * This file exercises three cases:
 *   - allowed `Origin` -> Access-Control-Allow-Origin echoed back.
 *   - second allowed `Origin` -> the SAME header echoed (multi-origin works).
 *   - disallowed `Origin` -> no allow-origin header (cors silently drops it).
 *
 * Same-origin / curl traffic (no `Origin` header) is intentionally NOT
 * exercised — the cors lib passes it through unconditionally, which is the
 * behaviour we want for health probes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

let app: Express;

beforeAll(async () => {
  // Configure the allowlist BEFORE the config cache fills.
  process.env.WEB_ORIGIN =
    'http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173';
  const { resetConfigCache } = await import('../src/config/index.js');
  resetConfigCache();
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(async () => {
  const { closePool } = await import('../src/db/index.js');
  await closePool();
  // Reset for any later test file that re-imports the module.
  delete process.env.WEB_ORIGIN;
  const { resetConfigCache } = await import('../src/config/index.js');
  resetConfigCache();
});

describe('CORS allowlist (F4.11 Bug-MAJ-02)', () => {
  it('echoes Access-Control-Allow-Origin for an allowed localhost origin', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://localhost:4173')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:4173',
    );
  });

  it('echoes Access-Control-Allow-Origin for an allowed 127.0.0.1 origin', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://127.0.0.1:4173')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:4173',
    );
  });

  it('does not echo Access-Control-Allow-Origin for a disallowed origin', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
