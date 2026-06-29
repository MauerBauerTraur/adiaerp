import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '@/lib/api-client';
import type {
  AssistantActionResult,
  AssistantConfirmActionResponse,
  AssistantMessage,
  AssistantQueryResponse,
  AssistantRejectActionResponse,
  AssistantSessionDetail,
  AssistantSessionSummary,
  AssistantSessionsResponse,
} from '@/lib/types';

interface ActionRequestState {
  /** Action id whose `/confirm` or `/reject` is currently in flight. */
  actionId: number;
  /** Which side the user pressed. */
  kind: 'confirm' | 'reject';
}

interface ChatState {
  messages: AssistantMessage[];
  sessionId: number | null;
  isSending: boolean;
  sendError: string | null;
  sessions: AssistantSessionSummary[];
  isLoadingSessions: boolean;
  sessionsError: string | null;
  /** Tracks the in-flight confirm/reject request, if any. */
  actionRequest: ActionRequestState | null;
  /** Last error from a confirm/reject attempt, keyed by action id. */
  actionErrors: Record<number, string>;
}

interface ChatApi extends ChatState {
  send: (text: string) => Promise<void>;
  startNewSession: () => void;
  openSession: (id: number) => Promise<void>;
  reloadSessions: () => void;
  /** Clears any in-flight send error so the next attempt isn't blocked visually. */
  clearError: () => void;
  /** Confirm a pending write action — `POST /api/assistant/actions/:id/confirm`. */
  confirmAction: (actionId: number) => Promise<void>;
  /** Reject a pending write action — `POST /api/assistant/actions/:id/reject`. */
  rejectAction: (actionId: number) => Promise<void>;
}

/**
 * Maps a backend `ApiError` to a user-facing Uzbek message.
 *
 * Special-cases the Vertex outage codes called out in the brief — if the
 * backend can't reach Gemini, we don't want to surface a raw "503" to a
 * store manager.
 */
function localiseError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VERTEX_UNAVAILABLE' || err.status === 503) {
      return 'AI yordamchi vaqtinchalik mavjud emas. Birozdan keyin qayta urinib ko‘ring.';
    }
    if (err.code === 'RATE_LIMITED' || err.status === 429) {
      return 'So‘rovlar juda tez yuborildi. Bir daqiqa kuting va qayta urinib ko‘ring.';
    }
    if (err.code === 'AI_INSUFFICIENT_CONTEXT') {
      return 'Savol juda noaniq — iltimos, batafsilroq yozing.';
    }
    return err.message;
  }
  return 'Kutilmagan xato yuz berdi.';
}

/**
 * Maps confirm/reject error codes to user-facing Uzbek messages.
 * The two-phase commit has its own error codes (phase-3.md §3.4) that
 * deserve dedicated copy so the user understands why the click didn't
 * land.
 */
function localiseActionError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'ACTION_EXPIRED' || err.status === 410) {
      return 'Amal muddati o‘tdi (5 daqiqa). Iltimos, AI yordamchidan qaytadan so‘rang.';
    }
    if (err.code === 'ACTION_NOT_PENDING' || err.status === 409) {
      return 'Bu amal allaqachon bajarilgan yoki rad etilgan.';
    }
    if (err.code === 'ACTION_FORBIDDEN' || err.status === 403) {
      return 'Bu amalni tasdiqlash huquqingiz yo‘q.';
    }
    if (err.code === 'INSUFFICIENT_STOCK' || err.status === 422) {
      return 'Omborda yetarli tovar yo‘q — amal bajarilmadi.';
    }
    if (err.code === 'ACTION_NOT_FOUND' || err.status === 404) {
      return 'Amal topilmadi.';
    }
    return err.message;
  }
  return 'Amalni qayta ishlashda xato yuz berdi.';
}

/**
 * Stateful AI-chat hook used by `AssistantDrawer`.
 *
 * Lifecycle:
 *  - On mount (or when `enabled` flips true) — fetch the session list.
 *  - First `send` creates a new server-side session; the response's
 *    `session_id` is captured and reused for follow-ups.
 *  - `startNewSession` resets local state (no server call needed; the
 *    server creates a fresh row on the next `send`).
 *  - `openSession` loads `/api/assistant/sessions/:id` and rehydrates
 *    `messages` from the audit trail.
 */
