-- 0041_production_dispatches.sql
-- Tracks per-material warehouse dispatch status for production orders.
-- Two-step flow: warehouse marks 'dispatched' (berildi), then production
-- manager marks 'received' (qabul qildim) — stock is only deducted on receive.

CREATE TABLE production_dispatches (
  id                  BIGSERIAL PRIMARY KEY,
  production_order_id BIGINT        NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  product_id          BIGINT        NOT NULL REFERENCES products(id),
  product_name        TEXT          NOT NULL,
  product_unit        TEXT          NOT NULL,
  qty_needed          NUMERIC(14,4) NOT NULL CHECK (qty_needed > 0),
  status              TEXT          NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'dispatched', 'received')),
  from_location_id    BIGINT        REFERENCES locations(id),
  to_location_id      BIGINT        REFERENCES locations(id),
  movement_id         BIGINT        REFERENCES stock_movements(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  dispatched_at       TIMESTAMPTZ,
  dispatched_by       BIGINT        REFERENCES users(id),
  received_at         TIMESTAMPTZ,
  received_by         BIGINT        REFERENCES users(id)
);

CREATE INDEX ON production_dispatches (production_order_id);
CREATE INDEX ON production_dispatches (status);
CREATE INDEX ON production_dispatches (from_location_id, status);
