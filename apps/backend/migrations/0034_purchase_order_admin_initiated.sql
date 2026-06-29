-- =============================================================================
-- EPIC 6.1 — Admin-initiated purchase orders (admin → skladchi).
-- =============================================================================
-- Owner feedback (image21): the admin (PM) places a purchase order and routes
-- it to the warehouse keeper (skladchi = raw_warehouse_manager). The existing
-- two-step approval (manager + keeper) is PRESERVED: an admin-initiated order
-- arrives with the MANAGER step already satisfied (the admin is the orderer),
-- and awaits only the KEEPER (skladchi) confirmation before it is `approved`.
--
-- This migration is additive + idempotent (no destructive SQL): one nullable
-- boolean flag distinguishes admin-initiated orders so the skladchi UI and the
-- notification routing can treat them as "the admin ordered this for you".
-- =============================================================================

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS initiated_by_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN purchase_orders.initiated_by_admin IS
    'EPIC 6.1 — TRUE when an admin (PM) placed the order and routed it to the '
    'warehouse keeper. The manager approval step is pre-filled by the admin; '
    'the keeper (raw_warehouse_manager) still confirms (two-step approval).';
