/**
 * EmployeeFormDialog (F4.1) — multi-location + primary radio + validation.
 *
 * Username-only identity (migration 0027): the form has NO email field;
 * `username` is the required login handle.
 *
 * What we pin:
 *   1. Selecting two bo'g'inlar then submitting POSTs
 *      `{username, location_ids:[a,b], primary_location_id:a}` to
 *      `/api/users` (and never an `email`).
 *   2. The first checkbox toggled defaults to primary; switching the
 *      radio reassigns primary without altering the selection set.
 *   3. Validation — a blank/invalid username or a password under 8
 *      characters surfaces the Uzbek error and never fires a fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import type { Location } from '@/lib/types';

const LOCATIONS: Location[] = [
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
    id: 11,
    name: 'Filial-2',
    type: 'store',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
];

describe('EmployeeFormDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits {username, location_ids, primary_location_id} for multi-location selection', async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={onOpenChange}
        locations={LOCATIONS}
        onSaved={onSaved}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test Hodim');
    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'test.hodim',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

    // Pick both locations. First toggled becomes primary by default.
    await user.click(screen.getByLabelText('Filial-1'));
    await user.click(screen.getByLabelText('Filial-2'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const call = fetchSpy.mock.calls[0]!;
    const url = typeof call[0] === 'string' ? call[0] : call[0]!.toString();
    expect(url).toContain('/api/users');
    const body = JSON.parse(((call[1] as RequestInit).body as string) ?? '{}');
    expect(body.name).toBe('Test Hodim');
    expect(body.username).toBe('test.hodim');
    // Email was removed from the identity model — never sent.
    expect('email' in body).toBe(false);
    expect(body.password).toBe('pass1234');
    expect(body.role).toBe('store_manager');
    expect(body.location_ids).toEqual([10, 11]);
    expect(body.primary_location_id).toBe(10);
  });

  it('reassigns primary via the radio without changing the selection set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'X');
    await user.type(screen.getByLabelText('Foydalanuvchi nomi'), 'x.user');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

    await user.click(screen.getByLabelText('Filial-1'));
    await user.click(screen.getByLabelText('Filial-2'));

    // Switch primary to Filial-2. The radio is the SECOND "Asosiy" — we
    // pick the radio inside Filial-2's row by id.
    const filial2Primary = document.getElementById(
      'employee-primary-11',
    ) as HTMLInputElement;
    await user.click(filial2Primary);

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.location_ids).toEqual([10, 11]);
    expect(body.primary_location_id).toBe(11);
  });

  it('sends the lowercased username in the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Anvar K');
    await user.type(
      screen.getByLabelText(/foydalanuvchi nomi/i),
      'anvar.k',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.username).toBe('anvar.k');
  });

  it('rejects a blank username without firing a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    // Username is the sole login handle and is required — a blank value
    // surfaces the Uzbek error and never fires a fetch.
    expect(screen.getByRole('alert').textContent).toMatch(
      /foydalanuvchi nomi/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid username pattern client-side', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    // A space is outside the `[a-z0-9._-]` charset — fails validation.
    await user.type(screen.getByLabelText(/foydalanuvchi nomi/i), 'bad name');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(
      /foydalanuvchi nomi/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a password shorter than 8 characters without firing a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Foydalanuvchi nomi'), 'testuser');
    await user.type(screen.getByLabelText('Parol'), 'short');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(/8 belgi/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
