import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeliveryPage } from './DeliveryPage';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type { DeliveryTask, User } from '@/lib/types';

const UNASSIGNED_TASK: DeliveryTask = {
  id: 1,
  replenishment_id: 101,
  product_id: 7,
  product_name: 'Un',
  product_unit: 'kg',
  qty_needed: 25,
  status: 'NEW',
  requester_location_id: 5,
  requester_location_name: 'Do‘kon #1',
  target_location_id: 2,
  target_location_name: 'Markaziy sklad',
  assigned_user_id: null,
  assigned_user_name: null,
  created_at: '2026-05-24T08:00:00Z',
  updated_at: '2026-05-24T08:00:00Z',
};

const ASSIGNED_TASK: DeliveryTask = {
  ...UNASSIGNED_TASK,
  id: 2,
  replenishment_id: 102,
  product_name: 'Shakar',
  assigned_user_id: 9,
  assigned_user_name: 'Sardor Aliyev',
};

const CANDIDATE_USERS: User[] = [
  {
    id: 9,
    name: 'Sardor Aliyev',
    username: 'sardor',
    role: 'central_warehouse_manager',
    location_id: 2,
  },
  {
    id: 10,
    name: 'Bekzod Rahimov',
    username: 'bekzod',
    role: 'store_manager',
    location_id: 5,
  },
];

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url.includes('/api/delivery/tasks/') && url.endsWith('/assign')) {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      if (url.includes('/api/delivery/tasks')) {
        return Promise.resolve(
          jsonResponse(200, [UNASSIGNED_TASK, ASSIGNED_TASK]),
        );
      }
      if (url.includes('/api/users')) {
        return Promise.resolve(jsonResponse(200, CANDIDATE_USERS));
      }
      if (
        url.includes('/api/replenishment') &&
        (url.endsWith('/advance') || url.endsWith('/cancel')) &&
        method === 'POST'
      ) {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    },
  );
}

describe('DeliveryPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides every action button for PM (Stage 2 read-only)', async () => {
    mockFetch();
    renderWithProviders(<DeliveryPage />, { role: 'pm' });
    await screen.findByText('Un');
    // The list is still visible — PM keeps read access to the queue —
    // but no per-task buttons render.
    expect(screen.queryByRole('button', { name: /biriktirish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /o.zgartirish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bajarish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bekor' })).toBeNull();
    expect(screen.getByText(/faqat o.qish/i)).toBeInTheDocument();
  });

  it('shows the cancel button only for the requester bo‘g‘in operator', async () => {
    mockFetch();
    // Render as store_manager scoped to requester location 5. The
    // requester-side operator must see the cancel button (only side
    // allowed by the backend's requireLocationOperator on
    // /api/replenishment/:id/cancel).
    renderWithProviders(<DeliveryPage />, {
      role: 'store_manager',
      locationId: 5,
      locationType: 'store',
    });
    await screen.findByText('Un');
    expect(
      screen.getAllByRole('button', { name: 'Bekor' }).length,
    ).toBeGreaterThan(0);
  });

  it('hides the cancel button for the target-side operator', async () => {
    mockFetch();
    // Render as central_warehouse_manager scoped to target location 2.
    // The target side may advance/assign but not cancel (backend rule
    // — only the requesting bo'g'in can close its own request).
    renderWithProviders(<DeliveryPage />, {
      role: 'central_warehouse_manager',
      locationId: 2,
      locationType: 'central_warehouse',
    });
    await screen.findByText('Un');
    expect(screen.queryByRole('button', { name: 'Bekor' })).toBeNull();
    expect(
      screen.getAllByRole('button', { name: 'Bajarish' }).length,
    ).toBeGreaterThan(0);
  });

  it('renders the task list with product, qty, and assignment state', async () => {
    mockFetch();
    // Stage 4 RBAC — render as central_warehouse_manager scoped to the
    // task's target location (2). That puts isScoped=true so the assign
    // and advance buttons render.
    renderWithProviders(<DeliveryPage />, {
      role: 'central_warehouse_manager',
      locationId: 2,
      locationType: 'central_warehouse',
    });

    expect(await screen.findByText('Un')).toBeInTheDocument();
    expect(screen.getByText('Shakar')).toBeInTheDocument();
    expect(screen.getByText(/Hali hodim biriktirilmagan/)).toBeInTheDocument();
    expect(screen.getAllByText(/Sardor Aliyev/)[0]).toBeInTheDocument();
  });

  it('opens the assign dialog and posts the selected user', async () => {
    mockFetch();
    const user = userEvent.setup();
    // Stage 4 RBAC — render as central_warehouse_manager scoped to the
    // task's target location (2). That puts isScoped=true so the assign
    // and advance buttons render.
    renderWithProviders(<DeliveryPage />, {
      role: 'central_warehouse_manager',
      locationId: 2,
      locationType: 'central_warehouse',
    });

    await screen.findByText('Un');
    const unassignedCard = screen.getByTestId('delivery-task-1');
    const assignBtn = unassignedCard.querySelector('button');
    // The first button in the unassigned card is "Biriktirish"
    if (!assignBtn) throw new Error('no assign button');
    await user.click(assignBtn);

    const select = await screen.findByLabelText('Yetkazib beruvchi hodim');
    await user.selectOptions(select, '10');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      // PATCH should have fired against the assign endpoint with user_id=10.
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const assignCall = calls.find(([url]) =>
        String(url).includes('/api/delivery/tasks/1/assign'),
      );
      expect(assignCall).toBeDefined();
      const body = JSON.parse(String(assignCall?.[1]?.body ?? '{}'));
      expect(body).toEqual({ user_id: 10 });
    });
  });
});
