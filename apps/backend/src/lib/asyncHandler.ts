/**
 * `asyncHandler` — wraps an async Express route handler so a rejected
 * promise (a thrown `AppError` or any error) is forwarded to `next()` and
 * reaches the centralised error-handler middleware.
 *
 * Without this, an async handler that throws produces an unhandled rejection
 * instead of a spec-shaped error response.
 */
import type { NextFunction, Request, Response } from 'express';

type AsyncRouteHandler = (req: Request, res: Response) => Promise<void>;

export function asyncHandler(
  handler: AsyncRouteHandler,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}
