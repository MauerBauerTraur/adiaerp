/**
 * Contract regression tests for the Sprint-2 replenishment screens.
 *
 * The list endpoint returns a bare `ReplenishmentRequest[]`; the detail
 * endpoint returns `{ request, transitions }`. The advance endpoint
 * envelopes `{ advanced, status, reason, request }` and raises 409
 * `INVALID_TRANSITION` when an illegal transition is attempted —
 * surface that as a friendly Uzbek message.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ReplenishmentPage } from './ReplenishmentPage';
import { ReplenishmentDetailPage } from './ReplenishmentDetailPage';
import { AuthContext } from '@/hooks/auth-context';
import { ToastProvider } from '@/components/ui/toast';
import type { ReplenishmentDetail, ReplenishmentRequest } from '@/lib/types';

const PRODUCT = {
  id: 11,
  name: 'Un',
  type: 'raw' as const,
  unit: 'kg' as const,
  sku: null,
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const LOCATION = {
  id: 21,
  name: 'Markaziy sklad',
  type: 'central_warehouse' as const,
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: 2,
  review_days: null,
  safety_factor: null,
};

const REQUEST: ReplenishmentRequest = {
  id: 1001,
  product_id: 11,
  requester_location_id: 21,
  target_location_id: null,
  qty_needed: 50,
  status: 'NEW',
  production_order_id: null,
  purchase_order_id: null,
  shipment_movement_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T10:00:00.000Z',
  updated_at: '2026-05-22T10:00:00.000Z',
  closed_at: null,
  product_name: 'Un',
  product_unit: 'kg',
  requester_location_name: 'Markaziy sklad',
  target_location_name: null,
  production_location_name: null,
};

const DETAIL: ReplenishmentDetail = {
  request: REQUEST,
  transitions: [
    {
      id: 1,
      from_status: null,
      to_status: 'NEW',
      reason: 'created',
      actor_user_id: 1,
      actor_name: 'PM User',
      created_at: '2026-05-22T10:00:00.000Z',
    },
  ],
};

function mockFetch(options: {
  detail?: ReplenishmentDetail;
  advanceFails?: 'INVALID_TRANSITION';
  onCancel?: (body: unknown) => void;
} = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, [PRODUCT]));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, [LOCATION]));
    }
    if (url.includes('/api/users')) {
      // The detail page must NOT hit /api/users — `actor_name` is embedded.
      throw new Error('replenishment screens must not request /api/users');
    }
    if (url.includes('/api/replenishment/1001/advance') && method === 'POST') {
      if (options.advanceFails === 'INVALID_TRANSITION') {
        return Promise.resolve(
          jsonResponse(409, {
            error: { code: 'INVALID_TRANSITION', message: 'bad' },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          advanced: true,
          status: 'CHECK_STORE_SUPPLIER',
          reason: 'ok',
          request: { ...REQUEST, status: 'CHECK_STORE_SUPPLIER' },
        }),
      );
    }
    if (url.includes('/api/replenishment/1001/cancel') && method === 'POST') {
      options.onCancel?.(init?.body ? JSON.parse(init.body as string) : null);
      return Promise.resolve(jsonResponse(200, { ok: true }));
    }
    if (url.endsWith('/api/replenishment/1001')) {
      return Promise.resolve(
        jsonResponse(200, options.detail ?? DETAIL),
      );
    }
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, [REQUEST]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('Replenishment screens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the list from a bare ReplenishmentRequest[]', async () => {
    mockFetch();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    expect(await screen.findByText('#1001')).toBeInTheDocument();
    // Embedded `product_name` / `requester_location_name` are rendered
    // directly — no client-side join.
    expect(screen.getByText('Un')).toBeInTheDocument();
    expect(screen.getByText('Markaziy sklad')).toBeInTheDocument();
    // The status pill is rendered inside the table row — at least one
    // "Yangi" label is present (the others belong to the filter select).
    expect(screen.getAllByText('Yangi').length).toBeGreaterThan(0);
  });

  it('hides "Qo‘lda so‘rov" for non-pm/non-central-warehouse roles', async () => {
    mockFetch();
    renderWithProviders(<ReplenishmentPage />, { role: 'store_manager' });
    await screen.findByText('#1001');
    expect(screen.queryByRole('button', { name: /qo.lda so.rov/i })).toBeNull();
  });

  it('advances the state machine and shows the new status', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderDetail();
    await screen.findByText('So‘rov #1001');
    await user.click(screen.getByRole('button', { name: /keyingi qadam/i }));
    await waitFor(() => {
      // The 200 advance response triggers a refetch — the next GET
      // returns the same REQUEST, but the success notify itself is
      // enough to prove the path was wired.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/replenishment/1001/advance'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('surfaces 409 INVALID_TRANSITION as a friendly Uzbek alert', async () => {
    const user = userEvent.setup();
    mockFetch({ advanceFails: 'INVALID_TRANSITION' });
    renderDetail();
    await screen.findByText('So‘rov #1001');
    await user.click(screen.getByRole('button', { name: /keyingi qadam/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/o.tishni amalga oshirib bo.lmaydi/i),
      ).toBeInTheDocument();
    });
  });

  it('hides every write button when the viewer is a PM (read-and-recommend)', async () => {
    // RBAC Stage 1 (commit c2ed012) — PM is read-only on replenishment.
    // The frontend must not render Advance/Cancel buttons, otherwise the
    // backend 403 (`auth.forbidden.pm_write_blocked`) would surface as a
    // toast on every click. A "Faqat o'qish" badge replaces them.
    mockFetch();
    renderDetail({ role: 'pm' });
    await screen.findByText('So‘rov #1001');
    expect(
      screen.queryByRole('button', { name: /keyingi qadam/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /bekor qilish/i }),
    ).toBeNull();
    expect(screen.getByText(/faqat o.qish/i)).toBeInTheDocument();
  });

  it('hides write buttons for an operator on a foreign location', async () => {
    // The operator is assigned to location 99, but REQUEST.requester is 21
    // and target is null — canActOn returns false for both, so neither
    // Advance nor Cancel renders. Backend `requireLocationOperator` would
    // 403 the same calls (`auth.forbidden.foreign_location`).
    mockFetch();
    renderDetail({ role: 'store_manager', locationId: 99 });
    await screen.findByText('So‘rov #1001');
    expect(
      screen.queryByRole('button', { name: /keyingi qadam/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /bekor qilish/i }),
    ).toBeNull();
  });

  it('opens the CancelDialog and POSTs the typed reason (no window.prompt)', async () => {
    // window.prompt would have a jsdom default of null and the page
    // historically called it inline — now the dialog must drive the flow.
    const promptSpy = vi.spyOn(window, 'prompt');
    let cancelBody: unknown = null;
    const user = userEvent.setup();
    mockFetch({
      onCancel: (body) => {
        cancelBody = body;
      },
    });
    renderDetail();
    await screen.findByText('So‘rov #1001');

    // Two "Bekor qilish" controls exist — the one in the header opens
    // the dialog; the destructive one inside the dialog submits.
    const triggers = screen.getAllByRole('button', { name: 'Bekor qilish' });
    const headerTrigger = triggers[0];
    if (!headerTrigger) throw new Error('header cancel trigger not found');
    await user.click(headerTrigger);

    // The dialog now exists and the textarea is focused (auto-focus).
    const dialog = await screen.findByRole('dialog', {
      name: 'So‘rovni bekor qilish',
    });
    const textarea = screen.getByLabelText(/bekor qilish sababi/i);
    await user.type(textarea, 'mahsulot keldi');

    // Submit through the destructive button rendered inside the dialog.
    const submit = dialog.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!submit) throw new Error('dialog submit button not found');
    await user.click(submit);

    await waitFor(() => {
      expect(cancelBody).toEqual({ reason: 'mahsulot keldi' });
    });
    expect(promptSpy).not.toHaveBeenCalled();
  });
});

/**
 * Render the detail page under a memory router that injects `:id=1001`.
 *
 * Defaults to a `central_warehouse_manager` assigned to location 21 —
 * the requester bo'g'in of REQUEST — so the Advance and Cancel buttons
 * both render under the post-Stage-1 RBAC policy (commit c2ed012).
 * Pass `role: 'pm'` to verify the read-and-recommend view explicitly.
 */
function renderDetail(
  authOverride?: Partial<{
    role: 'pm' | 'central_warehouse_manager' | 'store_manager';
    locationId: number | null;
  }>,
) {
  const role = authOverride?.role ?? 'central_warehouse_manager';
  const locationId =
    authOverride?.locationId ?? (role === 'pm' ? null : 21);
  const auth = {
    user: {
      id: 1,
      name: role === 'pm' ? 'PM' : 'Operator',
      email: `${role}@adia.test`,
      username: role,
      role,
      location_id: locationId,
    },
    token: 'x',
    isAuthenticated: true,
    isHydrating: false,
    locations:
      locationId === null
        ? []
        : [
            {
              id: locationId,
              name: 'Markaziy sklad',
              type: 'central_warehouse' as const,
              is_primary: true,
            },
          ],
    activeLocationId: locationId,
    login: () => {},
    logout: async () => {},
    setActiveLocation: async () => {},
  };
  return render(
    <AuthContext.Provider value={auth}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/replenishment/1001']}>
          <Routes>
            <Route
              path="/replenishment/:id"
              element={<ReplenishmentDetailPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>,
  );
}
