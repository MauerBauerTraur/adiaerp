-- =============================================================================
-- 0004_purchase_status_cleanup.sql — Phase-2 F2.3 (dead enum cleanup).
--
-- The base schema (0001_init.sql) declared seven values for
-- `purchase_order_status`:
--   draft, manager_approved, keeper_approved, approved, received, cancelled, rejected
--
-- M6 (purchase order service) never sets `manager_approved` or
-- `keeper_approved` — the two-step approval is tracked through the
-- `manager_approved_by` / `keeper_approved_by` audit columns, and the row
-- jumps directly from `draft` to `approved` once BOTH columns are set
-- (chk_po_approved_consistency). The two enum values are dead.
--
-- PostgreSQL does not support `ALTER TYPE ... DROP VALUE`. The migration
-- therefore swaps the enum: rename old -> create new -> ALTER COLUMN with
-- USING -> drop old. The five surviving values are kept in their original
-- declaration order so any code that compares ordinals stays correct.
--
-- A pre-check raises if any row still holds a dead value (defensive; M6
-- has never produced one, but we refuse to drop data silently).
--
-- Idempotent in spirit: if the new enum is already in place, the rename
-- step throws and the migration is recorded as failed — operator inspects
-- and skips. The migration runner records this file only after success.
-- =============================================================================

-- Pre-check: refuse to run if any row still depends on the dead values.
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM purchase_orders
     WHERE status::text IN ('manager_approved','keeper_approved');
    IF n > 0 THEN
        RAISE EXCEPTION
            'Cannot drop dead purchase_order_status values: % row(s) still use them.', n;
    END IF;
END $$;

-- The CHECK constraint `chk_po_approved_consistency` references the column
-- with an enum literal (`status <> 'approved'`). After RENAME TO _old the
-- literal in the cached constraint expression still binds to the renamed
-- type, but ALTER COLUMN ... TYPE re-resolves the column to the NEW type —
-- making the operator `purchase_order_status <> purchase_order_status_old`
-- undefined. Drop the constraint around the swap and recreate it against
-- the fresh type.
ALTER TABLE purchase_orders DROP CONSTRAINT chk_po_approved_consistency;

ALTER TYPE purchase_order_status RENAME TO purchase_order_status_old;

CREATE TYPE purchase_order_status AS ENUM (
    'draft',
    'approved',
    'received',
    'cancelled',
    'rejected'
);

-- DROP / re-set DEFAULT around the type swap; ALTER TYPE with a USING clause
-- only accepts a value cast, not a default expression of the old type.
ALTER TABLE purchase_orders
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN status TYPE purchase_order_status
        USING status::text::purchase_order_status,
    ALTER COLUMN status SET DEFAULT 'draft';

DROP TYPE purchase_order_status_old;

ALTER TABLE purchase_orders
    ADD CONSTRAINT chk_po_approved_consistency CHECK (
        status <> 'approved'
        OR (manager_approved_by IS NOT NULL AND keeper_approved_by IS NOT NULL)
    );
