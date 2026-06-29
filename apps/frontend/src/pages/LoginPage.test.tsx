import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/AuthProvider';
import { ToastProvider } from '@/components/ui/toast';
import { clearTokens } from '@/lib/auth-storage';
import { LoginPage } from './LoginPage';

function renderLogin() {
  return render(
    <AuthProvider>
      <ToastProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </ToastProvider>
    </AuthProvider>,
  );
}

/** Build a fake `fetch` Response. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LoginPage', () => {
  beforeEach(() => {
    clearTokens();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('labels every form field with an id (WCAG)', () => {
    renderLogin();
    // Username-only identity (migration 0027) — a single `login` field
    // carrying the username; type=text, autocomplete=username.
    expect(
      screen.getByLabelText('Foydalanuvchi nomi'),
    ).toHaveAttribute('id', 'login');
    expect(screen.getByLabelText('Parol')).toHaveAttribute('id', 'password');
    expect(
      screen.getByLabelText('Foydalanuvchi nomi'),
    ).toHaveAttribute('name', 'login');
    expect(
      screen.getByLabelText('Foydalanuvchi nomi'),
    ).toHaveAttribute('type', 'text');
    expect(
      screen.getByLabelText('Foydalanuvchi nomi'),
    ).toHaveAttribute('autocomplete', 'username');
  });

  it('POSTs {login, password} (username-only login handle)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        access_token: 'A',
        refresh_token: 'R',
        user: {
          id: 1,
          name: 'PM',
          username: 'pm',
          role: 'pm',
          location_id: null,
        },
      }),
    );
    const user = userEvent.setup();
    renderLogin();

    // The username "pm" — not an email — must be sent in the `login` field.
    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'pm',
    );
    await user.type(screen.getByLabelText('Parol'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ login: 'pm', password: 'secret123' });
    // Explicitly: the legacy `email` field must NOT be sent.
    expect(body.email).toBeUndefined();
  });

  it('shows an Uzbek error message on invalid credentials (401)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'bad' },
      }),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'x@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'wrongpass');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Login yoki parol noto‘g‘ri.',
      );
    });
  });

  it('stores access_token and refresh_token on a successful login', async () => {
    // Sprint 3 backend contract — login returns BOTH tokens; the
    // backward-compat `token` field is ignored by the client now.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        access_token: 'A_NEW',
        refresh_token: 'R_NEW',
        token: 'A_NEW',
        user: {
          id: 1,
          name: 'PM',
          username: 'pm',
          role: 'pm',
          location_id: null,
        },
      }),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'pm@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('adia.access_token')).toBe('A_NEW');
    });
    expect(window.localStorage.getItem('adia.refresh_token')).toBe('R_NEW');
    // No legacy `adia.token` key is ever written.
    expect(window.localStorage.getItem('adia.token')).toBeNull();
  });

  it('persists the user primary location_id as the active-location on login (Bug-MAJ-01)', async () => {
    // F4.11 Bug-MAJ-01 — without this, a freshly-logged-in scoped
    // manager has no `adia.active_location` in localStorage and the
    // next `apiRequest` would skip the `X-Active-Location` header,
    // breaking routes (`/api/supply`) that 500 on a missing header.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        access_token: 'A',
        refresh_token: 'R',
        user: {
          id: 7,
          name: 'Supply menejeri',
          username: 'supply',
          role: 'supply_manager',
          location_id: 42,
        },
      }),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'supply@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      // `adia.active_location` is the localStorage key written by
      // `auth-storage.setActiveLocation`; the value mirrors the user's
      // primary `location_id` from the login response.
      expect(window.localStorage.getItem('adia.active_location')).toBe('42');
    });
  });

  it('does NOT persist active-location for chain-wide roles (Bug-MAJ-01)', async () => {
    // For `pm` / `ai_assistant` the login response carries
    // `location_id: null`. We must explicitly drop any stale value
    // from a previous session so the PM starts in chain-wide scope.
    window.localStorage.setItem('adia.active_location', '99');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        access_token: 'A',
        refresh_token: 'R',
        user: {
          id: 1,
          name: 'PM',
          username: 'pm',
          role: 'pm',
          location_id: null,
        },
      }),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'pm@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('adia.access_token')).toBe('A');
    });
    expect(window.localStorage.getItem('adia.active_location')).toBeNull();
  });

  it('surfaces a network failure to the user', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    const user = userEvent.setup();
    renderLogin();

    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'x@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
