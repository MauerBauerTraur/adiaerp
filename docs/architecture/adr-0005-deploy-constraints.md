# ADR-0005 — Deploy constraints for Faza-1 (single instance + cron worker)

- Status: Accepted
- Date: 2026-05-23
- Owners: backend-engineer, system-architect
- Related: ADR-0002 (Poster sync), CLAUDE.md §5 (stack), TZ §10

## Context

Faza-1 deploys ADIA ERP onto a single Hetzner VPS managed by PM2 behind
Nginx. The API process embeds three cron workers:

- `replenishmentScan` — 5-minute below-min scan and request advance loop;
- `posterStockSync` / `posterSalesSync` — Poster leftover + transactions
  polling and webhook ingestion;
- `telegramOutbox` — 30-second outbound Telegram queue drain.

Each worker uses a module-scope `cronGuard.running` flag to prevent a slow
tick from overlapping with the next tick **within the same Node process**.
That flag has no cross-process semantics.

## Decision

For Faza-1 the API runs in PM2 **fork mode** with **exactly one** instance:

```
pm2 start dist/server.js --name adia-api -i 1
```

A second worker process (e.g. PM2 cluster mode `-i max`, or a separate VM)
would cause:

- duplicate Telegram notifications (two outbox workers polling the same
  `notifications` rows);
- duplicate replenishment `advance` calls racing on the same request id
  (the row-level `SELECT … FOR UPDATE` already in
  `services/replenishment.ts::lockRequest` serialises them, but the cron
  schedule would still fire twice as often);
- duplicate Poster `transaction.close` ingestion attempts (rate-limit risk
  on the Poster side; idempotency is preserved by UNIQUE indexes).

Webhook DoS protection is layered:

1. Application — `express-rate-limit` on `/api/integrations/poster/webhook`
   capped at 60 req/min/IP (see `routes/posterIntegration.ts` —
   C4 Sprint-3 audit).
2. Nginx — recommended `limit_req zone` of 120 req/min/IP for the same
   path (deploy-time configuration).

## Migration path (cluster mode — Faza-2 candidate)

Before switching to `pm2 -i max` (cluster) or running a second VM:

1. `workers/telegramOutbox.ts`: replace the `SELECT … LIMIT n` pick with
   `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`, so each row is leased to
   exactly one worker per tick.
2. `workers/replenishmentScan.ts`: keep the row-level lock inside the
   per-request `advance` call but add a `SKIP LOCKED` clause to the
   batch-pick query for the same reason.
3. `workers/posterSalesSync.ts`: switch the `poster_webhook_events`
   pick-up query to `FOR UPDATE SKIP LOCKED`.
4. Add `instance_id`-aware logging so we can attribute work in `pm2 logs`.

## Consequences

- Single instance is a SPOF — Faza-1 trades availability for simplicity.
  Health check at `/api/health` plus PM2 auto-restart limits downtime.
- Background work blocks API throughput when cron ticks are slow — the
  workers are deliberately small (BATCH_LIMIT=50 on outbox, 100 on
  replenishment) to keep each tick under 5s.
- Horizontal scale-out is a Faza-2 piece of work tracked in the migration
  path above.
