-- M10: Poster Поставки (supply deliveries) sync tables.
--
-- Stores supply headers + line items fetched from:
--   storage.getSupplies  — list with totals (tiyin)
--   storage.getSupply    — detail with ingredients (so'm)
--
-- supply_sum / item_sum stored in SO'M (not tiyin) — the detail endpoint
-- returns so'm; the list endpoint returns tiyin which the sync service
-- converts (÷100) before UPSERT.

CREATE TABLE poster_supplies (
  id            BIGINT PRIMARY KEY,              -- Poster supply_id
  storage_id    INT    NOT NULL,
  storage_name  TEXT,
  supplier_id   INT,
  supplier_name TEXT,
  supply_date   TIMESTAMPTZ NOT NULL,
  supply_sum    NUMERIC(14, 2) NOT NULL DEFAULT 0,  -- so'm
  comment       TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_poster_supplies_date    ON poster_supplies (supply_date DESC);
CREATE INDEX idx_poster_supplies_storage ON poster_supplies (storage_id);

CREATE TABLE poster_supply_items (
  id              BIGSERIAL PRIMARY KEY,
  supply_id       BIGINT NOT NULL REFERENCES poster_supplies(id) ON DELETE CASCADE,
  ingredient_id   INT    NOT NULL,
  ingredient_name TEXT   NOT NULL,
  ingredient_unit TEXT   NOT NULL DEFAULT 'kg',
  qty             NUMERIC(14, 4) NOT NULL DEFAULT 0,
  item_sum        NUMERIC(14, 2) NOT NULL DEFAULT 0  -- so'm
);

CREATE INDEX idx_poster_supply_items_supply     ON poster_supply_items (supply_id);
CREATE INDEX idx_poster_supply_items_ingredient ON poster_supply_items (ingredient_id);
