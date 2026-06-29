/**
 * Health endpoint — `GET /health`.
 *
 * Reports process liveness and database connectivity. Unauthenticated by
 * design (used by load balancers / uptime checks). Returns 200 when the DB
 * ping succeeds, 503 when it fails.
 */
import { Router } from 'express';
import { ping } from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', asyncHandler(async (_req, res) => {
  let dbOk = false;
  try {
    dbOk = await ping();
  } catch (err) {
    console.error('[health] db ping failed:', (err as Error).message);
    dbOk = false;
  }

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'adia-erp-api',
    db: dbOk ? 'up' : 'down',
    time: new Date().toISOString(),
  });
}));
