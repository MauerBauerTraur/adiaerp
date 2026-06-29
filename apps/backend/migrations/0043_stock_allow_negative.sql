-- Allow stock.qty to go negative for production dispatch receive flow.
-- Previously CHECK (qty >= 0) blocked receiving materials when the
-- source location had insufficient stock. Production managers can now
-- receive materials even when warehouse qty is low; negative balance
-- means the warehouse is in debt and must be replenished.
ALTER TABLE stock DROP CONSTRAINT IF EXISTS stock_qty_check;
