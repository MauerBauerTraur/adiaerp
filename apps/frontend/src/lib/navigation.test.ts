import { describe, it, expect } from 'vitest';
import {
  navSectionsForRole,
  findGroupForPath,
  resolveGroupLanding,
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

  it('returns null for unknown paths (e.g. /admin/import-warnings)', () => {
    expect(findGroupForPath('/admin/import-warnings')).toBeNull();
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
