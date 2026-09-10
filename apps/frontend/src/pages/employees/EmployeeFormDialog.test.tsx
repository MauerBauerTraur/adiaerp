/**
 * EmployeeFormDialog — identity fields + validation.
 *
 * Username-only identity (migration 0027): the form has NO email field;
 * `username` is the required login handle.
 *
 * The bo'g'in picker was removed with migration 0061 — this screen assigns
 * *pages* now (see EmployeeSectionsDialog), and `POST /api/users` derives the
 * location from the role. What we pin here:
 *   1. A create submits only the identity fields — never `location_ids` or
 *      `primary_location_id`, and never an `email`.
 *   2. Validation — a blank/invalid username or a password under 8
 *      characters surfaces the Uzbek error and never fires a fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';

describe('EmployeeFormDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits the identity fields and no location fields', async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={onOpenChange}
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
    // The backend derives the bo'g'in from the role; the form must not
    // second-guess it.
    expect('location_ids' in body).toBe(false);
    expect('primary_location_id' in body).toBe(false);
  });

  it('no longer renders a bo‘g‘in picker', async () => {
    renderWithProviders(
      <EmployeeFormDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('sends the lowercased username in the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
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
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

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
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    // A space is outside the `[a-z0-9._-]` charset — fails validation.
    await user.type(screen.getByLabelText(/foydalanuvchi nomi/i), 'bad name');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

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
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Foydalanuvchi nomi'), 'testuser');
    await user.type(screen.getByLabelText('Parol'), 'short');

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(/8 belgi/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
