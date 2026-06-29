/**
 * EPIC 3.2 — Telegram self-link control on the merged Hodimlar screen.
 *
 * Pins three behaviours:
 *   - a linked user (telegram_id set) shows the "TG ulangan" badge, no button;
 *   - an unlinked user shows the "TG ulash" button;
 *   - opening the dialog requests a token; a 404 (endpoint not yet shipped)
 *     surfaces the friendly placeholder, never a crash.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { TelegramLinkButton } from './TelegramLinkButton';
import type { User } from '@/lib/types';

const BASE: User = {
  id: 5,
  name: 'Anvar Karimov',
  username: 'anvar',
  role: 'store_manager',
  location_id: 10,
};

describe('TelegramLinkButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a linked badge when telegram_id is set', () => {
    renderWithProviders(
      <TelegramLinkButton user={{ ...BASE, telegram_id: 123456 }} />,
    );
    expect(screen.getByText('TG ulangan')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Telegram ulash/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the friendly placeholder when the link endpoint is not yet deployed (404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(404, { error: { code: 'not_found', message: 'yo‘q' } }),
    );

    renderWithProviders(<TelegramLinkButton user={BASE} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Telegram ulash/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Telegram ulash xizmati hali ishga tushmagan/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the /start command when the token endpoint returns one (no bot username configured)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(201, {
        token: 'abc123',
        expires_at: '2026-05-30T00:00:00.000Z',
        start_command: '/start abc123',
      }),
    );

    renderWithProviders(<TelegramLinkButton user={BASE} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Telegram ulash/i }));

    await waitFor(() => {
      // VITE_TELEGRAM_BOT_USERNAME is unset in the test env → the dialog
      // falls back to the raw /start command rather than a t.me deep link.
      expect(screen.getByText('/start abc123')).toBeInTheDocument();
    });
  });
});
