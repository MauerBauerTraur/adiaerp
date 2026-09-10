import { describe, it, expect } from 'vitest';
import {
  navSectionsForRole,
  navSectionsFor,
  isPathAllowed,
  firstAllowedPath,
  findGroupForPath,
  resolveGroupLanding,
  ALL_NAV_PATHS,
  NAV_SECTIONS,
} from './navigation';

describe('navSectionsForRole', () => {
  it('gives pm every module plus the merged Hodimlar reference screen', () => {
    const sections = navSectionsForRole('pm');
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    // EPIC 3 — "Foydalanuvchilar" (/users) was merged into "Hodimlar"
    // (/employees); the standalone /users nav entry no longer exists.
    expect(paths).toContain('/employees');
    expect(paths).not.toContain('/users');
    expect(paths).toContain('/locations');
    expect(paths).toContain('/products');
    expect(paths).toContain('/raw-warehouse');
  });

  it('exposes the unified So‘rovnomalar inbox to every role', () => {
    for (const role of [
      'pm',
      'store_manager',
      'production_manager',
      'supply_manager',
      'central_warehouse_manager',
      'raw_warehouse_manager',
      'ai_assistant',
    ] as const) {
      const paths = navSectionsForRole(role).flatMap((s) =>
        s.items.map((i) => i.path),
      );
      expect(paths).toContain('/sorovnomalar');
    }
  });

  it('hides Hodimlar from non-pm roles', () => {
    const sections = navSectionsForRole('store_manager');
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    expect(paths).not.toContain('/users');
    expect(paths).not.toContain('/employees');
  });

  it('scopes module screens to the owning role', () => {
    const paths = navSectionsForRole('store_manager').flatMap((s) =>
      s.items.map((i) => i.path),
    );
    expect(paths).toContain('/stores');
    expect(paths).not.toContain('/raw-warehouse');
    expect(paths).not.toContain('/production');
  });

  it('exposes production-orders to production / central-warehouse / pm', () => {
    expect(
      navSectionsForRole('production_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/production-orders');
    expect(
      navSectionsForRole('central_warehouse_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/production-orders');
    expect(
      navSectionsForRole('store_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).not.toContain('/production-orders');
  });

  it('exposes purchase-orders to supply / raw-warehouse / pm', () => {
    expect(
      navSectionsForRole('supply_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/purchase-orders');
    expect(
      navSectionsForRole('raw_warehouse_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/purchase-orders');
    expect(
      navSectionsForRole('store_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).not.toContain('/purchase-orders');
  });

  it('drops empty sections', () => {
    const sections = navSectionsForRole('production_manager');
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('preserves the group metadata (key, icon, defaultPath, hasTabs)', () => {
    const sections = navSectionsForRole('pm');
    const modules = sections.find((s) => s.key === 'modules');
    expect(modules).toBeDefined();
    expect(modules?.hasTabs).toBe(true);
    expect(modules?.defaultPath).toBe('/raw-warehouse');

    const dashboard = sections.find((s) => s.key === 'dashboard');
    expect(dashboard?.hasTabs).toBe(false);
  });
});

describe('findGroupForPath', () => {
  it('returns the modules group for /production', () => {
    expect(findGroupForPath('/production')?.key).toBe('modules');
  });

  it('matches nested paths under an item (e.g. /replenishment/42)', () => {
    expect(findGroupForPath('/replenishment/42')?.key).toBe('modules');
  });

  it('returns reference for /products and /employees', () => {
    expect(findGroupForPath('/products')?.key).toBe('reference');
    // EPIC 3 — /users merged into /employees.
    expect(findGroupForPath('/employees')?.key).toBe('reference');
  });

  it('returns dashboard / forecasts for their single screens', () => {
    expect(findGroupForPath('/dashboard')?.key).toBe('dashboard');
    expect(findGroupForPath('/forecasts')?.key).toBe('forecasts');
  });

  it('resolves /admin/import-warnings — it is a Ma\'lumotnoma item', () => {
    expect(findGroupForPath('/admin/import-warnings')?.key).toBe('reference');
  });

  it('returns null for paths outside the nav model (e.g. /stock)', () => {
    expect(findGroupForPath('/stock')).toBeNull();
  });
});

describe('resolveGroupLanding', () => {
  it('uses the default path when the role can see it', () => {
    const modules = NAV_SECTIONS.find((s) => s.key === 'modules')!;
    expect(resolveGroupLanding(modules, 'pm')).toBe('/raw-warehouse');
  });

  it('falls back to the first visible item when default is hidden', () => {
    const modules = NAV_SECTIONS.find((s) => s.key === 'modules')!;
    // store_manager cannot see /raw-warehouse — landing should be the
    // first item they can see (Do'konlar = /stores).
    expect(resolveGroupLanding(modules, 'store_manager')).toBe('/stores');
  });

  it('returns null when the role has no visible items in the group', () => {
    // Synthesize a section that nobody but pm can see, then test it.
    const refSection = NAV_SECTIONS.find((s) => s.key === 'reference')!;
    // /employees (merged users+hodimlar) is pm-only inside reference,
    // but products and locations are visible to all manager roles — so
    // reference is never empty for a manager role. Use a degenerate
    // filter to the pm-only item instead.
    const pmOnly = {
      ...refSection,
      items: refSection.items.filter((item) => item.path === '/employees'),
    };
    expect(resolveGroupLanding(pmOnly, 'store_manager')).toBeNull();
    expect(resolveGroupLanding(pmOnly, 'pm')).toBe('/employees');
  });
});


// ─── Per-user page whitelist (migration 0061) ────────────────────────────────

describe('navSectionsFor', () => {
  it('treats an empty whitelist as "no override", not "no access"', () => {
    // Every account predating the feature has zero rows — the fallback has
    // to stay permissive or the whole app disappears on deploy.
    expect(navSectionsFor('pm', [])).toEqual(navSectionsForRole('pm'));
    expect(navSectionsFor('pm', null)).toEqual(navSectionsForRole('pm'));
    expect(navSectionsFor('pm', undefined)).toEqual(navSectionsForRole('pm'));
  });

  it('keeps only the granted screens', () => {
    const sections = navSectionsFor('pm', ['/dashboard', '/sotuvlar']);
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    expect(paths).toEqual(['/dashboard', '/sotuvlar']);
  });

  it('drops a group once none of its screens are granted', () => {
    const keys = navSectionsFor('pm', ['/dashboard']).map((s) => s.key);
    expect(keys).toEqual(['dashboard']);
  });

  it('never widens past the role — granting a hidden path is a no-op', () => {
    // store_manager has no access to /raw-warehouse; granting it changes
    // nothing, because the role filter runs first.
    const paths = navSectionsFor('store_manager', [
      '/raw-warehouse',
      '/stores',
    ]).flatMap((s) => s.items.map((i) => i.path));
    expect(paths).toEqual(['/stores']);
  });
});

describe('isPathAllowed', () => {
  it('allows everything when there is no override', () => {
    expect(isPathAllowed('/products', 'pm', [])).toBe(true);
  });

  it('blocks a nav screen that was not granted', () => {
    expect(isPathAllowed('/products', 'pm', ['/dashboard'])).toBe(false);
  });

  it('follows a nested route to its parent nav entry', () => {
    // Detail routes are not nav items of their own — they inherit the
    // grant of the screen they belong to.
    expect(isPathAllowed('/replenishment/1001', 'pm', ['/dashboard'])).toBe(false);
    expect(isPathAllowed('/replenishment/1001', 'pm', ['/replenishment'])).toBe(true);
  });

  it('lets non-nav utility routes through', () => {
    // `/stock` has no nav entry; locking it out would strand the screen
    // with no way to grant it.
    expect(findGroupForPath('/stock')).toBeNull();
    expect(isPathAllowed('/stock', 'pm', ['/dashboard'])).toBe(true);
  });
});

describe('firstAllowedPath', () => {
  it('lands on the first granted screen', () => {
    expect(firstAllowedPath('pm', ['/products'])).toBe('/products');
  });

  it('prefers the earliest group in nav order', () => {
    expect(firstAllowedPath('pm', ['/products', '/dashboard'])).toBe('/dashboard');
  });

  it('returns null when the whitelist grants nothing reachable', () => {
    expect(firstAllowedPath('store_manager', ['/raw-warehouse'])).toBeNull();
  });
});

describe('ALL_NAV_PATHS', () => {
  it('covers every item in the nav model, without duplicates', () => {
    const fromSections = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.path));
    expect([...ALL_NAV_PATHS]).toEqual(fromSections);
    expect(new Set(ALL_NAV_PATHS).size).toBe(ALL_NAV_PATHS.length);
  });
});
