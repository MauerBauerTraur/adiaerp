-- =============================================================================
-- ADIA ERP — Phase 1 (Extended MVP) PostgreSQL schema
-- =============================================================================
-- Target: PostgreSQL 15+. Raw SQL query layer (no ORM).
-- Single company — NOT multi-tenant. No tenant/organization abstraction.
-- All identifiers, SQL, comments in English. Docs/spec in Uzbek.
--
-- Domain invariants enforced at DB level (CLAUDE.md section 6):
--   1. Every stock_movement is an atomic transaction (source down, dest up, audit).
--   2. One open replenishment_request per (product, location)  -> partial UNIQUE index.
--   3. Stock qty is never negative                              -> CHECK (qty >= 0).
--   4. min/max per (location_id, product_id)                    -> stock PK is composite.
--   5. Production order "done" decrements raw by BOM, increments warehouse — atomic.
--   6. RBAC location-scoped; every change audit-logged.
--
-- Apply order: types -> tables -> indexes -> triggers/functions -> seed.
--
-- Transaction boundaries: this file contains NO `BEGIN;` / `COMMIT;`.
-- The migration runner (apps/api/src/db/migrate.ts) wraps the whole file
-- in one transaction together with the schema_migrations bookkeeping INSERT,
-- so schema + bookkeeping commit atomically.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ENUM TYPES
-- -----------------------------------------------------------------------------

-- Location type — a link in the supply chain (TZ section 7, decision D1).
CREATE TYPE location_type AS ENUM (
    'raw_warehouse',      -- Mahsulotlar Ombori (xom-ashyo)
    'production',         -- Ishlab chiqarish sexi
    'supply',             -- Ta'minot bo'limi (Tort / Perojniy / Yarim Fabrika)
    'central_warehouse',  -- Markaziy Sklad
    'store'               -- Do'kon (POS spot)
);

-- Product type. 'semi' = Yarim Fabrika (decision D2 — dual flow).
CREATE TYPE product_type AS ENUM (
    'raw',                -- xom-ashyo (flour, sugar, cream)
    'semi',               -- yarim tayyor (Yarim Fabrika) — sellable to wh AND BOM input
    'finished'            -- tayyor mahsulot
);

-- Unit of measure. Mapped from Poster ingredient_unit (kg / l / p).
CREATE TYPE unit_type AS ENUM ('kg', 'l', 'pcs');

-- RBAC roles (TZ section 3).
CREATE TYPE user_role AS ENUM (
    'pm',                 -- Super Admin / PM — whole chain
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant'        -- read + approved commands, role-limited
);

-- stock_movement reason (TZ section 7).
CREATE TYPE movement_reason AS ENUM (
    'sale',               -- POS sale (Poster sync) — qty leaves a store
    'production_input',   -- raw/semi consumed by production (BOM)
    'production_output',  -- finished/semi produced -> central warehouse
    'transfer',           -- shipment between locations
    'purchase',           -- external purchase received into raw warehouse
    'adjust'              -- inventory correction / Poster leftovers reconciliation
);

-- Replenishment request state machine (TZ section 8.2). See ADR-0001.
CREATE TYPE replenishment_status AS ENUM (
    'NEW',
    'CHECK_STORE_SUPPLIER',
    'SHIP_TO_REQUESTER',
    'CHECK_PRODUCTION_INPUT',
    'CREATE_PURCHASE_ORDER',
    'CREATE_PRODUCTION_ORDER',
    'PRODUCING',
    'DONE_TO_WAREHOUSE',
    'CLOSED',
    'CANCELLED'           -- terminal: manually cancelled / superseded
);

-- production_order status (TZ section 6.2).
CREATE TYPE production_order_status AS ENUM (
    'new',                -- Yangi
    'in_progress',        -- Jarayonda
    'done',               -- Tayyor — triggers atomic BOM consume + warehouse receive
    'cancelled'
);

-- purchase_order / supply request status — two-step approval (decision D5).
CREATE TYPE purchase_order_status AS ENUM (
    'draft',              -- created by replenishment engine, awaiting approvals
    'manager_approved',   -- boshliq tasdiqladi
    'keeper_approved',    -- skladchi tasdiqladi (only meaningful with the other)
    'approved',           -- BOTH approved — purchase is in effect
    'received',           -- goods received into raw warehouse
    'cancelled',
    'rejected'
);

