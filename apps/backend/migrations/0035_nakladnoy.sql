-- =============================================================================
-- 0035 — nakladnoy (material requisition document) — EPIC 8.4.
-- =============================================================================
-- Owner feedback (2026-05-29, changes-2026-05-owner-feedback.md §8.4):
--   "10 Napoleon sotildi" -> hamir uchun / krem uchun nakladnoy. Ikkalasi
--   bitta nakladnoyda tepa-past: krem uchun (un, shakar...), hamir uchun
--   (un, shakar...), ITOGO umumiy un/shakar kg.
--
-- A `nakladnoy` is a PURE ADIA document (egasi qarori — Poster read-only, NO
-- write-back). It records, for a production demand of N units of a finished
-- product, the materials that demand consumes — broken down BY RECIPE STAGE
-- (hamir/krem/bezak, from recipes.stage base/decoration/assembly) PLUS an
-- ITOGO total that sums the same raw component across all stages.
--
-- It NEVER mutates stock and NEVER writes to Poster — it is a read/print
-- artefact the production + admin side use to plan material draw-down. Stock
-- movements stay the responsibility of production_orders / replenishment.
--
-- IDEMPOTENT: enums created only when missing; tables/indexes use IF NOT
-- EXISTS. Purely additive — no data deleted or rewritten.
-- =============================================================================

-- Where the nakladnoy demand came from. 'sale' = a Poster sale check drove it
-- (8.4 zayavka->nakladnoy); 'manual' = an operator raised it from the UI;
-- 'voice' = a store voice message (8.6); 'cash_shift' = a closed kassa shift
-- (8.5); 'safe_expense' = a seyf rasxod (8.7).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'nakladnoy_source') THEN
    CREATE TYPE nakladnoy_source AS ENUM
      ('sale', 'manual', 'voice', 'cash_shift', 'safe_expense', 'production_order');
  END IF;
END$$;

-- Section a nakladnoy line belongs to. Mirrors recipes.stage but stays a
-- SEPARATE enum so the human-facing document vocabulary (hamir/krem/bezak/
-- itogo) can evolve without touching the recipe model. 'itogo' = the grand
-- total rows that aggregate one raw component across every stage.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'nakladnoy_section') THEN
    CREATE TYPE nakladnoy_section AS ENUM ('hamir', 'krem', 'bezak', 'itogo');
  END IF;
END$$;

-- 1. nakladnoy — header.
CREATE TABLE IF NOT EXISTS nakladnoy (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          nakladnoy_source NOT NULL,
    -- Free-form reference to the originating document (e.g. a Poster
    -- transaction_id, a voice_message id, a cash_shift id). Kept TEXT so any
    -- source kind can fill it without a per-source FK forest.
    source_ref      TEXT,
    -- The finished product this nakladnoy was generated for (NULL when the
    -- nakladnoy aggregates many products, e.g. a whole cash shift).
    product_id      BIGINT       REFERENCES products(id) ON DELETE RESTRICT,
    -- How many units of `product_id` drove the material breakdown.
    qty             NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
    -- The location the document is scoped to (the sex / store) — RBAC anchor.
    location_id     BIGINT       REFERENCES locations(id) ON DELETE RESTRICT,
    -- Optional money total in so'm (cash-shift nakladnoy 8.5 sets it; a pure
    -- material nakladnoy leaves it 0).
    total_amount    NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    note            TEXT,
    created_by      BIGINT       REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_nakladnoy_location ON nakladnoy(location_id);
CREATE INDEX IF NOT EXISTS ix_nakladnoy_product  ON nakladnoy(product_id);
CREATE INDEX IF NOT EXISTS ix_nakladnoy_created  ON nakladnoy(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_nakladnoy_source   ON nakladnoy(source, source_ref);

-- 2. nakladnoy_lines — one row per (section, component). The `itogo` section
-- rows are the per-raw-component grand totals; the hamir/krem/bezak rows are
-- the per-stage breakdown. component_product_id may be NULL only for a
-- money-only line (cash shift) — material lines always reference a product.
CREATE TABLE IF NOT EXISTS nakladnoy_lines (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nakladnoy_id         BIGINT NOT NULL REFERENCES nakladnoy(id) ON DELETE CASCADE,
    section              nakladnoy_section NOT NULL,
    component_product_id BIGINT REFERENCES products(id) ON DELETE RESTRICT,
    -- Human label captured at generation time (so a renamed/deleted product
    -- still prints sensibly on an old document).
    label                TEXT NOT NULL,
    qty                  NUMERIC(16,4) NOT NULL CHECK (qty >= 0),
    unit                 TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_nakladnoy_lines_doc ON nakladnoy_lines(nakladnoy_id);
CREATE INDEX IF NOT EXISTS ix_nakladnoy_lines_section
    ON nakladnoy_lines(nakladnoy_id, section);

COMMENT ON TABLE nakladnoy IS
  'EPIC 8.4 — material requisition document generated from a production demand. '
  'Pure ADIA artefact (Poster read-only, no write-back); never mutates stock.';
COMMENT ON TABLE nakladnoy_lines IS
  'Per-(section, component) lines. section hamir/krem/bezak = recipe-stage '
  'breakdown; section itogo = grand total of one raw component across stages.';
