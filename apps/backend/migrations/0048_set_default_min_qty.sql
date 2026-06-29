-- Set a temporary default min_qty of 5 for all semi-finished and finished products
-- that currently have no min_qty set. Raw ingredients are excluded since auto-orders
-- apply to produced goods only. The value can be adjusted per-product via
-- PATCH /api/products/:id later.
UPDATE products
   SET min_qty = 5
 WHERE type IN ('semi', 'finished')
   AND min_qty IS NULL;
