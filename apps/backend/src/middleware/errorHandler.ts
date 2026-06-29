/**
 * Centralised error-handling middleware.
 *
 * Every error reaching here is rendered as the spec section 4.10 shape:
 *   { "error": { "code": "STRING_CODE", "message": "..." } }
 *
 * `AppError` instances map directly to their code/status. Any other thrown
 * value is treated as an unexpected 500 `INTERNAL_ERROR` — its message is
 * NOT leaked to the client (logged server-side only).
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode, type ErrorBody } from '../errors/index.js';

/** 404 fallback — no route matched. Forwards a NOT_FOUND AppError. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`No route for ${req.method} ${req.path}.`));
}

/**
 * Terminal error handler. Must be registered LAST and keep the 4-arg
 * signature so Express recognises it as an error handler.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // `next` is required for Express to treat this as an error handler.
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody());
    return;
  }

  // Unknown error: log the detail, return a generic 500.
  console.error('[error] unhandled:', err);
  const body: ErrorBody = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    },
  };
  res.status(500).json(body);
}
