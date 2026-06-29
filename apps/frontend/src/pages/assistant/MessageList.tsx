import { useEffect, useRef } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssistantMessage } from '@/lib/types';
import { MessageItem, AssistantAvatar } from './MessageItem';

/**
 * Suggestions shown on the empty state. Wired to the four sample prompts in
 * the team-lead brief — kept here (not in a config file) because they are
 * UX copy, not data.
 */
export const STARTER_PROMPTS: readonly string[] = [
  'Markaziy skladda nima qizil holatda?',
  'Bugun qaysi zayafkalar tayyor bo‘lishi kerak?',
  'Filial-1 da Shokoladli tort yetarlimi?',
  'Oxirgi 7 kunda eng ko‘p sotilgan mahsulot?',
];

interface MessageListProps {
  messages: AssistantMessage[];
  /** While `true`, an "AI o'ylamoqda..." row is appended at the tail. */
  isThinking: boolean;
  /** Click handler for an empty-state starter chip. */
  onSelectPrompt?: (prompt: string) => void;
  /** Forwarded to `MessageItem` → `PendingActionCard`. */
  onConfirmAction?: (actionId: number) => Promise<void>;
  /** Forwarded to `MessageItem` → `PendingActionCard`. */
  onRejectAction?: (actionId: number) => Promise<void>;
  /** Currently in-flight confirm/reject request, or null. */
  actionRequest?: { actionId: number; kind: 'confirm' | 'reject' } | null;
  /** Map of action id → last error message from a failed confirm/reject. */
  actionErrors?: Record<number, string>;
  className?: string;
}

/**
 * Scrollable, role-aware chat transcript.
 *
 * Auto-scrolls to the bottom whenever messages length or `isThinking`
 * flips — but only if the user is already near the bottom (so reading
 * older history is not yanked away when a new turn lands).
 */
export function MessageList({
  messages,
  isThinking,
  onSelectPrompt,
  onConfirmAction,
  onRejectAction,
  actionRequest = null,
  actionErrors = {},
  className,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      // Defer so the new row has laid out.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages.length, isThinking]);

  if (messages.length === 0 && !isThinking) {
    return (
      <div
        ref={containerRef}
        className={cn(
          'flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-10 text-center',
          className,
        )}
        data-testid="message-list-empty"
      >
        <AssistantAvatar className="size-12" />
        <div className="max-w-md space-y-2">
          <h3 className="text-base font-semibold">
            Salom! ADIA ERP yordamchisiman.
          </h3>
          <p className="text-sm text-muted-foreground">
            Quyidagi savollar bilan boshlashingiz mumkin:
          </p>
        </div>
        <ul className="w-full max-w-md space-y-2">
          {STARTER_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => onSelectPrompt?.(prompt)}
                disabled={!onSelectPrompt}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md border border-border/70 bg-card/50 px-3 py-2 text-left text-sm text-foreground transition-colors',
                  'hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:opacity-60',
                )}
              >
                <Sparkles
                  className="size-3.5 shrink-0 text-info"
                  aria-hidden="true"
                />
                <span className="flex-1">{prompt}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6',
        className,
      )}
      role="log"
      aria-label="AI yordamchi suhbati"
      aria-live="polite"
    >
      {messages.map((message, idx) => (
        <MessageItem
          key={`${message.role}-${idx}-${message.created_at}`}
          message={message}
          onConfirmAction={onConfirmAction}
          onRejectAction={onRejectAction}
          actionRequest={actionRequest}
          actionErrors={actionErrors}
        />
      ))}
      {isThinking && <ThinkingRow />}
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="flex items-center gap-3" data-testid="thinking-row">
      <AssistantAvatar className="size-7" />
      <span className="inline-flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        AI o‘ylamoqda…
      </span>
    </div>
  );
}
