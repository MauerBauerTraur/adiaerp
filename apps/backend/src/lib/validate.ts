/**
 * Boundary input validation helpers.
 *
 * Every endpoint validates untrusted request input HERE, at the boundary,
 * before it reaches any SQL. A failed check throws `AppError.validation`
 * (HTTP 422, spec section 4.10) — the error-handler renders the spec shape.
 *
 * These helpers narrow `unknown` to concrete types so handler code stays
 * fully typed without casts (CLAUDE.md section 9 — no `any`).
 */
import { AppError } from '../errors/index.js';

/** Treat the request body as a plain object; reject arrays/primitives/null. */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** A required non-empty trimmed string. */
export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.validation(`Field "${key}" must be a non-empty string.`);
  }
  return value.trim();
}

/** An optional trimmed string — returns `undefined` when absent/empty. */
export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw AppError.validation(`Field "${key}" must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A required positive integer (id-like). */
export function requireId(obj: Record<string, unknown>, key: string): number {
  const n = obj[key];
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw AppError.validation(`Field "${key}" must be a positive integer.`);
  }
  return n;
}

/** An optional positive integer — returns `undefined` when absent/null. */
export function optionalId(obj: Record<string, unknown>, key: string): number | undefined {
  const n = obj[key];
  if (n === undefined || n === null) {
    return undefined;
  }
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw AppError.validation(`Field "${key}" must be a positive integer.`);
  }
  return n;
}

/** A required finite number strictly greater than zero (quantities). */
export function requirePositiveNumber(obj: Record<string, unknown>, key: string): number {
  const n = obj[key];
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw AppError.validation(`Field "${key}" must be a number greater than zero.`);
  }
  return n;
}

/** A required finite number greater than or equal to zero (levels). */
export function requireNonNegativeNumber(obj: Record<string, unknown>, key: string): number {
  const n = obj[key];
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw AppError.validation(`Field "${key}" must be a number >= 0.`);
  }
  return n;
}

/** A required value that must be one of a fixed set. */
export function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = obj[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw AppError.validation(`Field "${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Parse a query-string id parameter (route `:id` or `?key=`). */
export function parseIdParam(raw: string | undefined, label: string): number {
  if (raw === undefined) {
    throw AppError.validation(`Missing "${label}".`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw AppError.validation(`"${label}" must be a positive integer.`);
  }
  return n;
}

/** Parse an optional query-string id; `undefined` when absent. */
export function parseOptionalIdParam(
  raw: string | undefined,
  label: string,
): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  return parseIdParam(raw, label);
}
