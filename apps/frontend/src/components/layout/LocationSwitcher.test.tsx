/**
 * LocationSwitcher (F4.1) — header switcher for multi-location users.
 *
 * Contract pinned by these tests:
 *   1. Single-location user — no switcher renders.
 *   2. Multi-location user — every assignment listed; primary prefixed
 *      with the ⭐ glyph.
 *   3. Changing the value calls `setActiveLocation()` and toasts the
 *      Uzbek confirmation. We stub `window.location.reload()` to keep
 *      jsdom from blowing up the test runner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LocationSwitcher } from './LocationSwitcher';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import { ToastProvider } from '@/components/ui/toast';
import type { MeLocation } from '@/lib/types';

function makeAuth(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    user: {
      id: 1,
      name: 'Test',
      username: 'test',
      role: 'central_warehouse_manager',
      location_id: 10,
    },
    token: 'tok',
    isAuthenticated: true,
    isHydrating: false,
    locations: [],
    activeLocationId: null,
    login: () => {},
    logout: async () => {},
    setActiveLocation: async () => {},
    ...overrides,
  };
}

function Wrap({
  children,
  value,
}: {
  children: ReactNode;
  value: AuthContextValue;
}) {
  return (
    <AuthContext.Provider value={value}>
      <ToastProvider>{children}</ToastProvider>
    </AuthContext.Provider>
  );
}

const SINGLE: MeLocation[] = [
  { id: 10, name: 'Markaziy sklad', type: 'central_warehouse', is_primary: true },
];

const MULTI: MeLocation[] = [
  { id: 10, name: 'Filial-1', type: 'store', is_primary: true },
  { id: 11, name: 'Filial-2', type: 'store', is_primary: false },
];

describe('LocationSwitcher', () => {
  beforeEach(() => {
    // jsdom does not implement reload(); stub it so the component's
    // post-success refresh hook does not throw.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: vi.fn() },
    });
  });

  it('renders nothing for a single-location user', () => {
    const { container } = render(
      <Wrap value={makeAuth({ locations: SINGLE, activeLocationId: 10 })}>
        <LocationSwitcher />
      </Wrap>,
    );
    expect(container.querySelector('select')).toBeNull();
  });

  it('lists every location and marks the primary with a star glyph', () => {
    render(
      <Wrap value={makeAuth({ locations: MULTI, activeLocationId: 10 })}>
        <LocationSwitcher />
      </Wrap>,
    );
    const select = screen.getByRole('combobox', {
      name: /aktiv bo‘g‘in/i,
    }) as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.options).map((o) => o.textContent ?? '');
    expect(options[0]).toContain('⭐');
    expect(options[0]).toContain('Filial-1');
    expect(options[1]).toContain('Filial-2');
    expect(options[1]).not.toContain('⭐');
  });

  it('invokes setActiveLocation() and surfaces the success toast', async () => {
    const setActiveLocation = vi.fn().mockResolvedValue(undefined);
    render(
      <Wrap
        value={makeAuth({
          locations: MULTI,
          activeLocationId: 10,
          setActiveLocation,
        })}
      >
        <LocationSwitcher />
      </Wrap>,
    );
    const select = screen.getByRole('combobox', {
      name: /aktiv bo‘g‘in/i,
    }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '11' } });

    await waitFor(() => {
      expect(setActiveLocation).toHaveBeenCalledWith(11);
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Aktiv bo‘g‘in o‘zgartirildi: Filial-2/),
      ).toBeTruthy();
    });
  });
});
