/**
 * Smoke test — `GET /health`.
 *
 * Verifies the Express app boots, the route responds, and the error/JSON
 * middleware is wired. Business-logic tests arrive with M1-M9.
 *
 * Requires the local dev database (`adia_erp_dev`) to be reachable so the
 * DB ping inside /health can run. See apps/backend/README.md.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db/index.js';

const app = createApp();

afterAll(async () => {
  await closePool();
});

describe('GET /health', () => {
  it('returns service status and a db field', async () => {
    const res = await request(app).get('/health');

    // 200 when the dev DB is up, 503 when it is down — both are valid shapes.
    expect([200, 503]).toContain(res.status);
    expect(res.body).toMatchObject({
      service: 'adia-erp-api',
    });
    expect(res.body).toHaveProperty('db');
    expect(res.body).toHaveProperty('time');
  });
});

describe('unknown route', () => {
  it('returns the spec-shaped NOT_FOUND error', async () => {
    const res = await request(app).get('/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.any(String),
      },
    });
  });
});
