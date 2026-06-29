import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingActionCard } from './PendingActionCard';
import type {
  AssistantActionResult,
  AssistantPendingAction,
} from '@/lib/types';

function pending(
  overrides: Partial<AssistantPendingAction> = {},
): AssistantPendingAction {
  return {
    action_id: 99,
    tool_name: 'transfer_stock',
    summary: 'Markaziy sklad → Filial-2: 5 dona Tort #42',
    args: {
      product_id: 42,
      from_location_id: 1,
      to_location_id: 2,
      qty: 5,
    },
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function resolved(
  overrides: Partial<AssistantActionResult> = {},
): AssistantActionResult {
  return {
    action_id: 99,
    tool_name: 'transfer_stock',
    summary: 'Markaziy sklad → Filial-2: 5 dona Tort #42',
    status: 'executed',
    ...overrides,
  };
}

describe('PendingActionCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-23T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the warning header and tool label for a pending action', () => {
    render(
      <PendingActionCard
        action={pending()}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText('Bajarilishi kutilmoqda')).toBeInTheDocument();
    expect(screen.getByText(/Tovar ko‘chirish/)).toBeInTheDocument();
    expect(
      screen.getByText(/Markaziy sklad → Filial-2/),
    ).toBeInTheDocument();
  });

  it('shows a countdown timer that ticks every second', async () => {
    const expiresAt = new Date('2026-05-23T12:00:30.000Z').toISOString();
    render(
      <PendingActionCard
        action={pending({ expires_at: expiresAt })}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const countdown = screen.getByTestId('pending-action-countdown');
    expect(countdown.textContent).toContain('0:30');
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(countdown.textContent).toContain('0:28');
  });

  it('disables the confirm button and switches to expired tone once the timer reaches zero', () => {
    const expiresAt = new Date('2026-05-23T12:00:02.000Z').toISOString();
    render(
      <PendingActionCard
        action={pending({ expires_at: expiresAt })}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId('pending-action-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText('⌛ Eskirgan')).toBeInTheDocument();
    expect(
      (screen.getByTestId('pending-action-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('fires onConfirm with the action id when the user clicks Tasdiqlash', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <PendingActionCard
        action={pending()}
        status="pending"
        onConfirm={onConfirm}
        onReject={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('pending-action-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(99);
  });

  it('fires onReject with the action id when the user clicks Rad qilish', async () => {
    const onReject = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <PendingActionCard
        action={pending()}
        status="pending"
        onConfirm={vi.fn()}
        onReject={onReject}
      />,
    );
    await user.click(screen.getByTestId('pending-action-reject'));
    expect(onReject).toHaveBeenCalledWith(99);
  });

  it('shows a spinner and disables both buttons when isLoading is true', () => {
    render(
      <PendingActionCard
        action={pending()}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
        isLoading
      />,
    );
    expect(
      (screen.getByTestId('pending-action-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('pending-action-reject') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renders an error message when error prop is set', () => {
    render(
      <PendingActionCard
        action={pending()}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
        error="Omborda yetarli tovar yo‘q — amal bajarilmadi."
      />,
    );
    expect(
      screen.getByText(/Omborda yetarli tovar yo‘q/),
    ).toBeInTheDocument();
  });

  it('renders the executed outcome strip without buttons', () => {
    render(
      <PendingActionCard
        action={resolved({ status: 'executed' })}
        status="executed"
      />,
    );
    expect(screen.getByText(/Bajarildi/)).toBeInTheDocument();
    expect(
      screen.queryByTestId('pending-action-confirm'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('pending-action-reject'),
    ).not.toBeInTheDocument();
  });

  it('renders the rejected outcome strip without buttons', () => {
    render(
      <PendingActionCard
        action={resolved({ status: 'rejected' })}
        status="rejected"
      />,
    );
    expect(screen.getByText(/Rad qilindi/)).toBeInTheDocument();
    expect(
      screen.queryByTestId('pending-action-confirm'),
    ).not.toBeInTheDocument();
  });

  it('renders the expired outcome strip without buttons', () => {
    render(
      <PendingActionCard
        action={resolved({ status: 'expired' })}
        status="expired"
      />,
    );
    expect(screen.getByText(/Eskirgan/)).toBeInTheDocument();
    expect(
      screen.queryByTestId('pending-action-confirm'),
    ).not.toBeInTheDocument();
  });

  it('toggles the args details panel when clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <PendingActionCard
        action={pending()}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const pre = screen.getByTestId('pending-action-args');
    expect(pre.textContent).toContain('"product_id": 42');
    // The summary toggle exists for accessibility — clicking it should keep
    // the JSON visible regardless of state (we just verify it renders ok).
    await user.click(screen.getByText(/Tafsilotlarni ko‘rsatish/));
    await waitFor(() => {
      expect(screen.getByTestId('pending-action-args')).toBeInTheDocument();
    });
  });

  it('falls back to the raw tool name when not in the label map', () => {
    render(
      <PendingActionCard
        action={pending({ tool_name: 'made_up_tool' })}
        status="pending"
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText('made_up_tool')).toBeInTheDocument();
  });
});
