-- =============================================================================
-- F4.12 — users.username (login alternative to email).
-- =============================================================================
-- Add an optional, human-friendly login handle alongside the existing email.
-- The application accepts either as `login` in POST /api/auth/login — emails
-- are detected by the presence of `@`, everything else is matched against
-- this column (case-insensitive, normalised).
--
-- Apply order:
--   1. Add the column NULLable so the back-fill can populate every row.
--   2. Back-fill from email's local-part (lowercase, ASCII-safe charset).
--   3. Coerce empty / too-short fallbacks to `u<id>`.
--   4. Disambiguate collisions by appending `_<id>` to every row but the lowest.
--   5. Lock the column down: NOT NULL + UNIQUE + format CHECK + index.
--
-- Charset for usernames: lowercase ASCII letters + digits + `.`, `_`, `-`.
-- Length 3..32. The regex check is applied at the DB so the application
-- guard and the constraint can never disagree.
-- =============================================================================

-- 1. Add the column.
ALTER TABLE users ADD COLUMN username TEXT;

-- 2. Back-fill from email local-part. Lowercase, strip everything outside
--    [a-z0-9._-], cap at 24 chars (leaves room for the `_<id>` disambiguator
--    in step 4 while staying inside the 32-char CHECK). Non-ASCII (e.g.
--    Cyrillic) local-parts collapse to "" and fall through to step 3.
UPDATE users
   SET username = substr(
         lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9._-]', '', 'g')),
         1, 24)
 WHERE username IS NULL;

-- 3. Anything still NULL or shorter than 3 chars (empty, "a", "a@b.c" -> "a")
--    falls back to a guaranteed-unique `user_<id>` form (always >= 6 chars,
--    always inside the 3..32 CHECK).
UPDATE users SET username = 'user_' || id WHERE username IS NULL OR length(username) < 3;

-- 4. Disambiguate collisions: every row sharing a back-filled username
--    except the one with the smallest id gets `_<id>` appended.
WITH dups AS (
    SELECT username
      FROM users
     GROUP BY username
    HAVING count(*) > 1
)
UPDATE users
   SET username = username || '_' || id
 WHERE username IN (SELECT username FROM dups)
   AND id NOT IN (SELECT MIN(id) FROM users GROUP BY username);

-- 5. Lock down.
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT uq_users_username UNIQUE (username);
ALTER TABLE users ADD CONSTRAINT chk_users_username_format
    CHECK (username ~ '^[a-z0-9._-]{3,32}$');
CREATE INDEX ix_users_username ON users(username);
