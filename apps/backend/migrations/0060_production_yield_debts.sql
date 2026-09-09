-- 0060_production_yield_debts.sql
-- Yield-debt ledger: when a production order is marked "done" with an
-- actual_qty lower than the ordered qty, the shortfall is recorded as an
-- open debt against (product, location). A later order for the same
-- (product, location) that over-produces (actual_qty > its own qty)
-- settles open debts FIFO with the surplus. Raw-material consumption is
-- never touched by this table — it always reflects the ordered qty, since
-- that is what was actually dispatched to the department.

ALTER TABLE production_orders
  ADD COLUMN actual_qty NUMERIC(14,4);

CREATE TABLE production_yield_debts (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id                  BIGINT        NOT NULL REFERENCES products(id),
  location_id                 BIGINT        NOT NULL REFERENCES locations(id),
  qty_owed                    NUMERIC(14,4) NOT NULL CHECK (qty_owed > 0),
  status                      TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  source_production_order_id  BIGINT        REFERENCES production_orders(id) ON DELETE SET NULL,
  resolved_by_order_id        BIGINT        REFERENCES production_orders(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  resolved_at                 TIMESTAMPTZ
);

CREATE INDEX ix_yield_debts_open ON production_yield_debts (product_id, location_id)
  WHERE status = 'open';
