/**
 * Express application assembly.
 *
 * `createApp()` builds the app WITHOUT binding a port — this keeps it
 * importable by tests (supertest drives it in-process). `server.ts` is the
 * thin entrypoint that listens.
 *
 * Sprint 1 wires the health route plus the M1-M3 API router under `/api`.
 * Later sprints add M4-M9 inside `apiRouter`.
 *
 * Production hardening:
 *  - `helmet()` sets the standard security headers (HSTS, X-Content-Type-
 *    Options, X-Frame-Options, etc.). CSP is intentionally disabled — this
 *    is a JSON API, no HTML is rendered.
 *  - `cors()` accepts the comma-separated `WEB_ORIGIN` allowlist (single-
 *    tenant ERP — but local dev and tests need both `localhost` and
 *    `127.0.0.1`, hence the array). Bug-MAJ-02 (F4.11). Credentials are not
 *    used (JWT goes in the Authorization header, not in cookies), so
 *    `credentials: false`.
 */
import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import helmet from 'helmet';
import { loadConfig } from './config/index.js';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp(): Express {
  const app = express();
  const cfg = loadConfig();

  // --- Global middleware ----------------------------------------------------
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  // CORS — exact-match against the allowlist. Same-origin requests (no
  // `Origin` header — curl, server-to-server, health probes) are always
  // allowed. Anything else not in the list is rejected.
  const allowed = new Set(cfg.webOrigins);
  const corsOptions: CorsOptions = {
    origin: (origin, cb): void => {
      // Same-origin / curl / server probes have no `Origin` header — let
      // them through (the cors lib does not set any allow-origin response
      // header in that case anyway). For browser traffic, exact-match the
      // request origin against the allowlist. `cb(null, false)` is the
      // standard "deny" signal: the response is sent normally but WITHOUT
      // an `Access-Control-Allow-Origin` header, so the browser blocks the
      // cross-origin call. We deliberately do NOT throw — throwing turns a
      // disallowed-origin pre-flight into a 500 and pollutes error logs.
      if (origin === undefined || allowed.has(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: false,
  };
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '1mb' }));

  // --- Routes ---------------------------------------------------------------
  app.use(healthRouter);
  app.use('/api', apiRouter); // M1-M3 now; M4-M9 added in later sprints.

  // --- Error handling (must be last) ---------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
