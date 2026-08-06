-- 0054: Convert products.cost_price and sell_price from tiyin to so'm
-- seedSync.ts stored p.cost and full.price directly without dividing by 100.
-- Identifying tiyin values: cost_price > 100000 (impossible as so'm for bakery items)
-- and sell_price > 100000 (all sell_prices from Poster sync are in tiyin).
-- stockSync.ts already divides by 100 correctly — those values are untouched.

-- Fix cost_price: values > 100000 are definitely tiyin (no bakery ingredient costs > 100,000 som/unit)
UPDATE products SET cost_price = ROUND(cost_price / 100, 4)
WHERE cost_price > 100000;

-- Fix sell_price: all non-null sell_prices from Poster are in tiyin
UPDATE products SET sell_price = ROUND(sell_price / 100, 2)
WHERE sell_price > 100000;
