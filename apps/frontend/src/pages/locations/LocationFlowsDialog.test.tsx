/**
 * LocationFlowsDialog (EPIC 2.1) — admin connection (oqim) management.
 *
 * What we pin:
 *   1. On open the dialog GETs `/api/locations/flows` and renders each flow
 *      with its source → target names and an Uzbek flow-type badge.
 *   2. Adding a flow POSTs `{from_location_id, to_location_id, flow_type}` and
 *      then re-fetches the list.
 *   3. Same source and target is rejected client-side without firing a POST.
 *   4. A failing list load surfaces a friendly notice instead of crashing
 *      (the backend CRUD endpoint does not exist yet — Wave-5 TODO).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationFlowsDialog } from './LocationFlowsDialog';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import type { Location, LocationFlow } from '@/lib/types';

const LOCATIONS: Location[] = [
  {
    id: 1,
    name: 'Tort sexi',
    type: 'production',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 2,
    name: 'Tort skladi',
    type: 'sex_storage',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 3,
    name: 'Markaziy Sklad',
    type: 'central_warehouse',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
];

const EXISTING: LocationFlow[] = [
  { id: 100, from_location_id: 1, to_location_id: 2, flow_type: 'production_output', note: null },
];

describe('LocationFlowsDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and renders existing flows with source → target and a flow-type badge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, EXISTING));

    renderWithProviders(
      <LocationFlowsDialog
        open={true}
        onOpenChange={() => {}}
        allLocations={LOCATIONS}
      />,
    );

    // The flow-type badge text is unique to the rendered flow row (it never
    // appears in the location <option> lists), so it is the reliable anchor.
    await waitFor(() => {
      expect(screen.getByText('Ishlab chiqarish chiqishi')).toBeTruthy();
    });
    // The delete button's aria-label embeds both endpoint names — proves the
    // row rendered the source → target pair (the names also appear as <option>
    // text, hence the scoped aria-label assertion instead of getByText).
    expect(
      screen.getByRole('button', {
        name: 'Tort sexi → Tort skladi oqimini o‘chirish',
      }),
    ).toBeTruthy();
  });

  it('POSTs a new flow and refetches the list', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // 1) initial list load
      .mockResolvedValueOnce(jsonResponse(200, []))
      // 2) POST add
      .mockResolvedValueOnce(jsonResponse(201, { flow: { id: 101 } }))
      // 3) refetch after add
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: 101, from_location_id: 2, to_location_id: 3, flow_type: 'forward', note: null },
        ]),
      );

    renderWithProviders(
      <LocationFlowsDialog
        open={true}
        onOpenChange={() => {}}
        allLocations={LOCATIONS}
      />,
    );
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Hozircha oqimlar yo‘q.')).toBeTruthy();
    });

    await user.selectOptions(screen.getByLabelText('Manba bo‘g‘in'), '2');
    await user.selectOptions(screen.getByLabelText('Qabul bo‘g‘in'), '3');
    await user.selectOptions(screen.getByLabelText('Oqim turi'), 'forward');
    await user.click(screen.getByRole('button', { name: 'Qo‘shish' }));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
    });

    const postCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    const url = typeof postCall[0] === 'string' ? postCall[0] : postCall[0]!.toString();
    expect(url).toContain('/api/locations/flows');
    const body = JSON.parse((postCall[1] as RequestInit).body as string);
    expect(body.from_location_id).toBe(2);
    expect(body.to_location_id).toBe(3);
    expect(body.flow_type).toBe('forward');
  });

  it('rejects identical source and target without firing a POST', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, []));

    renderWithProviders(
      <LocationFlowsDialog
        open={true}
        onOpenChange={() => {}}
        allLocations={LOCATIONS}
      />,
    );
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Hozircha oqimlar yo‘q.')).toBeTruthy();
    });

    await user.selectOptions(screen.getByLabelText('Manba bo‘g‘in'), '2');
    await user.selectOptions(screen.getByLabelText('Qabul bo‘g‘in'), '2');
    await user.click(screen.getByRole('button', { name: 'Qo‘shish' }));

    expect(screen.getByRole('alert').textContent).toMatch(/bir xil/i);
    // Only the initial GET should have fired — no POST.
    const posted = fetchSpy.mock.calls.some(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posted).toBe(false);
  });

  it('shows a friendly notice when the list load fails (Wave-5 backend TODO)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Topilmadi.' } }),
    );

    renderWithProviders(
      <LocationFlowsDialog
        open={true}
        onOpenChange={() => {}}
        allLocations={LOCATIONS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });
    expect(screen.getByRole('status').textContent).toMatch(/Topilmadi/);
  });
});
