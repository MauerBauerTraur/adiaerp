import { useState } from 'react';
import { Send, Check, Loader2, Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { User } from '@/lib/types';

/**
 * EPIC 3.2 — Telegram self-link control on the merged Hodimlar /
 * Foydalanuvchilar screen.
 *
 * Two states:
 *   - linked   (`user.telegram_id` set) → a green "Ulangan" badge.
 *   - unlinked → a "TG ulash" button that opens a dialog.
 *
 * The dialog mints a one-time link token via
 * `POST /api/users/:id/telegram-link-token` (backend, commit 08f660e). The
 * contract returns:
 *   { token: string; expires_at: string; start_command: "/start <token>" }
 *
 * The bot username is a client-side config (`VITE_TELEGRAM_BOT_USERNAME`):
 *   - set   → render a `https://t.me/<bot>?start=<token>` deep link button;
 *   - unset → show the raw `/start <token>` command the employee pastes
 *             into the bot manually.
 *
 * A 404 (endpoint not yet deployed in some environment) degrades to a
 * friendly placeholder — the UI never crashes.
 */
interface TelegramLinkTokenResponse {
  token: string;
  expires_at?: string;
  start_command?: string;
}

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME ?? '';

interface TelegramLinkButtonProps {
  user: User;
  /** Compact variant for the card grid. */
  size?: 'sm' | 'default';
}

export function TelegramLinkButton({ user, size = 'sm' }: TelegramLinkButtonProps) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // The https://t.me deep link — only when a bot username is configured.
  const [link, setLink] = useState<string | null>(null);
  // The raw `/start <token>` command — always available on success.
  const [startCommand, setStartCommand] = useState<string | null>(null);
  // true = endpoint not yet available → friendly placeholder.
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = user.telegram_id != null;

  if (linked) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 text-emerald-400"
        aria-label="Telegram ulangan"
      >
        <Check className="size-3" aria-hidden="true" />
        TG ulangan
      </Badge>
    );
  }

  async function requestToken() {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    setLink(null);
    setStartCommand(null);
    try {
      const res = await apiRequest<TelegramLinkTokenResponse>(
        `/api/users/${user.id}/telegram-link-token`,
        { method: 'POST' },
      );
      setStartCommand(res.start_command ?? `/start ${res.token}`);
      if (BOT_USERNAME !== '') {
        setLink(`https://t.me/${BOT_USERNAME}?start=${res.token}`);
      }
    } catch (err: unknown) {
      // A 404 means the route is not deployed in this environment → show a
      // friendly placeholder instead of a hard error.
      if (err instanceof ApiError && err.status === 404) {
        setUnavailable(true);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Telegram havolasini olishda xatolik yuz berdi.',
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      void requestToken();
    } else {
      setLink(null);
      setStartCommand(null);
      setError(null);
      setUnavailable(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('success', 'Nusxalandi.');
    } catch {
      notify('error', 'Nusxalab bo‘lmadi.');
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={(e) => {
          e.stopPropagation();
          handleOpenChange(true);
        }}
        aria-label={`${user.name} uchun Telegram ulash`}
      >
        <Send className="size-4" aria-hidden="true" />
        TG ulash
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-w-md"
          // Stop the dialog (rendered inside a clickable card/row) from
          // bubbling clicks back up to the row handler.
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Telegram’ni ulash</DialogTitle>
            <DialogDescription>
              {user.name} hisobini Telegram botiga bog‘lash.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            {loading && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Havola tayyorlanmoqda…
              </p>
            )}

            {!loading && startCommand && (
              <div className="space-y-3">
                <p className="text-muted-foreground">
                  {link
                    ? 'Hodim quyidagi havola orqali botni ochsin — Telegram hisobi avtomatik bog‘lanadi.'
                    : 'Hodim botni ochib, quyidagi buyruqni yuborsin — Telegram hisobi bog‘lanadi.'}
                </p>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
                  <code className="min-w-0 flex-1 truncate text-xs">
                    {link ?? startCommand}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(link ?? startCommand)}
                    aria-label="Nusxalash"
                  >
                    <Copy className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                {link && (
                  <Button asChild className="w-full">
                    <a href={link} target="_blank" rel="noopener noreferrer">
                      <Send className="size-4" aria-hidden="true" />
                      Telegram’da ochish
                    </a>
                  </Button>
                )}
              </div>
            )}

            {!loading && unavailable && (
              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-muted-foreground">
                <p>
                  Telegram ulash xizmati hali ishga tushmagan. Tez orada
                  hodim botda <code>/start</code> orqali o‘zini ulay oladi.
                </p>
                <p className="text-xs">
                  Hozircha Telegram ID’ni qo‘lda{' '}
                  <span className="font-medium">Hodim</span> formasida
                  kiritish mumkin.
                </p>
              </div>
            )}

            {!loading && error && (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Yopish
            </Button>
            {!loading && (error || unavailable) && (
              <Button type="button" onClick={() => void requestToken()}>
                Qayta urinish
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
