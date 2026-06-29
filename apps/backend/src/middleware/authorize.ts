/**
 * `authorize` middleware factory — role-gates an endpoint.
 *
 * `authorize('pm', 'production_manager')` returns a middleware that lets the
 * request through only if `req.auth.role` is one of the listed roles. The
 * `pm` super-admin role always passes (spec section 6).
 *
 * Must run AFTER `authenticate`. Location-scoped checks ("a store sees only
 * its own data") are enforced inside each handler, since they need the
 * resource's location id.
 */
import type { NextFunction, Request, Response } from 'express';
import { SUPER_ADMIN_ROLES, type Role } from '../auth/roles.js';
import { AppError } from '../errors/index.js';
import './types.js';

/** Build a middleware that allows only the given roles (plus `pm`). */
export function authorize(...allowed: readonly Role[]): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.auth;
    if (principal === undefined) {
      // authorize was used without authenticate — a wiring bug, not a client error.
      next(AppError.unauthenticated('Authentication must run before authorization.'));
      return;
    }
    if (SUPER_ADMIN_ROLES.has(principal.role) || allowed.includes(principal.role)) {
      next();
      return;
    }
    next(AppError.forbidden('Your role may not perform this action.'));
  };
}

/**
 * `authorizeWrite` — role gate for **business write** endpoints.
 *
 * Both `super_admin` and `pm` have full write access across the chain
 * (owner decision 2026-06-25: PM should be able to add/edit/delete everything).
 * Location-scoped operators are also allowed when their role is in `allowed`.
 *
 * Pair with `requireLocationOperator` inside the handler to enforce the
 * (location, principal) ownership check for non-super-admin roles.
 */
export function authorizeWrite(...allowed: readonly Role[]): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.auth;
    if (principal === undefined) {
      next(AppError.unauthenticated('Authentication must run before authorization.'));
      return;
    }
    // super_admin and pm bypass location-scoped restrictions.
    if (SUPER_ADMIN_ROLES.has(principal.role) || allowed.includes(principal.role)) {
      next();
      return;
    }
    next(AppError.forbidden('Your role may not perform this action.'));
  };
}
