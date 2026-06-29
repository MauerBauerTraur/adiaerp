-- =============================================================================
-- 0021 — Add `sex_storage` value to the `location_type` enum.
-- =============================================================================
-- Owner-approved 2026-05-28 (D7). The old `supply` enum value is a generic
-- "ta'minot bo'limi" — in the actual chain every production sex (Tort,
-- Perojniy, Yarim Fabrika) holds its own ready-batch buffer between the sex
-- floor and the central warehouse. We model that buffer as a first-class
-- `sex_storage` location_type so the dashboard and the AI assistant can speak
-- about sex skladi correctly.
--
-- This migration ONLY adds the enum value. The 3 existing `supply` rows are
-- migrated to `sex_storage` in the next file (0022) — they live in separate
-- transactions because PostgreSQL refuses to USE a newly-added enum label
-- inside the SAME transaction that added it (server error 25P02 since PG12).
--
-- Backward compatibility: the `supply` value stays in the enum (used in TS
-- types, dashboards, and the assistant tool layer). It is DEPRECATED but
-- will not be dropped until every reference is migrated (planned 1-2 sprints
-- ahead). New code paths SHOULD treat `sex_storage` as the canonical name
-- and accept `supply` only for legacy clients.
--
-- Idempotent: the `pg_enum` lookup makes re-running this migration a no-op.
-- =============================================================================

-- Scope the check to the CURRENT schema. `pg_type` is global, so a parallel
-- schema that has already added `sex_storage` would otherwise short-circuit
-- this DO block — leaving the current schema's `location_type` without the
-- new value (the failure surface is migration 0022 trying to cast the
-- missing label, error 22P02 "invalid input value for enum location_type:
-- sex_storage").
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e      ON e.enumtypid = t.oid
     WHERE t.typname = 'location_type'
       AND n.nspname = current_schema()
       AND e.enumlabel = 'sex_storage'
  ) THEN
    ALTER TYPE location_type ADD VALUE 'sex_storage' BEFORE 'supply';
  END IF;
END$$;
