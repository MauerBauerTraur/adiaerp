/**
 * RBAC roles — mirrors the `user_role` enum in the database
 * (db-schema-phase-1.sql) and the spec section 6 matrix.
 */
export const ROLES = [
  'super_admin',
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
] as const;

export type Role = (typeof ROLES)[number];

/** Type guard — narrows an unknown string to a valid `Role`. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Roles with chain-wide super-admin access: implicitly satisfy any role gate
 * including `authorizeWrite`. `super_admin` is the highest-privilege role;
 * `pm` (project manager) also has full read+write access across the chain.
 */
export const SUPER_ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['super_admin', 'pm']);

/** @deprecated Use `SUPER_ADMIN_ROLES.has(role)` instead. Kept for backward-compat. */
export const SUPER_ADMIN_ROLE: Role = 'pm';
