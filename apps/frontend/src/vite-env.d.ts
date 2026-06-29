/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /**
   * EPIC 3.2 — Telegram bot username (without the leading `@`). When set,
   * the "TG ulash" dialog renders a `https://t.me/<bot>?start=<token>`
   * deep link; when unset it falls back to showing the raw `/start`
   * command the employee can paste into the bot.
   */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
