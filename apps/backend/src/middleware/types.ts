/**
 * Express request augmentation.
 *
 * `authenticate` attaches the verified principal to `req.auth`. Declaring it
 * on Express's `Request` keeps every downstream handler fully typed without
 * casts.
 */
import type { AuthPrincipal } from '../auth/jwt.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware once a JWT is verified. */
      auth?: AuthPrincipal;
    }
  }
}

export {};
