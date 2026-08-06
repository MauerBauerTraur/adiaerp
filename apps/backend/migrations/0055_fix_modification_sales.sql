-- 0055: Fix modification-based sales attribution
--
-- When multiple ERP products share a poster_product_id (e.g. both "ТВОРОЖНЫЙ"
-- and "Г/П ТВОРОЖНЫЙ (ЦЕЛЫЙ)" map to the same Poster product), modifier sales
-- must be attributed to the 'finished'-type product.
--
-- Step 1: Populate poster_product_modifications.product_id correctly
--         (prefer 'finished' type ERP product, matching updated syncModifications logic)
UPDATE poster_product_modifications ppm
SET product_id = (
  SELECT p.id
  FROM products p
  WHERE p.poster_product_id = ppm.poster_product_id
  ORDER BY (p.type = 'finished') DESC, p.id
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM products p
  WHERE p.poster_product_id = ppm.poster_product_id
);

-- Step 2: Fix existing sales that were attributed to wrong product via modification.
-- Exclude rows where the corrected product_id already exists for the same
-- (poster_transaction_id, poster_line_id) to avoid violating the unique constraint.
UPDATE sales s
SET product_id = ppm.product_id
FROM poster_product_modifications ppm
WHERE s.modification_id = ppm.modification_id
  AND ppm.product_id IS NOT NULL
  AND s.product_id != ppm.product_id
  AND NOT EXISTS (
    SELECT 1 FROM sales s2
    WHERE s2.poster_transaction_id = s.poster_transaction_id
      AND s2.poster_line_id = s.poster_line_id
      AND s2.product_id = ppm.product_id
      AND s2.id != s.id
  );
