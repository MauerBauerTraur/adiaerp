-- =============================================================================
-- 0020_fix_ecosystem_canvas_data.sql
--
-- Fixes 3 ecosystem-canvas data bugs that surface as empty cards / stuck
-- min_level=0 / orphan replenishment requests. Each fix is data-only and
-- idempotent; schema is unchanged.
--
-- Bug 1 (locations 38, 39 — supply nodes "Ta'minot — Yarim Fabrika" and
--       "Ta'minot — Perojniy"): no stock rows at all.
--   Root cause: the supply layer is a logical hand-off node in the ADIA
--   chain. It has no `poster_storage_id`, so the Poster leftover sync never
--   creates rows for it. The ecosystem canvas needs at least a small set of
--   stock rows per supply node to render the "SKU yo'q" pulse correctly.
--   Fix: seed a small starter set (5 products each) at qty=0 so the canvas
--   shows non-empty product counts and so the replenishment engine has a
--   target row to write to when a downstream store requests it.
--
-- Bug 2 (Кукча / Рабочий / every store): min_level=0 across the board.
--   Root cause: `stock.minmax_mode` defaults to 'manual' (0001_init.sql:238),
--   and the nightly recalc (`minmaxRecalcCron`) only touches rows with
--   `minmax_mode='dynamic'`. No one ever flipped the flag, so the formula
--   never ran even though `sales_stats_daily` has weeks of usable history.
--   Fix: for every stock row at a STORE (5,6,7,8,9,10) whose (loc, product)
--   has at least one `sales_stats_daily` row with avg_7d>0 or avg_30d>0,
--   flip `minmax_mode='dynamic'`. The recalc cron will pick them up; the
--   manual-trigger script `scripts/recalc-minmax.ts` runs it right away.
--
-- Bug 3 (Рабочий — store id 7): 0 stock rows but 1 open replenishment req.
--   Root cause: same as #1 — no `poster_storage_id` mapping, so the Poster
--   sync skipped the location entirely and never created a stock row. The
--   request (id=121) was created earlier (manually, via the assistant, or
--   via a state-machine path) and is still PRODUCING — the orphan is real
--   work in flight, not bad data. We do NOT cancel it; we backfill stock
--   rows so the engine has somewhere to deposit the produced goods.
--
-- Backfill rule (Bugs 1 + 3): we only INSERT — never UPDATE — and we ON
-- CONFLICT DO NOTHING so an existing row (e.g. Кукча's two manually-seeded
-- products) is left untouched.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Bug 2 — flip stock rows at stores to `dynamic` where we have sales data.
-- ---------------------------------------------------------------------------
-- The DML is a single statement so it is atomic. The subquery uses EXISTS,
-- not a JOIN, so each stock row is updated at most once.
UPDATE stock s
   SET minmax_mode = 'dynamic'
  FROM locations l
 WHERE s.location_id = l.id
   AND l.type = 'store'
   AND s.minmax_mode = 'manual'
   AND EXISTS (
       SELECT 1
         FROM sales_stats_daily ss
        WHERE ss.location_id = s.location_id
          AND ss.product_id = s.product_id
          AND (ss.avg_7d > 0 OR ss.avg_30d > 0)
   );

-- ---------------------------------------------------------------------------
-- Bugs 1 + 3 — backfill stock rows from `sales_stats_daily`.
-- ---------------------------------------------------------------------------
-- For every (store_location_id, product_id) pair that has at least one
-- sales-stats row with avg_7d > 0 or avg_30d > 0, ensure a stock row exists.
-- New rows start at qty=0, minmax_mode='dynamic' so the recalc cron picks
-- them up on the next pass.
INSERT INTO stock (location_id, product_id, qty, min_level, max_level, minmax_mode)
SELECT DISTINCT ss.location_id, ss.product_id, 0, 0, 0, 'dynamic'
  FROM sales_stats_daily ss
  JOIN locations l ON l.id = ss.location_id
 WHERE l.type = 'store'
   AND (ss.avg_7d > 0 OR ss.avg_30d > 0)
ON CONFLICT (location_id, product_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Bug 1 — seed a small starter stock for supply nodes 38 (Yarim Fabrika)
-- and 39 (Perojniy). We pick the first 5 semi-finished and finished
-- products as a representative sample. qty=0; min/max stay at 0 (manual
-- — these supply nodes have no sales history so dynamic recalc would skip
-- them anyway).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    yarim_id BIGINT;
    perojniy_id BIGINT;
BEGIN
    SELECT id INTO yarim_id
      FROM locations
     WHERE type = 'supply' AND name = 'Ta''minot — Yarim Fabrika'
     LIMIT 1;

    SELECT id INTO perojniy_id
      FROM locations
     WHERE type = 'supply' AND name = 'Ta''minot — Perojniy'
     LIMIT 1;

    -- Yarim Fabrika carries semi-finished goods.
    IF yarim_id IS NOT NULL THEN
        INSERT INTO stock (location_id, product_id, qty, min_level, max_level, minmax_mode)
        SELECT yarim_id, p.id, 0, 0, 0, 'manual'
          FROM products p
         WHERE p.type = 'semi'
         ORDER BY p.id
         LIMIT 5
        ON CONFLICT (location_id, product_id) DO NOTHING;
    END IF;

    -- Perojniy carries finished pastries; we sample finished products.
    IF perojniy_id IS NOT NULL THEN
        INSERT INTO stock (location_id, product_id, qty, min_level, max_level, minmax_mode)
        SELECT perojniy_id, p.id, 0, 0, 0, 'manual'
          FROM products p
         WHERE p.type = 'finished'
         ORDER BY p.id
         LIMIT 5
        ON CONFLICT (location_id, product_id) DO NOTHING;
    END IF;
END$$;
