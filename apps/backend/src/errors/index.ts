/**
 * Application error model.
 *
 * Every error returned to a client follows the spec section 4.10 shape:
 *   { "error": { "code": "STRING_CODE", "message": "..." } }
 *
 * `ErrorCode` is the closed enum of standard codes; `AppError` carries an
 * HTTP status alongside the code so the error-handler middleware can map it.
 */

/** Standard error codes (spec section 4.10). */
export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  OPEN_REQUEST_EXISTS: 'OPEN_REQUEST_EXISTS',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  CONFLICT: 'CONFLICT',
  POSTER_SYNC_ERROR: 'POSTER_SYNC_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Faza-3 F3.2 — AI write-action lifecycle (ADR-0009).
  ACTION_NOT_PENDING: 'ACTION_NOT_PENDING',
  ACTION_EXPIRED: 'ACTION_EXPIRED',
  // F3.4 / ADR-0010 — feature gated by an external sidecar that is not configured.
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // EPIC 5 / ADR-0016 — production dialog lifecycle.
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_OPTION: 'INVALID_OPTION',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status for each error code. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  INSUFFICIENT_STOCK: 409,
  OPEN_REQUEST_EXISTS: 409,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  POSTER_SYNC_ERROR: 502,
  INTERNAL_ERROR: 500,
  ACTION_NOT_PENDING: 409,
  ACTION_EXPIRED: 410,
  SERVICE_UNAVAILABLE: 503,
  SESSION_EXPIRED: 409,
  INVALID_OPTION: 422,
};

/** The JSON body shape sent to clients. */
export type ErrorBody = {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
  };
};

/**
 * A typed application error. Throw this anywhere in a request lifecycle;
 * the error-handler middleware turns it into the spec-shaped response.
 */
export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly code: ErrorCode;
  public readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  /** Render this error as the spec section 4.10 JSON body. */
  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message } };
  }

  // --- Convenience constructors ---------------------------------------------

  static unauthenticated(message = 'Authentication is required.'): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, message);
  }

  static forbidden(message = 'You do not have permission to perform this action.'): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message);
  }

  static notFound(message = 'Resource not found.'): AppError {
    return new AppError(ErrorCode.NOT_FOUND, message);
  }

  static validation(message: string): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message);
  }

  static internal(message = 'An unexpected error occurred.'): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, message);
  }

  static serviceUnavailable(message = 'Service is temporarily unavailable.'): AppError {
    return new AppError(ErrorCode.SERVICE_UNAVAILABLE, message);
  }

  static conflict(message: string): AppError {
    return new AppError(ErrorCode.CONFLICT, message);
  }
}
