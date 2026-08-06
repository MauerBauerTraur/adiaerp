-- 0058_production_order_allocations.sql
-- Per-store quantity breakdown for a production order.
-- When the order is marked "done", the system auto-transfers each allocation
-- from target_location to the corresponding store warehouse.
-- No human action required beyond marking the order done.

CREATE TABLE production_order_allocations (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  production_order_id BIGINT        NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  store_location_id   BIGINT        NOT NULL REFERENCES locations(id),
  qty                 NUMERIC(14,4) NOT NULL CHECK (qty > 0),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ON production_order_allocations (production_order_id);
