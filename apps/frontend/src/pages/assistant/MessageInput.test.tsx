import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageInput } from './MessageInput';
import { useState } from 'react';

describe('MessageInput', () => {
  it('calls onSend with trimmed text when Enter is pressed', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    const textarea = screen.getByLabelText('AI yordamchiga xabar');
    await user.type(textarea, '   Salom   ');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Salom');
  });

  it('inserts a newline on Shift+Enter without sending', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    const textarea = screen.getByLabelText(
      'AI yordamchiga xabar',
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'Birinchi');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(textarea, 'Ikkinchi');
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toContain('Birinchi');
    expect(textarea.value).toContain('Ikkinchi');
    expect(textarea.value).toContain('\n');
  });

  it('does not send when the message is only whitespace', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    await user.type(screen.getByLabelText('AI yordamchiga xabar'), '   ');
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables the textarea and send button while sending', () => {
    render(<MessageInput onSend={() => {}} isSending />);
    expect(screen.getByLabelText('AI yordamchiga xabar')).toBeDisabled();
    expect(screen.getByLabelText('Yuborish')).toBeDisabled();
  });

  it('re-applies a starter prompt when the same chip is clicked twice (preloadNonce)', async () => {
    // Regression: the previous `value.length === 0` guard made the
    // second click on a starter chip a no-op because the first click
    // had already filled the textarea. The fix is `preloadNonce` —
    // the parent bumps it on every click so MessageInput re-applies
    // even when the string is identical.
    function Host() {
      const [prompt, setPrompt] = useState<string | undefined>(undefined);
      const [nonce, setNonce] = useState(0);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setPrompt('Bugungi ostatka qanday?');
              setNonce((n) => n + 1);
            }}
          >
            chip
          </button>
          <MessageInput
            onSend={() => {}}
            isSending={false}
            initialValue={prompt}
            preloadNonce={nonce}
          />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<Host />);
    const textarea = screen.getByLabelText(
      'AI yordamchiga xabar',
    ) as HTMLTextAreaElement;
    const chip = screen.getByRole('button', { name: 'chip' });

    // First click — textarea preloads.
    await user.click(chip);
    expect(textarea.value).toBe('Bugungi ostatka qanday?');

    // Simulate the user clearing the textarea (e.g. after a send).
    await user.clear(textarea);
    expect(textarea.value).toBe('');

    // Second click on the SAME chip — must preload again.
    await user.click(chip);
    expect(textarea.value).toBe('Bugungi ostatka qanday?');
  });

  it('clears the textarea after a successful send', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    const textarea = screen.getByLabelText(
      'AI yordamchiga xabar',
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'test');
    await user.click(screen.getByLabelText('Yuborish'));
    expect(onSend).toHaveBeenCalledWith('test');
    expect(textarea.value).toBe('');
  });
});
