import type { Role } from '@/lib/types';

/**
 * Who may open "Poster bilan solishtirish" and run an audit. The backend gates
 * the endpoints with `authorize('pm', 'production_manager')`, and super_admin
 * passes every gate there too.
 */
export const RECIPE_AUDIT_ROLES: readonly Role[] = ['super_admin', 'pm', 'production_manager'];

/** Who may bulk-replace recipes from Poster (backend: pm only, plus super_admin). */
export const RECIPE_AUDIT_APPLY_ROLES: readonly Role[] = ['super_admin', 'pm'];

export const RECIPE_AUDIT_PATH = '/products/recipe-audit';
