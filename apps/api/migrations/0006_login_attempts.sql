-- Login rate limiting (spec §10, ADR-029). One row per counter: an email, a client IP, or the pair.
-- A login reserves one attempt on each of its counters before the password is checked, and a
-- successful one gives them back, so the counts are failed (or still running) logins per window.

CREATE TABLE cirrus_login_attempts (
  -- `email:<email>`, `ip:<ip>` or `ip-email:<ip> <email>`, emails in lower case
  id       TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  -- When the window that started with the first attempt ends (ms since the epoch); the row is then deleted
  reset_at INTEGER NOT NULL
);

CREATE INDEX cirrus_login_attempts_reset_at_idx ON cirrus_login_attempts(reset_at);
