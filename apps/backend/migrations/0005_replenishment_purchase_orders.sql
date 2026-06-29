-- =============================================================================
-- 0005_replenishment_purchase_orders.sql — Phase-2 F2.3 (multi-shortage M:N).
--
-- A single replenishment_request can drive MORE THAN ONE purchase_order:
-- when the production BOM is short on several raw materials, each shortage
-- triggers its own PO. Phase-1 stored only the most recent link on the
-- request row (`replenishment_requests.purchase_order_id`), which the
-- service had to UNLINK before creating the next shortage's PO (search
-- replenishment.purchase_order.unlink in audit_log).
--
-- Phase-2 introduces an M:N join table so every PO ever attached to a
-- request is permanently traceable. The existing single-FK column stays in
-- place for transition (the service now DUAL-WRITES). Phase-3 will drop it.
--
-- Back-fill: every existing replenishment_requests.purchase_order_id row is
-- mirrored into the new table so historical links are not lost.
--
-- Indexes both directions (replenishment_id and purchase_order_id) — the
-- engine reads "all POs for this request" and the dashboard reads "which
-- request created this PO".
-- =============================================================================

CREATE TABLE IF NOT EXISTS replenishment_purchase_orders (
    replenishment_id  BIGINT NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id)        ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (replenishment_id, purchase_order_id)
);

CREATE INDEX IF NOT EXISTS ix_rpo_replenishment
    ON replenishment_purchase_orders(replenishment_id);
CREATE INDEX IF NOT EXISTS ix_rpo_purchase_order
    ON replenishment_purchase_orders(purchase_order_id);

-- Back-fill — mirror the single-FK column. `ON CONFLICT DO NOTHING` keeps
-- the migration idempotent should this file ever be re-run inside a fresh
-- schema_migrations bookkeeping.
INSERT INTO replenishment_purchase_orders (replenishment_id, purchase_order_id, created_at)
SELECT id, purchase_order_id, updated_at
  FROM replenishment_requests
 WHERE purchase_order_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN replenishment_requests.purchase_order_id IS
    'DEPRECATED in Phase 2. Use replenishment_purchase_orders M:N table. '
    'Column kept for backward-compat during the Phase-2 transition; removed in Phase 3.';
