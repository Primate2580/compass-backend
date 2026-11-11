-- Run this ONCE in the Neon SQL Editor (or psql) on a database that was created before login existed.
-- It adds a place to store each user's hashed password. (Fresh installs from the new compass_schema.sql already have it.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

-- Test accounts made before login existed have no password and can't log in.
-- Just register again with the same or a different email, or delete the old test rows:
--   DELETE FROM users WHERE password_hash IS NULL;
