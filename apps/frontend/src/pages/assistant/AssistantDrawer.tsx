import { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Bot, X, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SessionList } from './SessionList';
import { useAssistantChat } from './useAssistantChat';

interface AssistantDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Right-edge slide-in chat drawer (Linear-AI / Vercel-v0 pattern).
 *
 * Layout:
 *  ┌────────────────────────────────────────┐
 *  │   header: title · X close              │
 *  ├──────────┬─────────────────────────────┤
 *  │ sessions │ message list                │
 *  │  list    │ ─────────────────────────── │
 *  │          │ input box                   │
 *  └──────────┴─────────────────────────────┘
 *
 * Width: max-w-3xl (768px) on lg+; full screen on mobile. The sessions
 * column hides below `md:` so phones see a single-column chat with a
 * "Yangi suhbat" button in the header instead.
 *
 * The drawer is mounted as a Radix Dialog so focus-trap and ESC handling
 * come for free; the visual sheet behaviour is built with custom Tailwind
 * data-state animations.
 */
export function AssistantDrawer({ open, onOpenChange }: AssistantDrawerProps) {
  const chat = useAssistantChat(open);

  // Carry a one-shot starter prompt from the empty-state button into
  // the textarea. `preloadNonce` is bumped on every click so MessageInput
  // re-applies the preload even when the user picks the same chip twice.
  const [pendingPrompt, setPendingPrompt] = useState<string | undefined>(
    undefined,
  );
  const [preloadNonce, setPreloadNonce] = useState(0);

  useEffect(() => {
    if (!open) setPendingPrompt(undefined);
  }, [open]);

  async function handleSend(text: string) {
    setPendingPrompt(undefined);
    await chat.send(text);
  }

  function handleSelectPrompt(prompt: string) {
    setPendingPrompt(prompt);
    setPreloadNonce((n) => n + 1);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-background shadow-2xl',
            'sm:max-w-xl md:max-w-3xl',
            'border-l border-border/60',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
            'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
            'duration-200',
          )}
        >
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-flex size-7 items-center justify-center rounded-full bg-info/15 text-info ring-1 ring-info/30"
              >
                <Bot className="size-4" />
              </span>
              <DialogPrimitive.Title className="text-sm font-semibold tracking-tight">
                AI yordamchi
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close
              aria-label="Yopish"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>

          <div className="flex flex-1 overflow-hidden">
            <SessionList
              className="hidden md:flex"
              sessions={chat.sessions}
              activeSessionId={chat.sessionId}
              onSelectSession={(id) => {
                void chat.openSession(id);
              }}
              onNewSession={chat.startNewSession}
              isLoading={chat.isLoadingSessions}
              error={chat.sessionsError}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {chat.sendError !== null && (
                <ErrorBanner
                  message={chat.sendError}
                  onDismiss={chat.clearError}
                />
              )}
              <MessageList
                messages={chat.messages}
                isThinking={chat.isSending}
                onSelectPrompt={handleSelectPrompt}
                onConfirmAction={chat.confirmAction}
                onRejectAction={chat.rejectAction}
                actionRequest={chat.actionRequest}
                actionErrors={chat.actionErrors}
              />
              <MessageInput
                onSend={handleSend}
                isSending={chat.isSending}
                initialValue={pendingPrompt}
                preloadNonce={preloadNonce}
                autoFocus={open}
              />
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="flex-1">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Xatoni yopish"
        className="rounded-sm text-destructive/70 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
