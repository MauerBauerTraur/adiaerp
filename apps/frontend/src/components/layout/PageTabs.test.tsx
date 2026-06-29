import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { PageTabs } from './PageTabs';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import type { Role, User } from '@/lib/types';

function fakeUser(role: Role): User {
  return {
    id: 1,
    name: `Test ${role}`,
    username: role,
    role,
    location_id: null,
  };
}

function fakeAuth(user: User): AuthContextValue {
  return {
    user,
    token: 'test-token',
    isAuthenticated: true,
    isHydrating: false,
    locations: [],
    activeLocationId: null,
    login: () => {},
    logout: async () => {},
    setActiveLocation: async () => {},
  };
}

function renderTabs(opts: {
  group: 'dashboard' | 'forecasts' | 'modules' | 'reference';
  role: Role;
  initialPath: string;
}) {
  const user = fakeUser(opts.role);
  return render(
    <AuthContext.Provider value={fakeAuth(user)}>
      <ToastProvider>
        <MemoryRouter initialEntries={[opts.initialPath]}>
          <PageTabs group={opts.group} />
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>,
  );
}

describe('PageTabs', () => {
  it('renders the full modules tab list for pm', () => {
    renderTabs({ group: 'modules', role: 'pm', initialPath: '/raw-warehouse' });
    const list = screen.getByTestId('page-tabs');
    expect(list).toHaveAttribute('role', 'tablist');

    // Every modules-group tab is visible to pm.
    for (const key of [
      'raw-warehouse',
      'production',
      'supply',
      'central-warehouse',
      'stores',
      'replenishment',
      'production-orders',
      'purchase-orders',
    ]) {
      expect(within(list).getByTestId(`page-tab-${key}`)).toBeInTheDocument();
    }
  });

  it('marks the tab matching the current route as aria-selected', () => {
    renderTabs({ group: 'modules', role: 'pm', initialPath: '/production' });
    const active = screen.getByTestId('page-tab-production');
    expect(active).toHaveAttribute('aria-selected', 'true');

    const other = screen.getByTestId('page-tab-raw-warehouse');
    expect(other).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps the parent tab active on nested routes (e.g. /replenishment/:id)', () => {
    renderTabs({
      group: 'modules',
      role: 'pm',
      initialPath: '/replenishment/42',
    });
    expect(screen.getByTestId('page-tab-replenishment')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('filters tabs by RBAC — store_manager only sees their own scope', () => {
    renderTabs({ group: 'modules', role: 'store_manager', initialPath: '/stores' });
    const list = screen.getByTestId('page-tabs');
    expect(within(list).getByTestId('page-tab-stores')).toBeInTheDocument();
    expect(
      within(list).queryByTestId('page-tab-raw-warehouse'),
    ).not.toBeInTheDocument();
    expect(
      within(list).queryByTestId('page-tab-production'),
    ).not.toBeInTheDocument();
  });

  it('renders the reference tab list (Mahsulotlar / Bo‘g‘inlar / …)', () => {
    renderTabs({ group: 'reference', role: 'pm', initialPath: '/products' });
    const list = screen.getByTestId('page-tabs');
    expect(within(list).getByTestId('page-tab-products')).toBeInTheDocument();
    expect(within(list).getByTestId('page-tab-locations')).toBeInTheDocument();
    // EPIC 3 — /users merged into /employees; only the merged tab remains.
    expect(within(list).getByTestId('page-tab-employees')).toBeInTheDocument();
  });

  it('hides users/employees from non-pm roles inside the reference group', () => {
    renderTabs({
      group: 'reference',
      role: 'store_manager',
      initialPath: '/products',
    });
    expect(
      screen.queryByTestId('page-tab-users'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('page-tab-employees'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('page-tab-products')).toBeInTheDocument();
  });

  it('renders nothing when the group key is unknown', () => {
    const user = fakeUser('store_manager');
    render(
      <AuthContext.Provider value={fakeAuth(user)}>
        <ToastProvider>
          <MemoryRouter>
            {/* @ts-expect-error — intentionally bad group key to test guard */}
            <PageTabs group="nonexistent" />
          </MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>,
    );
    expect(screen.queryByTestId('page-tabs')).not.toBeInTheDocument();
  });
});
