/**
 * Hardened RBAC for write actions (owner-approved 2026-05-28).
 *
 * Covers two new units:
 *
 *   1. `authorizeWrite(...allowed)` — PM is ALWAYS 403; an `allowed` role
 *      passes; any other role is 403.
 *   2. `requireLocationOperator(principal, locId)` — PM is ALWAYS thrown
 *      (PM_WRITE_BLOCKED); an operator with the location in its
 *      `locationIds` passes; an operator outside its assignment is thrown
 *      (FOREIGN_LOCATION).
 *
 * The 403 responses must carry `error.code === 'FORBIDDEN'` (per spec
 * §4.10 — the public code stays FORBIDDEN; the audit log records the
 * reason).
 */
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/jwt.js';
import { AppError } from '../src/errors/index.js';
import { authorizeWrite } from '../src/middleware/authorize.js';
import { requireLocationOperator } from '../src/lib/principal.js';
// Stub the audit module so these unit tests stay pure (no DB needed).
vi.mock('../src/lib/audit.js', () => ({
  poolRunner: {},
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

function principal(over: Partial<AuthPrincipal>): AuthPrincipal {
  return {
    userId: 1,
    role: 'store_manager',
    locationId: 1,
    locationIds: [1],
    activeLocationId: null,
    ...over,
  } as AuthPrincipal;
}

function fakeReq(auth?: AuthPrincipal): Request {
  return {
    auth,
    method: 'POST',
    originalUrl: '/api/test',
    header: () => undefined,
  } as unknown as Request;
}

function callMw(mw: ReturnType<typeof authorizeWrite>, req: Request): Promise<unknown> {
  return new Promise((resolve) => {
    const next: NextFunction = (err?: unknown) => resolve(err);
    mw(req, {} as Response, next);
  });
}

// ---------------------------------------------------------------------------
// authorizeWrite
// ---------------------------------------------------------------------------
describe('authorizeWrite — middleware factory', () => {
  it('PM is ALWAYS 403 (no super-admin bypass on write paths)', async () => {
    const mw = authorizeWrite('store_manager', 'central_warehouse_manager');
    const err = await callMw(mw, fakeReq(principal({ role: 'pm', locationIds: [] })));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('FORBIDDEN');
    expect((err as AppError).message).toMatch(/PM has read-only access/);
  });

  it('an allowed role passes', async () => {
    const mw = authorizeWrite('store_manager');
    const err = await callMw(mw, fakeReq(principal({ role: 'store_manager' })));
    expect(err).toBeUndefined();
  });

  it('a role not in the allowed set is 403', async () => {
    const mw = authorizeWrite('store_manager');
    const err = await callMw(mw, fakeReq(principal({ role: 'production_manager' })));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('FORBIDDEN');
  });

  it('no principal -> 401 (wiring bug: forgot to call authenticate)', async () => {
    const mw = authorizeWrite('store_manager');
    const err = await callMw(mw, fakeReq(undefined));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// requireLocationOperator
// ---------------------------------------------------------------------------
describe('requireLocationOperator — handler guard', () => {
  it('PM is ALWAYS forbidden (PM_WRITE_BLOCKED)', async () => {
    await expect(
      requireLocationOperator(principal({ role: 'pm', locationIds: [] }), 42),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('operator with the target in its assignment passes', async () => {
    const p = principal({ role: 'store_manager', locationIds: [10, 20, 30] });
    await expect(requireLocationOperator(p, 20)).resolves.toBeUndefined();
  });

  it('operator OUTSIDE its assignment is forbidden (FOREIGN_LOCATION)', async () => {
    const p = principal({ role: 'store_manager', locationIds: [10, 20] });
    await expect(requireLocationOperator(p, 99)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('operator with empty assignment is forbidden for every location', async () => {
    const p = principal({ role: 'store_manager', locationIds: [] });
    await expect(requireLocationOperator(p, 1)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
