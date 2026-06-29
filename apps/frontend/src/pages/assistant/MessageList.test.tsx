import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList, STARTER_PROMPTS } from './MessageList';
import type { AssistantMessage } from '@/lib/types';

function makeMessage(
  role: AssistantMessage['role'],
  content: string,
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role,
    content,
    created_at: '2026-05-23T08:00:00.000Z',
    ...extra,
  };
}

describe('MessageList', () => {
  it('shows the empty state with the four starter prompts when no messages', () => {
    render(
      <MessageList
        messages={[]}
        isThinking={false}
        onSelectPrompt={() => {}}
      />,
    );
    expect(screen.getByTestId('message-list-empty')).toBeInTheDocument();
    for (const prompt of STARTER_PROMPTS) {
      expect(screen.getByText(prompt)).toBeInTheDocument();
    }
  });

  it('fires onSelectPrompt with the clicked starter chip text', async () => {
    const onSelectPrompt = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageList
        messages={[]}
        isThinking={false}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    const firstPrompt = STARTER_PROMPTS[0];
    if (firstPrompt === undefined) throw new Error('expected starter prompts');
    await user.click(screen.getByText(firstPrompt));
    expect(onSelectPrompt).toHaveBeenCalledWith(firstPrompt);
  });

  it('renders user and assistant messages with distinct roles', () => {
    render(
      <MessageList
        messages={[
          makeMessage('user', 'Hi'),
          makeMessage('assistant', '**Salom**, qanday yordam beraman?'),
        ]}
        isThinking={false}
      />,
    );
    const userRow = document.querySelector('[data-role="user"]');
    const assistantRow = document.querySelector('[data-role="assistant"]');
    expect(userRow).not.toBeNull();
    expect(assistantRow).not.toBeNull();
    expect(userRow?.textContent).toContain('Hi');
    // Markdown bold renders inside a <strong> only on the assistant turn.
    const strong = assistantRow?.querySelector('strong');
    expect(strong?.textContent).toBe('Salom');
  });

  it('renders the thinking indicator when isThinking is true', () => {
    render(
      <MessageList
        messages={[makeMessage('user', 'Salom')]}
        isThinking
      />,
    );
    expect(screen.getByTestId('thinking-row')).toBeInTheDocument();
    expect(screen.getByText(/AI o.ylamoqda/)).toBeInTheDocument();
  });

  it('renders a PendingActionCard on the assistant turn when a pending_action is attached', () => {
    render(
      <MessageList
        messages={[
          makeMessage('assistant', 'Tasdiqlaysizmi?', {
            pending_action: {
              action_id: 1,
              tool_name: 'transfer_stock',
              summary: 'Markaziy sklad → Filial-2: 5 dona Tort',
              args: { qty: 5 },
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        ]}
        isThinking={false}
      />,
    );
    const card = screen.getByTestId('pending-action-card');
    expect(card).toBeInTheDocument();
    expect(card.getAttribute('data-action-status')).toBe('pending');
  });

  it('renders a resolved action_result card (executed) without buttons', () => {
    render(
      <MessageList
        messages={[
          makeMessage('assistant', 'Bajardim', {
            action_result: {
              action_id: 7,
              tool_name: 'transfer_stock',
              summary: 'Markaziy sklad → Filial-2: 5 dona Tort',
              status: 'executed',
            },
          }),
        ]}
        isThinking={false}
      />,
    );
    const card = screen.getByTestId('pending-action-card');
    expect(card.getAttribute('data-action-status')).toBe('executed');
    expect(
      screen.queryByTestId('pending-action-confirm'),
    ).not.toBeInTheDocument();
  });

  it('renders the assistant tool-call chips when provided', () => {
    render(
      <MessageList
        messages={[
          makeMessage('assistant', 'Topdim', {
            tool_calls: [
              {
                tool_name: 'get_below_min',
                args: {},
                result_summary: '2 qator',
              },
            ],
          }),
        ]}
        isThinking={false}
      />,
    );
    expect(screen.getByText(/Min’dan past/)).toBeInTheDocument();
  });
});
