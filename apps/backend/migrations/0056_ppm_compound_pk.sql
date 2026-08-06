-- 0056: Change poster_product_modifications PK to (modification_id, poster_product_id)
--
-- The original PK was (modification_id) alone, which prevented the same
-- modification_id from belonging to both a type=3 product's modificator_id AND
-- a type=2 product's transaction modification_id. In practice Poster uses two
-- independent ID spaces that can collide. The compound key allows both to coexist
-- without the type=3 sync clobbering manually-inserted type=2 rows.

ALTER TABLE poster_product_modifications DROP CONSTRAINT poster_product_modifications_pkey;

ALTER TABLE poster_product_modifications
  ADD CONSTRAINT poster_product_modifications_pkey
  PRIMARY KEY (modification_id, poster_product_id);
