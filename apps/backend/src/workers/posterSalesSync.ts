/**
 * Poster sales-sync cron worker (ADR-0002 §3).
 *
 * Two schedules in one process:
 *   - every 1 minute  -> `processPendingWebhookEvents` drains
 *                        `poster_webhook_events` (primary path);
 *   - every 30 minutes -> `fallbackPollTransactions` covers webhook drops.
 *
 * Both cycles share an overlap guard so a slow Poster never starts overlapping
 * runs (a double-decrement would still be blocked by the partial UNIQUE index,
 * but skipping is the right behaviour for cost + latency).
 */
import cron from 'node-cron';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import {
  fallbackPollTransactions,
  processPendingWebhookEvents,
} from '../integrations/poster/salesSync.js';
import { checkSoldProductsAndCreateOrders } from '../services/autoOrder.js';

export const POSTER_SALES_WEBHOOK_SCHEDULE = '*/1 * * * *';
export const POSTER_SALES_FALLBACK_SCHEDULE = '*/30 * * * *';

let webhookTask: cron.ScheduledTask | undefined;
let fallbackTask: cron.ScheduledTask | undefined;

export const webhookGuard: { running: boolean } = { running: false };
export const fallbackGuard: { running: boolean } = { running: false };

export function startPosterSalesWorker(): void {
  if (webhookTask === undefined) {
    webhookTask = cron.schedule(POSTER_SALES_WEBHOOK_SCHEDULE, () => {
      void runWebhookCycle();
    });
  }
  if (fallbackTask === undefined) {
    fallbackTask = cron.schedule(POSTER_SALES_FALLBACK_SCHEDULE, () => {
      void runFallbackCycle();
    });
  }
}

export function stopPosterSalesWorker(): void {
  webhookTask?.stop();
  webhookTask = undefined;
  fallbackTask?.stop();
  fallbackTask = undefined;
}

export async function runWebhookCycle(): Promise<void> {
  if (webhookGuard.running) {
    return;
  }
  webhookGuard.running = true;
  try {
    const client = createPosterClientFromConfig();
    const summary = await processPendingWebhookEvents(client, 50);
    if (summary.eventsScanned > 0) {
      console.log(
        `[poster-sales-webhook] scanned=${summary.eventsScanned} applied=${summary.eventsApplied} ` +
          `lines=${summary.linesInserted} moves=${summary.movementsApplied} ` +
          `store-misses=${summary.storeMisses}`,
      );
    }
    // When new sales were ingested, check if any sold product has stock below min_qty.
    if (summary.linesInserted > 0) {
      const autoResult = await checkSoldProductsAndCreateOrders();
      if (autoResult.created > 0 || autoResult.skipped > 0) {
        console.log(
          `[poster-sales-webhook] auto-orders: checked=${autoResult.checked} ` +
            `created=${autoResult.created} skipped=${autoResult.skipped}`,
        );
      }
    }
  } catch (err) {
    console.error('[poster-sales-webhook] cycle failed:', (err as Error).message);
  } finally {
    webhookGuard.running = false;
  }
}

export async function runFallbackCycle(): Promise<void> {
  if (fallbackGuard.running) {
    return;
  }
  fallbackGuard.running = true;
  try {
    const client = createPosterClientFromConfig();
    const summary = await fallbackPollTransactions(client, 30);
    if (summary.eventsScanned > 0) {
      console.log(
        `[poster-sales-fallback] scanned=${summary.eventsScanned} applied=${summary.eventsApplied} ` +
          `lines=${summary.linesInserted} moves=${summary.movementsApplied}`,
      );
    }
    // Always check auto-orders on fallback cycle (every 30 min) so that products
    // that fell below min_qty from older sales are caught even with no new lines.
    const autoResult = await checkSoldProductsAndCreateOrders();
    if (autoResult.created > 0 || autoResult.checked > 0) {
      console.log(
        `[poster-sales-fallback] auto-orders: checked=${autoResult.checked} ` +
          `created=${autoResult.created} skipped=${autoResult.skipped}`,
      );
    }
  } catch (err) {
    console.error('[poster-sales-fallback] cycle failed:', (err as Error).message);
  } finally {
    fallbackGuard.running = false;
  }
}
