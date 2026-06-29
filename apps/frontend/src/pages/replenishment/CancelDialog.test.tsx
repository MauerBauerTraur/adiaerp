/**
 * Component tests for CancelDialog.
 *
 * The Faza-1 replenishment cancel flow used `window.prompt`, which broke
 * the dark-premium aesthetic and skipped keyboard / a11y hooks. These
 * tests pin the replacement contract:
 *
 *  - the dialog renders a labelled textarea and a destructive submit
 *    button (so the cancel intent is obvious);
 *  - submitting an empty textarea hands `undefined` to the parent — the
 *    backend accepts `reason` as optional;
 *  - submitting a populated textarea hands the trimmed string back;
 *  - "Rad et" and `onOpenChange(false)` close the dialog without calling
 *    `onConfirm` (no accidental cancellations).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CancelDialog } from './CancelDialog';

describe('CancelDialog', () => {
  it('renders the title, labelled textarea, and destructive action', () => {
    render(
      <CancelDialog open onOpenChange={() => {}} onConfirm={() => {}} />,
    );

    // Title is wired via aria-labelledby — Radix exposes the dialog as a
    // role="dialog" with an accessible name pulled from the title element.
    expect(
      screen.getByRole('dialog', { name: 'So‘rovni bekor qilish' }),
    ).toBeInTheDocument();

    // The textarea has a visible label and a stable id for forms/tests.
    const textarea = screen.getByLabelText(/bekor qilish sababi/i);
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveAttribute('id', 'cancel-reason');
    expect(textarea).toHaveAttribute('name', 'reason');
    expect(textarea).toHaveAttribute('maxLength', '500');

    // Destructive button is present and uses the destructive variant
    // (red surface from the cobalt palette).
    const destructive = screen.getByRole('button', { name: 'Bekor qilish' });
    expect(destructive.className).toMatch(/bg-destructive/);
  });

  it('submits `undefined` when the textarea is empty (optional reason)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CancelDialog open onOpenChange={() => {}} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole('button', { name: 'Bekor qilish' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('submits the trimmed reason when the textarea is filled', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CancelDialog open onOpenChange={() => {}} onConfirm={onConfirm} />,
    );

    await user.type(
      screen.getByLabelText(/bekor qilish sababi/i),
      '   ortiqcha so‘rov   ',
    );
    await user.click(screen.getByRole('button', { name: 'Bekor qilish' }));

    expect(onConfirm).toHaveBeenCalledWith('ortiqcha so‘rov');
  });

  it('closes via "Rad et" without confirming', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CancelDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Rad et' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables both actions while the parent submit is pending', () => {
    render(
      <CancelDialog
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isSubmitting
      />,
    );

    expect(screen.getByRole('button', { name: 'Rad et' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /bekor qilish/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText(/bekor qilish sababi/i)).toBeDisabled();
  });

  it('resets the textarea when the dialog re-opens', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CancelDialog open onOpenChange={() => {}} onConfirm={() => {}} />,
    );

    await user.type(
      screen.getByLabelText(/bekor qilish sababi/i),
      'birinchi urinish',
    );

    // Close, then reopen — Faza-1 audit asked that a stale reason never
    // leaks into the next cancel attempt.
    rerender(
      <CancelDialog
        open={false}
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />,
    );
    rerender(
      <CancelDialog open onOpenChange={() => {}} onConfirm={() => {}} />,
    );

    expect(screen.getByLabelText(/bekor qilish sababi/i)).toHaveValue('');
  });
});
