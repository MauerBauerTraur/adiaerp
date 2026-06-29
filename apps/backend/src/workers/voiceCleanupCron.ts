/**
 * F4.3 (ADR-0014) — Voice tmp file cleanup cron.
 *
 * Schedule: `30 3 * * *` (har kuni 03:30 UTC ≈ 08:30 Toshkent).
 *
 * `telegram/voiceHandler.ts` har voice xabar uchun
 * `/tmp/adia-voice-<userId>-<voiceId>-<ts>.oga` yaratadi va
 * `finally { fs.unlink }` orqali o'chiradi. Lekin crash holatida fayl
 * qolib ketishi mumkin — bu cron 1 soatdan eski adia-voice fayllarni
 * tozalaydi (invariant 15 backstop).
 *
 * Per-cycle ish: o'qish + filter + unlink. Bir tmpDir bo'yicha
 * (`os.tmpdir()`).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cron from 'node-cron';

/** node-cron expression — har kuni 03:30. */
export const VOICE_CLEANUP_SCHEDULE = '30 3 * * *';

/** Voice tmp fayl prefiksi — voiceHandler bilan sinxron. */
const VOICE_TMP_PREFIX = 'adia-voice-';

/** Faylni "eski" deb hisoblash chegarasi (ms). */
const MAX_AGE_MS = 60 * 60 * 1000; // 1 soat

let task: cron.ScheduledTask | undefined;
export const cronGuard: { running: boolean } = { running: false };

export function startVoiceCleanupWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(VOICE_CLEANUP_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopVoiceCleanupWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Tashqi test seam — dir va now ni override qilish mumkin. */
export type CleanupOpts = {
  readonly dir?: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
};

/** Cron entry point — eski voice tmp fayllarni o'chiradi. Tests uchun exported. */
export async function runOneCycle(
  opts: CleanupOpts = {},
): Promise<{ deleted: number; skipped: number }> {
  if (cronGuard.running) {
    console.log('[voice-cleanup] previous cycle still running, skipping');
    return { deleted: 0, skipped: 0 };
  }
  cronGuard.running = true;
  const dir = opts.dir ?? os.tmpdir();
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
  let deleted = 0;
  let skipped = 0;
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      console.error('[voice-cleanup] readdir failed:', (err as Error).message);
      return { deleted: 0, skipped: 0 };
    }
    for (const name of entries) {
      if (!name.startsWith(VOICE_TMP_PREFIX)) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        const age = now - stat.mtimeMs;
        if (age < maxAge) {
          skipped += 1;
          continue;
        }
        await fs.unlink(full);
        deleted += 1;
      } catch (err) {
        // Yo'q bo'lib qolgan / ruxsat etilmagan — keyingisini sinab ko'r.
        console.error(
          `[voice-cleanup] failed for ${name}:`,
          (err as Error).message,
        );
      }
    }
    if (deleted > 0) {
      console.log(`[voice-cleanup] deleted=${deleted} skipped=${skipped}`);
    }
    return { deleted, skipped };
  } finally {
    cronGuard.running = false;
  }
}
