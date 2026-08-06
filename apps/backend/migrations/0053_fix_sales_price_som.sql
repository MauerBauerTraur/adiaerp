-- 0053: Convert sales.price from tiyin to so'm
-- Poster dash.getTransaction returns product_price in tiyin (1 so'm = 100 tiyin).
-- Previously salesSync stored the raw value without dividing by 100.
-- This migration corrects all existing rows; new rows are stored correctly
-- after the salesSync fix in the same release.

UPDATE sales SET price = price / 100 WHERE price > 100;
