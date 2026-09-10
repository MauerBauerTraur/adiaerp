/**
 * EmployeesPage — PM-only roster.
 *
 * The contract these tests pin:
 *   - The PM sees every account from `GET /api/users`.
 *   - The page renders Uzbek labels ("Foydalanuvchilar", "Yangi foydalanuvchi").
 *   - The "Yangi foydalanuvchi" button opens `EmployeeFormDialog`.
 *   - Each row offers "Bo'limlar" — per-user page access (migration 0061),
 *     which replaced the old "Bo'g'inlar" (warehouse) dialog.
 *
 * RBAC is handled by `RoleRoute` (the wrapper around this page in
 * AppRouter), so we don't re-test that here; navigation.test.ts already
 * pins the role matrix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeesPage } from './EmployeesPage';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    },
  );
}

describe('EmployeesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the employee roster with role and primary-location columns', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/users')) {
        return jsonResponse(200, [
          {
            id: 1,
            name: 'Anvar Karimov',
            role: 'store_manager',
            location_id: 10,
          },
          {
            id: 2,
            name: 'Nodira Rustamova',
            role: 'production_manager',
            location_id: 20,
          },
        ]);
      }
      if (url.endsWith('/api/locations')) {
        return jsonResponse(200, [
          {
            id: 10,
            name: 'Filial-1',
            type: 'store',
            parent_id: null,
            manager_user_id: null,
            poster_storage_id: null,
            lead_time_days: null,
            review_days: null,
            safety_factor: null,
          },
          {
            id: 20,
            name: 'Tsex',
            type: 'production',
            parent_id: null,
            manager_user_id: null,
            poster_storage_id: null,
            lead_time_days: null,
            review_days: null,
            safety_factor: null,
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderWithProviders(<EmployeesPage />);

    expect(screen.getByText('Foydalanuvchilar')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Anvar Karimov')).toBeTruthy();
    });
    expect(screen.getByText('Nodira Rustamova')).toBeTruthy();
    // Primary-location names rendered through the lookup map.
    expect(screen.getByText('Filial-1')).toBeTruthy();
    expect(screen.getByText('Tsex')).toBeTruthy();
  });

  it('opens the create dialog when "Yangi foydalanuvchi" is clicked', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/users')) return jsonResponse(200, []);
      if (url.endsWith('/api/locations')) return jsonResponse(200, []);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderWithProviders(<EmployeesPage />);
    const user = userEvent.setup();

    const trigger = await screen.findByRole('button', {
      name: /Yangi foydalanuvchi/i,
    });
    await user.click(trigger);

    // Dialog renders with the same heading.
    await waitFor(() => {
      const titles = screen.getAllByText('Yangi foydalanuvchi');
      // Trigger + dialog title → at least two matches.
      expect(titles.length).toBeGreaterThanOrEqual(2);
    });
    // The role select inside the dialog confirms the form mounted.
    expect(screen.getByLabelText('Rol')).toBeTruthy();
  });

  it('opens the per-user bo‘limlar dialog from a roster row', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/users')) {
        return jsonResponse(200, [
          { id: 1, name: 'Anvar Karimov', role: 'store_manager', location_id: 10 },
        ]);
      }
      if (url.endsWith('/api/locations')) return jsonResponse(200, []);
      if (url.includes('/pages')) return jsonResponse(200, { paths: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderWithProviders(<EmployeesPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Bo'limlar/i }));

    // The dialog is scoped to the clicked user.
    expect(
      await screen.findByText(/Anvar Karimov — bo‘limlar/),
    ).toBeTruthy();
    // The old warehouse picker is gone.
    expect(screen.queryByText(/bo‘g‘in qo‘shish/i)).toBeNull();
  });
});