-- Poster sync entity kinds (for poster_sync_log).
CREATE TYPE poster_sync_entity AS ENUM (
    'spots', 'storages', 'ingredients', 'products', 'leftovers', 'transactions'
);

CREATE TYPE poster_sync_status AS ENUM ('ok', 'partial', 'failed');

-- -----------------------------------------------------------------------------
-- 2. CORE REFERENCE TABLES
-- -----------------------------------------------------------------------------

-- 2.1 locations — every link in the supply chain.
-- Maps to Poster spots (stores) and storages (warehouses) — see poster_* columns.
CREATE TABLE locations (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            TEXT          NOT NULL,
    type            location_type NOT NULL,
    parent_id       BIGINT        REFERENCES locations(id) ON DELETE RESTRICT,
    -- Poster mapping. A store maps to a Poster spot; a warehouse to a Poster storage.
    poster_spot_id      INTEGER,        -- set when type = 'store'
    poster_storage_id   INTEGER,        -- set for warehouse/supply/production locations
    lead_time_days  NUMERIC(5,2)  NOT NULL DEFAULT 1   CHECK (lead_time_days >= 0),
    review_days     NUMERIC(5,2)  NOT NULL DEFAULT 2   CHECK (review_days >= 0),
    safety_factor   NUMERIC(5,2)  NOT NULL DEFAULT 1.3 CHECK (safety_factor >= 1),
    is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
COMMENT ON COLUMN locations.poster_spot_id    IS 'Poster spot_id — set for type=store';
COMMENT ON COLUMN locations.poster_storage_id IS
    'Poster storage_id — set for warehouse/supply/production locations. '
    'The storage->location_type classification (which of the 25 Poster storages '
    'is raw_warehouse / central_warehouse / production / supply) is seed-time '
    'configuration provided by the owner — see spec section 8.';
COMMENT ON COLUMN locations.parent_id IS
    'Upstream supplier link in the chain. The full topology (each store -> its '
    'central warehouse, each warehouse -> its production/supply) is seed-time '
    'configuration provided by the owner — see spec section 8.';
COMMENT ON COLUMN locations.lead_time_days    IS 'Phase-2 dynamic min/max input (TZ 8.3)';
-- One ADIA location per Poster entity (no duplicate mapping).
CREATE UNIQUE INDEX uq_locations_poster_spot    ON locations(poster_spot_id)    WHERE poster_spot_id    IS NOT NULL;
CREATE UNIQUE INDEX uq_locations_poster_storage ON locations(poster_storage_id) WHERE poster_storage_id IS NOT NULL;
CREATE INDEX ix_locations_type   ON locations(type);
CREATE INDEX ix_locations_parent ON locations(parent_id);

-- 2.2 users — each user belongs to one location and one role (decision D6).
CREATE TABLE users (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            TEXT        NOT NULL,
    email           TEXT        NOT NULL UNIQUE,
    password_hash   TEXT        NOT NULL,
    role            user_role   NOT NULL,
    location_id     BIGINT      REFERENCES locations(id) ON DELETE RESTRICT,
    telegram_id     BIGINT,                                  -- for Telegram notifications
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- pm and ai_assistant are chain-wide and may have NULL location;
    -- all other roles MUST be bound to a location (RBAC is location-scoped).
    CONSTRAINT chk_users_location_required
        CHECK (role IN ('pm','ai_assistant') OR location_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX ix_users_location ON users(location_id);
CREATE INDEX ix_users_role     ON users(role);

-- One designated manager per location (decision D6). Nullable until staffed.
ALTER TABLE locations
    ADD COLUMN manager_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- 2.3 products — raw / semi / finished. Maps to Poster ingredient and/or product.
-- Poster mapping rule (research-analyst, 2026-05-22):
--   storage.getStorageLeftovers ALWAYS returns ingredient_id — for BOTH
--   type=1 (raw ingredient) AND type=2 (finished good). So every stock row,
--   regardless of product type, is keyed by Poster ingredient_id.
--   -> products.poster_ingredient_id is the join key for ALL leftover sync
--      (raw, semi AND finished products that have a storage presence).
--   -> products.poster_product_id is ONLY for the menu product id used by
--      menu.getProducts and sales checks (dash.getTransaction line product_id).
--   A finished product typically has BOTH columns set; a pure raw material
--   has only poster_ingredient_id; a non-stocked menu item only poster_product_id.
CREATE TABLE products (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            TEXT         NOT NULL,
    type            product_type NOT NULL,
    unit            unit_type    NOT NULL,
    sku             TEXT         UNIQUE,
    -- Poster storage ingredient id — join key for storage.getStorageLeftovers
    -- (returns ingredient_id for type=1 raw AND type=2 finished alike).
    poster_ingredient_id INTEGER,
    -- Poster menu product id — used by menu.getProducts and sales check lines
    -- (dash.getTransaction product_id). NOT used for leftover sync.
    poster_product_id    INTEGER,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON COLUMN products.poster_ingredient_id IS
    'Poster ingredient_id — join key for storage.getStorageLeftovers (type=1 AND type=2)';
COMMENT ON COLUMN products.poster_product_id IS
    'Poster menu product_id — used by menu.getProducts and sales check lines only';
CREATE UNIQUE INDEX uq_products_poster_ingredient ON products(poster_ingredient_id) WHERE poster_ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX uq_products_poster_product    ON products(poster_product_id)    WHERE poster_product_id    IS NOT NULL;
CREATE INDEX ix_products_type ON products(type);

-- 2.4 recipes — Bill of Materials. 1 unit of product = qty_per_unit of component.
-- A 'semi' product can appear both as a recipe.product_id and as a component
-- (decision D2 — Yarim Fabrika dual flow).
CREATE TABLE recipes (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id           BIGINT       NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    component_product_id BIGINT       NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty_per_unit         NUMERIC(14,4) NOT NULL CHECK (qty_per_unit > 0),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_recipe_no_self  CHECK (product_id <> component_product_id),
    CONSTRAINT uq_recipe_component UNIQUE (product_id, component_product_id)
);
CREATE INDEX ix_recipes_product   ON recipes(product_id);
CREATE INDEX ix_recipes_component ON recipes(component_product_id);

-- -----------------------------------------------------------------------------
-- 3. STOCK & MOVEMENTS
-- -----------------------------------------------------------------------------

-- 3.1 stock — current on-hand qty and min/max per (location, product).
-- Composite PK enforces invariant 4: one min/max pair per (location, product).
-- Invariant 3: qty CHECK (qty >= 0).
CREATE TABLE stock (
    location_id   BIGINT        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    product_id    BIGINT        NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
    qty           NUMERIC(14,4) NOT NULL DEFAULT 0  CHECK (qty >= 0),
    -- min/max: seeded from Poster limit_value when > 0, else entered by PM.
    -- NOTE: Poster storage.getStorageLeftovers limit_value is "0" for most
    -- products, so min_level is predominantly hand-entered (minmax_mode='manual').
    min_level     NUMERIC(14,4) NOT NULL DEFAULT 0  CHECK (min_level >= 0),
    max_level     NUMERIC(14,4) NOT NULL DEFAULT 0  CHECK (max_level >= 0),
    -- min/max recompute mode: 'manual' = fixed; 'dynamic' = nightly cron (Phase 2).
    minmax_mode   TEXT          NOT NULL DEFAULT 'manual'
                  CHECK (minmax_mode IN ('manual','dynamic')),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, product_id),
    CONSTRAINT chk_stock_minmax CHECK (max_level >= min_level)
);
CREATE INDEX ix_stock_product ON stock(product_id);
-- Partial index to make the replenishment scan (qty <= min) fast.
CREATE INDEX ix_stock_below_min ON stock(location_id, product_id)
    WHERE qty <= min_level;

-- 3.2 stock_movements — append-only ledger. Every row = one atomic transaction.
-- Either from_location_id or to_location_id (or both for transfer) is set.
CREATE TABLE stock_movements (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id         BIGINT          NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    from_location_id   BIGINT          REFERENCES locations(id) ON DELETE RESTRICT,
    to_location_id     BIGINT          REFERENCES locations(id) ON DELETE RESTRICT,
    qty                NUMERIC(14,4)   NOT NULL CHECK (qty > 0),
    reason             movement_reason NOT NULL,
    -- optional links to the originating document
    replenishment_id   BIGINT,
    production_order_id BIGINT,
    purchase_order_id  BIGINT,
    poster_transaction_id BIGINT,       -- set when reason='sale' (Poster sync) — idempotency
    note               TEXT,
    created_by         BIGINT          REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
    CONSTRAINT chk_movement_endpoints
        CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
    CONSTRAINT chk_movement_distinct
        CHECK (from_location_id IS DISTINCT FROM to_location_id
               OR from_location_id IS NULL)
);
CREATE INDEX ix_movements_product   ON stock_movements(product_id);
CREATE INDEX ix_movements_from      ON stock_movements(from_location_id);
CREATE INDEX ix_movements_to        ON stock_movements(to_location_id);
CREATE INDEX ix_movements_created   ON stock_movements(created_at DESC);
CREATE INDEX ix_movements_reason    ON stock_movements(reason);
-- Idempotency: each Poster sale line is recorded at most once.
CREATE UNIQUE INDEX uq_movements_poster_tx
    ON stock_movements(poster_transaction_id, product_id, from_location_id)
    WHERE poster_transaction_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. REPLENISHMENT
-- -----------------------------------------------------------------------------

-- 4.1 replenishment_requests — state machine (TZ 8.2). See ADR-0001.
CREATE TABLE replenishment_requests (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id           BIGINT               NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    requester_location_id BIGINT              NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    target_location_id   BIGINT               REFERENCES locations(id) ON DELETE RESTRICT,
    qty_needed           NUMERIC(14,4)        NOT NULL CHECK (qty_needed > 0),
    status               replenishment_status NOT NULL DEFAULT 'NEW',
    -- documents created while advancing the state machine
    production_order_id  BIGINT,
    purchase_order_id    BIGINT,
    shipment_movement_id BIGINT REFERENCES stock_movements(id) ON DELETE SET NULL,
    note                 TEXT,
    created_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ          NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ          NOT NULL DEFAULT now(),
    closed_at            TIMESTAMPTZ
);
-- Invariant 2: only ONE open request per (product, requester_location).
-- Open = any status that is not terminal (CLOSED / CANCELLED).
CREATE UNIQUE INDEX uq_replenishment_one_open
    ON replenishment_requests(product_id, requester_location_id)
    WHERE status NOT IN ('CLOSED','CANCELLED');
CREATE INDEX ix_replenishment_status    ON replenishment_requests(status);
CREATE INDEX ix_replenishment_requester ON replenishment_requests(requester_location_id);
CREATE INDEX ix_replenishment_target    ON replenishment_requests(target_location_id);

-- 4.2 replenishment_transitions — audit trail of every state machine step.
CREATE TABLE replenishment_transitions (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    replenishment_id  BIGINT               NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
    from_status       replenishment_status,
    to_status         replenishment_status NOT NULL,
    reason            TEXT,                -- e.g. 'enough stock', 'raw shortage'
    actor_user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system/cron
    created_at        TIMESTAMPTZ          NOT NULL DEFAULT now()
);
CREATE INDEX ix_repl_transitions_req ON replenishment_transitions(replenishment_id);

-- -----------------------------------------------------------------------------
-- 5. PRODUCTION
-- -----------------------------------------------------------------------------

-- 5.1 production_orders — zayafka (TZ 6.2).
CREATE TABLE production_orders (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id    BIGINT                  NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty           NUMERIC(14,4)           NOT NULL CHECK (qty > 0),
    location_id   BIGINT                  NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,  -- production location
    target_location_id BIGINT             REFERENCES locations(id) ON DELETE RESTRICT,           -- where output goes (central wh)
    deadline      DATE,
    status        production_order_status NOT NULL DEFAULT 'new',
    replenishment_id BIGINT REFERENCES replenishment_requests(id) ON DELETE SET NULL,
    note          TEXT,
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ             NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ             NOT NULL DEFAULT now(),
    done_at       TIMESTAMPTZ
);
CREATE INDEX ix_production_status   ON production_orders(status);
CREATE INDEX ix_production_product  ON production_orders(product_id);
CREATE INDEX ix_production_location ON production_orders(location_id);

-- -----------------------------------------------------------------------------
-- 6. PURCHASE ORDERS — two-step approval (decision D5)
-- -----------------------------------------------------------------------------

-- 6.1 suppliers — minimal in Phase 1.
CREATE TABLE suppliers (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT        NOT NULL,
    phone        TEXT,
    note         TEXT,
    poster_supplier_id INTEGER,          -- maps to Poster storage.getSuppliers
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_suppliers_poster ON suppliers(poster_supplier_id) WHERE poster_supplier_id IS NOT NULL;

-- 6.2 purchase_orders — "Yetkazib berishga so'rov" (supply request).
-- Takes effect only when BOTH manager and warehouse keeper approve (D5):
-- status reaches 'approved' only when both *_approved_by columns are set.
CREATE TABLE purchase_orders (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id           BIGINT                NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty                  NUMERIC(14,4)         NOT NULL CHECK (qty > 0),
    supplier_id          BIGINT                REFERENCES suppliers(id) ON DELETE SET NULL,
    target_location_id   BIGINT                NOT NULL REFERENCES locations(id) ON DELETE RESTRICT, -- raw warehouse
    status               purchase_order_status NOT NULL DEFAULT 'draft',
    replenishment_id     BIGINT                REFERENCES replenishment_requests(id) ON DELETE SET NULL,
    -- two-step approval audit
    manager_approved_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    manager_approved_at  TIMESTAMPTZ,
    keeper_approved_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    keeper_approved_at   TIMESTAMPTZ,
    received_movement_id BIGINT REFERENCES stock_movements(id) ON DELETE SET NULL,
    note                 TEXT,
    created_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ           NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ           NOT NULL DEFAULT now(),
    -- 'approved' requires both approvals present; consistency guard.
    CONSTRAINT chk_po_approved_consistency CHECK (
        status <> 'approved'
        OR (manager_approved_by IS NOT NULL AND keeper_approved_by IS NOT NULL)
    )
);
CREATE INDEX ix_purchase_status   ON purchase_orders(status);
CREATE INDEX ix_purchase_product  ON purchase_orders(product_id);
CREATE INDEX ix_purchase_supplier ON purchase_orders(supplier_id);

-- Deferred FK wiring (forward references resolved here).
ALTER TABLE replenishment_requests
    ADD CONSTRAINT fk_repl_production
        FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_repl_purchase
        FOREIGN KEY (purchase_order_id)   REFERENCES purchase_orders(id)   ON DELETE SET NULL;
ALTER TABLE stock_movements
    ADD CONSTRAINT fk_mov_replenishment
        FOREIGN KEY (replenishment_id)    REFERENCES replenishment_requests(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_mov_production
        FOREIGN KEY (production_order_id) REFERENCES production_orders(id)      ON DELETE SET NULL,
    ADD CONSTRAINT fk_mov_purchase
        FOREIGN KEY (purchase_order_id)   REFERENCES purchase_orders(id)        ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 7. SALES & SALES STATISTICS (Poster sync)
-- -----------------------------------------------------------------------------

-- 7.1 sales — one row per sold product line, synced from Poster transactions.
-- product_id is resolved from the Poster check line product_id via
-- products.poster_product_id (NOT poster_ingredient_id — see products comment).
CREATE TABLE sales (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id              BIGINT        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    product_id            BIGINT        NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
    qty                   NUMERIC(14,4) NOT NULL CHECK (qty > 0),
    price                 NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),  -- UZS, whole sum
    sold_at               TIMESTAMPTZ   NOT NULL,
    poster_transaction_id BIGINT        NOT NULL,         -- Poster check id
    poster_line_id        BIGINT,                         -- line within the check
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);
-- Idempotent Poster sync: a check line is imported once.
CREATE UNIQUE INDEX uq_sales_poster_line
    ON sales(poster_transaction_id, product_id, poster_line_id);
CREATE INDEX ix_sales_store_date ON sales(store_id, sold_at);
CREATE INDEX ix_sales_product    ON sales(product_id);

-- 7.2 sales_stats_daily — daily aggregate per (location, product).
-- Feeds the Phase-2 dynamic min/max cron (TZ 8.3). In Phase 1 it is only
-- populated by the nightly aggregation job; recompute of min/max is Phase 2.
CREATE TABLE sales_stats_daily (
    location_id  BIGINT        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    product_id   BIGINT        NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    stat_date    DATE          NOT NULL,
    qty_sold     NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (qty_sold >= 0),
    avg_7d       NUMERIC(14,4),
    avg_30d      NUMERIC(14,4),
    PRIMARY KEY (location_id, product_id, stat_date)
);
CREATE INDEX ix_sales_stats_date ON sales_stats_daily(stat_date);

-- -----------------------------------------------------------------------------
-- 8. POSTER INTEGRATION SUPPORT
-- -----------------------------------------------------------------------------

-- 8.1 poster_sync_log — observability of every sync run (poll or webhook).
CREATE TABLE poster_sync_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity        poster_sync_entity NOT NULL,
    status        poster_sync_status NOT NULL,
    trigger       TEXT               NOT NULL CHECK (trigger IN ('poll','webhook','manual')),
    records_in    INTEGER            NOT NULL DEFAULT 0,
    records_applied INTEGER          NOT NULL DEFAULT 0,
    error_detail  TEXT,
    started_at    TIMESTAMPTZ        NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE INDEX ix_poster_sync_entity ON poster_sync_log(entity, started_at DESC);

-- 8.2 poster_webhook_events — raw inbound webhook payloads (idempotency + replay).
CREATE TABLE poster_webhook_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type    TEXT        NOT NULL,            -- transaction.close, product.update, ...
    poster_object_id BIGINT,                       -- transaction_id / product_id
    payload       JSONB       NOT NULL,
    processed     BOOLEAN     NOT NULL DEFAULT FALSE,
    processed_at  TIMESTAMPTZ,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_poster_webhook_unprocessed ON poster_webhook_events(received_at)
    WHERE processed = FALSE;

-- -----------------------------------------------------------------------------
-- 9. NOTIFICATIONS (Telegram)
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_user_id BIGINT      REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT        NOT NULL,        -- stock_below_min, new_production_order, ...
    title         TEXT        NOT NULL,
    body          TEXT        NOT NULL,
    payload       JSONB,
    telegram_sent BOOLEAN     NOT NULL DEFAULT FALSE,
    telegram_sent_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_recipient ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX ix_notifications_unsent    ON notifications(created_at) WHERE telegram_sent = FALSE;

-- -----------------------------------------------------------------------------
-- 10. AUDIT LOG (TZ section 13 — every change)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id BIGINT     REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system/cron
    action      TEXT        NOT NULL,          -- e.g. 'stock_movement.create'
    entity      TEXT        NOT NULL,          -- table / aggregate name
    entity_id   BIGINT,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity  ON audit_log(entity, entity_id);
CREATE INDEX ix_audit_actor   ON audit_log(actor_user_id);
CREATE INDEX ix_audit_created ON audit_log(created_at DESC);

-- -----------------------------------------------------------------------------
-- 11. updated_at TRIGGER
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_locations_updated   BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated       BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_stock_updated       BEFORE UPDATE ON stock
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_replenishment_updated BEFORE UPDATE ON replenishment_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_production_updated  BEFORE UPDATE ON production_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_updated    BEFORE UPDATE ON purchase_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- NOTE on atomic stock movements (invariant 1 & 5)
-- The application MUST perform every stock change inside a single transaction:
--   BEGIN;
--     -- guarded decrement: WHERE clause makes a negative result impossible
--     UPDATE stock SET qty = qty - :qty
--       WHERE location_id = :from AND product_id = :pid AND qty >= :qty;
--     -- if ROW COUNT = 0 -> raise 'insufficient stock', ROLLBACK
--     INSERT INTO stock (location_id, product_id, qty) VALUES (:to, :pid, :qty)
--       ON CONFLICT (location_id, product_id) DO UPDATE SET qty = stock.qty + :qty;
--     INSERT INTO stock_movements (...) VALUES (...);
--     INSERT INTO audit_log (...) VALUES (...);
--   COMMIT;
-- The CHECK (qty >= 0) is the last line of defence; the guarded WHERE is primary.
-- =============================================================================