export function useAssistantChat(enabled: boolean): ChatApi {
  const [state, setState] = useState<ChatState>({
    messages: [],
    sessionId: null,
    isSending: false,
    sendError: null,
    sessions: [],
    isLoadingSessions: false,
    sessionsError: null,
    actionRequest: null,
    actionErrors: {},
  });

  // Live mirror of `sessionId` for the async `send` flow — avoids the
  // stale-closure pitfall when `send` is dispatched twice in quick
  // succession before React has flushed the previous setState.
  const sessionIdRef = useRef<number | null>(null);
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  const reloadSessions = useCallback(() => {
    setState((s) => ({ ...s, isLoadingSessions: true, sessionsError: null }));
    apiRequest<AssistantSessionsResponse>(
      '/api/assistant/sessions?limit=30&offset=0',
    )
      .then((res) => {
        setState((s) => ({
          ...s,
          sessions: res.items,
          isLoadingSessions: false,
        }));
      })
      .catch((err) => {
        setState((s) => ({
          ...s,
          isLoadingSessions: false,
          sessionsError: localiseError(err),
        }));
      });
  }, []);

  // Lazy-load the sessions list — only when the drawer is first opened.
  useEffect(() => {
    if (enabled && state.sessions.length === 0 && !state.isLoadingSessions) {
      reloadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const send = useCallback(async (text: string) => {
    const now = new Date().toISOString();
    const userMessage: AssistantMessage = {
      role: 'user',
      content: text,
      created_at: now,
    };
    setState((s) => ({
      ...s,
      messages: [...s.messages, userMessage],
      isSending: true,
      sendError: null,
    }));

    try {
      const body: { session_id?: number; message: string } = { message: text };
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId !== null) body.session_id = currentSessionId;

      const result = await apiRequest<AssistantQueryResponse>(
        '/api/assistant/query',
        { method: 'POST', body },
      );

      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: result.response,
        tool_calls: result.tool_calls,
        pending_action: result.pending_action,
        created_at: new Date().toISOString(),
      };
      setState((s) => ({
        ...s,
        // A new pending action supersedes any earlier still-pending one
        // in this session (phase-3.md §3.1 — bitta sessiyada bir vaqtda
        // bitta pending action). Reflect that locally so the UI doesn't
        // show two simultaneous "Bajarilishi kutilmoqda" cards.
        messages: appendAssistantTurn(s.messages, assistantMessage),
        sessionId: result.session_id,
        isSending: false,
        // Refresh sessions list so the new title shows up at the top.
        sessions: upsertSessionAtTop(s.sessions, {
          id: result.session_id,
          title:
            s.sessions.find((x) => x.id === result.session_id)?.title ??
            truncateTitle(text),
          updated_at: assistantMessage.created_at,
        }),
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        isSending: false,
        sendError: localiseError(err),
      }));
    }
  }, []);

  const startNewSession = useCallback(() => {
    setState((s) => ({
      ...s,
      messages: [],
      sessionId: null,
      sendError: null,
    }));
  }, []);

  const openSession = useCallback(async (id: number) => {
    setState((s) => ({
      ...s,
      isSending: true,
      sendError: null,
      sessionId: id,
      messages: [],
    }));
    try {
      const detail = await apiRequest<AssistantSessionDetail>(
        `/api/assistant/sessions/${id}`,
      );
      setState((s) => ({
        ...s,
        messages: detail.messages,
        sessionId: detail.session.id,
        isSending: false,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        isSending: false,
        sendError: localiseError(err),
      }));
    }
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, sendError: null }));
  }, []);

  const resolveAction = useCallback(
    async (actionId: number, kind: 'confirm' | 'reject') => {
      // Mark this card busy and clear any prior error on this id so the
      // user sees the spinner immediately.
      setState((s) => {
        const nextErrors = { ...s.actionErrors };
        delete nextErrors[actionId];
        return {
          ...s,
          actionRequest: { actionId, kind },
          actionErrors: nextErrors,
        };
      });

      try {
        const path = `/api/assistant/actions/${actionId}/${kind}`;
        const response = await apiRequest<
          AssistantConfirmActionResponse | AssistantRejectActionResponse
        >(path, { method: 'POST' });
        setState((s) => ({
          ...s,
          actionRequest: null,
          messages: replaceActionInMessages(s.messages, response.action),
        }));
      } catch (err) {
        setState((s) => ({
          ...s,
          actionRequest: null,
          actionErrors: {
            ...s.actionErrors,
            [actionId]: localiseActionError(err),
          },
          // If the server reports ACTION_NOT_PENDING / ACTION_EXPIRED,
          // the card should still flip to its terminal state so the user
          // can no longer click. We can't know the true status without
          // another round-trip, so we conservatively show `expired` when
          // the API tells us the action is no longer pending.
          messages: maybeMarkActionTerminalOnError(s.messages, actionId, err),
        }));
      }
    },
    [],
  );

  const confirmAction = useCallback(
    (actionId: number) => resolveAction(actionId, 'confirm'),
    [resolveAction],
  );

  const rejectAction = useCallback(
    (actionId: number) => resolveAction(actionId, 'reject'),
    [resolveAction],
  );

  return {
    ...state,
    send,
    startNewSession,
    openSession,
    reloadSessions,
    clearError,
    confirmAction,
    rejectAction,
  };
}

