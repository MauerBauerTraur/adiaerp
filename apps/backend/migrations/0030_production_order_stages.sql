-- =============================================================================
-- 0030 — production_orders: parent_production_order_id + stage_role.
-- =============================================================================
-- ADR-0016 §2.3 (Variant A) — the two-phase production flow keeps ONE finished
-- `production_order` (stage_role='final'), but when the zagatovka (semi) is not
-- yet on hand in sex_storage it spawns a SEPARATE zagatovka order
-- (stage_role='zagatovka') whose output target is the sex_storage, linked back
-- to the final order via `parent_production_order_id`.
--
--   * stage_role = 'final'     — the finished cake (decoration BOM, target=central).
--                                The default keeps every existing order a 'final'.
--   * stage_role = 'zagatovka' — the 70%-done base order (base BOM,
--                                target=sex_storage), child of a 'final' order.
--
-- `parent_production_order_id` is self-referential and ON DELETE SET NULL so a
-- cancelled/removed final order never cascades away the zagatovka history.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS for both columns; the CHECK constraint is
-- dropped-if-exists then re-added. No data deleted — purely additive.
-- =============================================================================

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS parent_production_order_id BIGINT
    REFERENCES production_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_role TEXT NOT NULL DEFAULT 'final';

ALTER TABLE production_orders
  DROP CONSTRAINT IF EXISTS chk_production_stage_role;
ALTER TABLE production_orders
  ADD CONSTRAINT chk_production_stage_role
  CHECK (stage_role IN ('final', 'zagatovka'));

COMMENT ON COLUMN production_orders.stage_role IS
  'ADR-0016 — final (finished cake, decoration BOM, target=central) | '
  'zagatovka (70%% base order, base BOM, target=sex_storage, child of a final).';
COMMENT ON COLUMN production_orders.parent_production_order_id IS
  'ADR-0016 — a zagatovka sub-order points to the final order it was raised for.';

CREATE INDEX IF NOT EXISTS ix_production_orders_parent
  ON production_orders(parent_production_order_id)
  WHERE parent_production_order_id IS NOT NULL;
