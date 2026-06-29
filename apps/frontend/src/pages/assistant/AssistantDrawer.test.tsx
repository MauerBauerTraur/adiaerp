import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantDrawer } from './AssistantDrawer';
import {
  jsonResponse,
  renderWithProviders,
} from '@/test/render-helpers';
import type {
  AssistantQueryResponse,
  AssistantSessionsResponse,
} from '@/lib/types';

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Ochish
      </button>
      <AssistantDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('AssistantDrawer', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubSessions(items: AssistantSessionsResponse['items']) {
    const response: AssistantSessionsResponse = {
      items,
      total: items.length,
      limit: 30,
      offset: 0,
    };
    return jsonResponse(200, response);
  }

  it('opens with the empty-state and four starter prompts', async () => {
    fetchMock.mockResolvedValueOnce(stubSessions([]));
    renderWithProviders(<Harness />);
    expect(
      await screen.findByText(/ADIA ERP yordamchisiman/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Markaziy skladda nima qizil holatda?'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('AI yordamchi')).toBeInTheDocument();
  });

  it('sends a message, shows the assistant response and the tool chip', async () => {
    fetchMock
      .mockResolvedValueOnce(stubSessions([]))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          session_id: 42,
          response: 'Markaziy skladda **3** mahsulot qizil.',
          tool_calls: [
            {
              tool_name: 'get_below_min',
              args: {},
              result_summary: '3 qator',
            },
          ],
        } satisfies AssistantQueryResponse),
      );

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const textarea = await screen.findByLabelText('AI yordamchiga xabar');
    await user.type(textarea, 'Nima qizil?');
    await user.keyboard('{Enter}');

    // Wait for the second fetch (the query call) to land.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const queryCall = fetchMock.mock.calls[1];
    if (queryCall === undefined) throw new Error('expected query call');
    expect(queryCall[0]).toContain('/api/assistant/query');
    const body = JSON.parse(queryCall[1].body as string) as {
      message: string;
      session_id?: number;
    };
    expect(body.message).toBe('Nima qizil?');
    expect(body.session_id).toBeUndefined(); // first turn — no session yet

    expect(
      await screen.findByText(/mahsulot qizil/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Min’dan past/)).toBeInTheDocument();
  });

  it('shows a localised error banner when the backend returns 503', async () => {
    fetchMock.mockResolvedValueOnce(stubSessions([])).mockResolvedValueOnce(
      jsonResponse(503, {
        error: { code: 'VERTEX_UNAVAILABLE', message: 'AI down' },
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const textarea = await screen.findByLabelText('AI yordamchiga xabar');
    await user.type(textarea, 'test');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByText(/AI yordamchi vaqtinchalik mavjud emas/),
    ).toBeInTheDocument();
  });

  it('renders a PendingActionCard when the backend returns pending_action and confirms it', async () => {
    fetchMock
      .mockResolvedValueOnce(stubSessions([]))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          session_id: 13,
          response:
            'Quyidagi amalni tasdiqlaysizmi: Markaziy sklad → Filial-2 ga 5 dona Tort?',
          tool_calls: [],
          pending_action: {
            action_id: 501,
            tool_name: 'transfer_stock',
            summary: 'Markaziy sklad → Filial-2: 5 dona Tort Napoleon',
            args: {
              product_id: 42,
              from_location_id: 1,
              to_location_id: 2,
              qty: 5,
            },
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          },
        } satisfies AssistantQueryResponse),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          action: {
            action_id: 501,
            tool_name: 'transfer_stock',
            summary: 'Markaziy sklad → Filial-2: 5 dona Tort Napoleon',
            status: 'executed',
            result: { stock_movement_id: 9001 },
          },
        }),
      );

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const textarea = await screen.findByLabelText('AI yordamchiga xabar');
    await user.type(textarea, 'Filial-2 ga 5 ta tort jo‘nat');
    await user.keyboard('{Enter}');

    // The card appears under the assistant message.
    const card = await screen.findByTestId('pending-action-card');
    expect(card).toBeInTheDocument();
    expect(card.getAttribute('data-action-status')).toBe('pending');
    expect(
      screen.getByText(/Markaziy sklad → Filial-2: 5 dona Tort Napoleon/),
    ).toBeInTheDocument();

    // Confirm the action.
    await user.click(screen.getByTestId('pending-action-confirm'));

    // Backend confirm endpoint was called.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const confirmCall = fetchMock.mock.calls[2];
    if (confirmCall === undefined) throw new Error('expected confirm call');
    expect(confirmCall[0]).toContain('/api/assistant/actions/501/confirm');
    expect((confirmCall[1] as RequestInit).method).toBe('POST');

    // The card flips to the executed outcome strip.
    await waitFor(() => {
      const updated = screen.getByTestId('pending-action-card');
      expect(updated.getAttribute('data-action-status')).toBe('executed');
    });
    expect(screen.getByText(/Bajarildi/)).toBeInTheDocument();
    expect(
      screen.queryByTestId('pending-action-confirm'),
    ).not.toBeInTheDocument();
  });

  it('rejects a pending action and shows the rejected outcome', async () => {
    fetchMock
      .mockResolvedValueOnce(stubSessions([]))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          session_id: 14,
          response: 'Tasdiqlaysizmi?',
          tool_calls: [],
          pending_action: {
            action_id: 777,
            tool_name: 'transfer_stock',
            summary: 'Markaziy sklad → Filial-2: 5 dona Tort Napoleon',
            args: {},
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          },
        } satisfies AssistantQueryResponse),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          action: {
            action_id: 777,
            tool_name: 'transfer_stock',
            summary: 'Markaziy sklad → Filial-2: 5 dona Tort Napoleon',
            status: 'rejected',
          },
        }),
      );

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const textarea = await screen.findByLabelText('AI yordamchiga xabar');
    await user.type(textarea, 'jo‘nat');
    await user.keyboard('{Enter}');

    await screen.findByTestId('pending-action-card');
    await user.click(screen.getByTestId('pending-action-reject'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const rejectCall = fetchMock.mock.calls[2];
    if (rejectCall === undefined) throw new Error('expected reject call');
    expect(rejectCall[0]).toContain('/api/assistant/actions/777/reject');

    await waitFor(() => {
      const updated = screen.getByTestId('pending-action-card');
      expect(updated.getAttribute('data-action-status')).toBe('rejected');
    });
    expect(screen.getByText(/Rad qilindi/)).toBeInTheDocument();
  });

  it('shows a localised error when /confirm returns 410 expired and disables the buttons', async () => {
    fetchMock
      .mockResolvedValueOnce(stubSessions([]))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          session_id: 15,
          response: 'Tasdiqlaysizmi?',
          tool_calls: [],
          pending_action: {
            action_id: 808,
            tool_name: 'transfer_stock',
            summary: 'Test summary',
            args: {},
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          },
        } satisfies AssistantQueryResponse),
      )
      .mockResolvedValueOnce(
        jsonResponse(410, {
          error: { code: 'ACTION_EXPIRED', message: 'expired' },
        }),
      );

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const textarea = await screen.findByLabelText('AI yordamchiga xabar');
    await user.type(textarea, 'test');
    await user.keyboard('{Enter}');

    await screen.findByTestId('pending-action-card');
    await user.click(screen.getByTestId('pending-action-confirm'));

    // Card flips to expired (terminal) and the confirm button is gone.
    await waitFor(() => {
      const updated = screen.getByTestId('pending-action-card');
      expect(updated.getAttribute('data-action-status')).toBe('expired');
    });
    expect(
      screen.queryByTestId('pending-action-confirm'),
    ).not.toBeInTheDocument();
  });

  it('reuses session_id on the second turn', async () => {
    fetchMock
      .mockResolvedValueOnce(stubSessions([]))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          session_id: 7,
          response: 'OK',
          tool_calls: [],
        } satisfies AssistantQueryResponse),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          session_id: 7,
          response: 'OK 2',
          tool_calls: [],
        } satisfies AssistantQueryResponse),
      );

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const textarea = await screen.findByLabelText('AI yordamchiga xabar');
    await user.type(textarea, 'birinchi');
    await user.keyboard('{Enter}');
    await screen.findByText('OK');

    await user.type(textarea, 'ikkinchi');
    await user.keyboard('{Enter}');
    await screen.findByText('OK 2');

    const lastCall = fetchMock.mock.calls[2];
    if (lastCall === undefined) throw new Error('expected third call');
    const lastBody = JSON.parse(lastCall[1].body as string) as {
      message: string;
      session_id?: number;
    };
    expect(lastBody.session_id).toBe(7);
  });
});
