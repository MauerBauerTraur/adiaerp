/**
 * Canonical list of navigation paths a user can be granted access to.
 *
 * MIRROR of `apps/frontend/src/lib/navigation.ts` → `NAV_SECTIONS[].items[].path`.
 * The two lists are kept in sync by `test/lib.navPaths.test.ts`, which parses
 * the frontend file and fails when a path is added on one side only.
 *
 * The backend uses this only to reject junk input on
 * `PUT /api/users/:id/pages` — the *role* filter still lives in the frontend
 * nav model (and every endpoint keeps its own RBAC gate), so granting a path
 * never widens what an API will actually return.
 */
export const NAV_PATHS = [
  // Boshqaruv paneli
  '/dashboard',
  // Bashorat
  '/forecasts',
  // Modullar
  '/raw-warehouse',
  '/production',
  '/supply',
  '/central-warehouse',
  '/stores',
  '/transfer',
  '/replenishment',
  '/sorovnomalar',
  '/purchase-orders',
  '/sotuvlar',
  '/cashier/receipts',
  '/cashier/shifts',
  '/cashier/nakladnoy',
  '/cashier/safe',
  // Ishlab chiqarish
  '/production-orders',
  '/zagotovka',
  '/krem-kaymok',
  '/warehouse-dispatch',
  '/production-cost-report',
  '/raw-materials-usage',
  '/bozor-royxati',
  '/poster-supplies',
  '/reports/stock',
  // Ma'lumotnoma
  '/products',
  '/reports/profit',
  '/locations',
  '/employees',
  '/admin/import-warnings',
] as const;

export type NavPath = (typeof NAV_PATHS)[number];

const NAV_PATH_SET: ReadonlySet<string> = new Set<string>(NAV_PATHS);

/** Type guard — narrows an unknown value to a known navigation path. */
export function isNavPath(value: unknown): value is NavPath {
  return typeof value === 'string' && NAV_PATH_SET.has(value);
}
