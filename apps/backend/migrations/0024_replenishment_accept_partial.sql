-- =============================================================================
-- 0023 — Replenishment accept/reject/partial workflow columns.
-- =============================================================================
-- Owner-approved 2026-05-28 — the recipient (do'kon / sex) must HAVE accepted
-- the shipment before the request is considered closed. The recipient can:
--   * accept the full qty   -> closure_reason = 'accepted_full'
--   * accept partially      -> closure_reason = 'accepted_partial'
--     (the unshipped/returned remainder is logged in qty_returned)
--   * reject the shipment   -> closure_reason = 'rejected'
--     (entire qty is counter-shipped back to target_location_id)
--   * return after accept   -> closure_reason = 'returned'
-- The fulfiller (sklad/sex) can also cancel before the shipment leaves:
--   * cancel before ship    -> closure_reason = 'cancelled_by_fulfiller'
-- A requester-initiated cancel uses:
--   * cancel by requester   -> closure_reason = 'cancelled_by_requester'
--
-- The state enum is UNCHANGED — `CLOSED` and `CANCELLED` remain the only
-- terminal statuses. `closure_reason` records HOW the row reached terminal.
--
-- Stock invariant (Variant 2 in the task):
--   * SHIP_TO_REQUESTER already performs the full transfer.
--   * accept_full / accept_partial / reject / return ALL apply a counter
--     stock_movement when the recipient does not keep the full shipped qty,
--     so the ledger stays consistent (the originating SHIP movement is NEVER
--     mutated — only counter-balanced).
--
-- IDEMPOTENT: every ADD COLUMN uses IF NOT EXISTS; the index uses IF NOT EXISTS.
-- =============================================================================

ALTER TABLE replenishment_requests
  ADD COLUMN IF NOT EXISTS qty_accepted    NUMERIC(14,4) NULL,
  ADD COLUMN IF NOT EXISTS qty_returned    NUMERIC(14,4) NULL,
  ADD COLUMN IF NOT EXISTS accept_note     TEXT          NULL,
  ADD COLUMN IF NOT EXISTS reject_reason   TEXT          NULL,
  ADD COLUMN IF NOT EXISTS closure_reason  VARCHAR(32)   NULL;

-- A weak CHECK keeps obviously-bogus closure_reason strings out of the column.
-- It is intentionally NOT a strict enum: deploying a new closure_reason value
-- should not require an ALTER TYPE round-trip.
ALTER TABLE replenishment_requests
  DROP CONSTRAINT IF EXISTS chk_replenishment_closure_reason;
ALTER TABLE replenishment_requests
  ADD CONSTRAINT chk_replenishment_closure_reason
  CHECK (
    closure_reason IS NULL
    OR closure_reason IN (
      'accepted_full',
      'accepted_partial',
      'rejected',
      'returned',
      'cancelled_by_requester',
      'cancelled_by_fulfiller'
    )
  );

CREATE INDEX IF NOT EXISTS replenishment_requests_closure_reason_idx
  ON replenishment_requests(closure_reason)
  WHERE closure_reason IS NOT NULL;
