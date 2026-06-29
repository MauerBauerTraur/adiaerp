-- =============================================================================
-- Drop users.email — username-only identity.
-- =============================================================================
-- The owner decided to remove email ENTIRELY from the user/identity model.
-- Login is now username (`login`) + password only. `username` already exists
-- (migration 0018: NOT NULL UNIQUE, CHECK `^[a-z0-9._-]{3,32}$`) and fully
-- replaces email as the unique human-friendly login handle.
--
-- Forward-only. Dropping the column also drops the email UNIQUE index
-- (`users_email_key`) that Postgres created with the original column.
-- `username` remains the sole login key; its NOT NULL + UNIQUE + format CHECK
-- from migration 0018 are untouched here (re-asserting NOT NULL is a cheap,
-- idempotent safety net).
-- =============================================================================

ALTER TABLE users DROP COLUMN IF EXISTS email;

-- Safety net — username must stay NOT NULL (no-op when already enforced).
ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- Username is now the ONLY login handle. The owner wants the short canonical
-- admin login `pm` (2 chars), which the original 0018 CHECK (`{3,32}`)
-- forbade. Relax the lower bound to 2 so `pm` is a valid login while keeping
-- the charset and 32-char ceiling. UNIQUE + NOT NULL are unchanged.
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_username_format;
ALTER TABLE users ADD CONSTRAINT chk_users_username_format
    CHECK (username ~ '^[a-z0-9._-]{2,32}$');