/**
 * Walks the message list and:
 *   1. Demotes any prior still-pending action to `superseded` (a brand-new
 *      assistant turn with its own pending action wins).
 *   2. Appends the new assistant turn at the tail.
 */
function appendAssistantTurn(
  messages: AssistantMessage[],
  next: AssistantMessage,
): AssistantMessage[] {
  if (next.pending_action === undefined) {
    return [...messages, next];
  }
  const demoted = messages.map<AssistantMessage>((msg) => {
    if (msg.pending_action === undefined) return msg;
    const supersededResult: AssistantActionResult = {
      action_id: msg.pending_action.action_id,
      tool_name: msg.pending_action.tool_name,
      summary: msg.pending_action.summary,
      status: 'superseded',
    };
    return {
      ...msg,
      pending_action: undefined,
      action_result: supersededResult,
    };
  });
  return [...demoted, next];
}

/**
 * Swap the `pending_action` on the message that holds this action id
 * for the resolved `action_result` returned by `/confirm` or `/reject`.
 * If the resolved row arrived via session history, the matching row
 * already has `action_result` set — overwrite it in place.
 */
function replaceActionInMessages(
  messages: AssistantMessage[],
  result: AssistantActionResult,
): AssistantMessage[] {
  return messages.map<AssistantMessage>((msg) => {
    const isMatch =
      msg.pending_action?.action_id === result.action_id ||
      msg.action_result?.action_id === result.action_id;
    if (!isMatch) return msg;
    return {
      ...msg,
      pending_action: undefined,
      action_result: result,
    };
  });
}

/**
 * If the server told us the action is no longer pending (`409`/`410`),
 * flip the local row to a terminal state so the buttons disappear.
 * We use `expired` as the safe fallback — the user can re-ask the
 * assistant to retry.
 */
function maybeMarkActionTerminalOnError(
  messages: AssistantMessage[],
  actionId: number,
  err: unknown,
): AssistantMessage[] {
  if (!(err instanceof ApiError)) return messages;
  const terminal =
    err.code === 'ACTION_EXPIRED' ||
    err.status === 410 ||
    err.code === 'ACTION_NOT_PENDING' ||
    err.status === 409;
  if (!terminal) return messages;
  return messages.map<AssistantMessage>((msg) => {
    if (msg.pending_action?.action_id !== actionId) return msg;
    return {
      ...msg,
      pending_action: undefined,
      action_result: {
        action_id: msg.pending_action.action_id,
        tool_name: msg.pending_action.tool_name,
        summary: msg.pending_action.summary,
        status: err.code === 'ACTION_NOT_PENDING' ? 'superseded' : 'expired',
      },
    };
  });
}

function upsertSessionAtTop(
  current: AssistantSessionSummary[],
  next: AssistantSessionSummary,
): AssistantSessionSummary[] {
  const without = current.filter((s) => s.id !== next.id);
  return [next, ...without];
}

function truncateTitle(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 40) return trimmed;
  return `${trimmed.slice(0, 40)}…`;
}
