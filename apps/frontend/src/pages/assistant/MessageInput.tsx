import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface MessageInputProps {
  /** Called with a trimmed, non-empty message string. */
  onSend: (text: string) => void;
  /** When `true`, the textarea/send are disabled and the spinner shows. */
  isSending: boolean;
  /** Optional preload string (e.g. "preload starter prompt then send"). */
  initialValue?: string;
  /**
   * Bump this value to force a re-preload of `initialValue` even when
   * the string itself is unchanged (e.g. the user re-clicks the same
   * starter chip after the textarea was cleared by a previous send).
   * If unset, `initialValue` alone drives the preload effect.
   */
  preloadNonce?: number;
  /** Placeholder text. */
  placeholder?: string;
  /** Autofocus textarea on mount (drawer opens with focus on input). */
  autoFocus?: boolean;
}

/**
 * Chat composer.
 *
 * Keyboard contract:
 *  - Enter         → send (when message is non-empty)
 *  - Shift+Enter   → newline (default browser behaviour)
 *  - Escape        → blur textarea (lets the parent close the drawer)
 *
 * The textarea grows up to 6 lines, then scrolls — keeping the drawer
 * compact while allowing the occasional multi-paragraph question.
 */
export function MessageInput({
  onSend,
  isSending,
  initialValue,
  preloadNonce,
  placeholder = 'AI yordamchidan so‘rang…',
  autoFocus = false,
}: MessageInputProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // External preload (starter prompt clicked). Each time `initialValue`
  // changes — OR the parent bumps `preloadNonce` to signal "re-preload
  // the same string" — overwrite the textarea. The previous guard
  // (`value.length === 0`) made the second click on a starter chip a
  // no-op because the first click had already filled the textarea.
  // The empty-string short-circuit keeps the parent from wiping a
  // user's in-progress draft when it re-renders with a stale default
  // of "" (the mount case is handled by `useState(initialValue)`).
  useEffect(() => {
    if (initialValue !== undefined && initialValue !== '') {
      setValue(initialValue);
    }
  }, [initialValue, preloadNonce]);

  // Auto-grow up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24; // ~6 lines at line-height 24
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  function submit() {
    const trimmed = value.trim();
    if (trimmed.length === 0 || isSending) return;
    onSend(trimmed);
    setValue('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      textareaRef.current?.blur();
    }
  }

  const canSend = value.trim().length > 0 && !isSending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-border/60 bg-card/60 px-4 py-3 backdrop-blur"
    >
      <label htmlFor="assistant-input" className="sr-only">
        Xabar yozing
      </label>
      <textarea
        id="assistant-input"
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        disabled={isSending}
        className={cn(
          'flex w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
        style={{ minHeight: 40, maxHeight: 144 }}
        aria-label="AI yordamchiga xabar"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!canSend}
        aria-label="Yuborish"
        className="shrink-0"
      >
        {isSending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Send className="size-4" aria-hidden="true" />
        )}
      </Button>
    </form>
  );
}
