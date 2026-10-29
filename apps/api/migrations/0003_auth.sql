-- M3: auth and access control (spec §10). Users get the Directus 11 user fields, refresh tokens
-- live in sessions, and the guard table lets a batch abort itself. Seeds the public policy and an
-- Administrator role, as Directus' bootstrap does.

-- Users ------------------------------------------------------------------------------------------

-- Directus names the field `password`; it holds a PBKDF2 hash (PHC string).
ALTER TABLE cirrus_users RENAME COLUMN password_hash TO password;
ALTER TABLE cirrus_users ADD COLUMN first_name TEXT;
ALTER TABLE cirrus_users ADD COLUMN last_name TEXT;
ALTER TABLE cirrus_users ADD COLUMN location TEXT;
ALTER TABLE cirrus_users ADD COLUMN title TEXT;
ALTER TABLE cirrus_users ADD COLUMN description TEXT;
ALTER TABLE cirrus_users ADD COLUMN tags TEXT CHECK (tags IS NULL OR json_valid(tags));
-- A file (M5)
ALTER TABLE cirrus_users ADD COLUMN avatar TEXT;
ALTER TABLE cirrus_users ADD COLUMN language TEXT;
-- Static token, stored only as its SHA-256 (hex)
ALTER TABLE cirrus_users ADD COLUMN token TEXT;
ALTER TABLE cirrus_users ADD COLUMN last_access TEXT;
ALTER TABLE cirrus_users ADD COLUMN last_page TEXT;
ALTER TABLE cirrus_users ADD COLUMN provider TEXT NOT NULL DEFAULT 'default';
ALTER TABLE cirrus_users ADD COLUMN external_identifier TEXT;
ALTER TABLE cirrus_users ADD COLUMN auth_data TEXT CHECK (auth_data IS NULL OR json_valid(auth_data));
ALTER TABLE cirrus_users ADD COLUMN email_notifications INTEGER DEFAULT 1 CHECK (email_notifications IN (0, 1));
ALTER TABLE cirrus_users ADD COLUMN appearance TEXT;
ALTER TABLE cirrus_users ADD COLUMN theme_dark TEXT;
ALTER TABLE cirrus_users ADD COLUMN theme_light TEXT;
ALTER TABLE cirrus_users ADD COLUMN theme_light_overrides TEXT CHECK (theme_light_overrides IS NULL OR json_valid(theme_light_overrides));
ALTER TABLE cirrus_users ADD COLUMN theme_dark_overrides TEXT CHECK (theme_dark_overrides IS NULL OR json_valid(theme_dark_overrides));

CREATE UNIQUE INDEX cirrus_users_token_idx ON cirrus_users(token);
CREATE UNIQUE INDEX cirrus_users_external_identifier_idx ON cirrus_users(external_identifier);
CREATE INDEX cirrus_users_role_idx ON cirrus_users(role);

-- Sessions: one per refresh token ----------------------------------------------------------------

CREATE TABLE cirrus_sessions (
  -- SHA-256 (hex) of the refresh token; the token itself is never stored
  token      TEXT PRIMARY KEY,
  user       TEXT NOT NULL REFERENCES cirrus_users(id) ON DELETE CASCADE,
  expires    TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  origin     TEXT
);

CREATE INDEX cirrus_sessions_user_idx ON cirrus_sessions(user);

-- Guard ------------------------------------------------------------------------------------------

-- D1 has no interactive transactions. A write that must check rows first puts
-- `INSERT INTO cirrus_guard (ok) SELECT 0 WHERE <violation>` before itself in the same batch: the
-- CHECK fails and the whole batch rolls back. The table never holds rows.
CREATE TABLE cirrus_guard (ok INTEGER CONSTRAINT cirrus_guard CHECK (ok = 1));

-- Seeds ------------------------------------------------------------------------------------------

-- The public policy: an access row with neither role nor user. It applies to requests without a
-- user and to users without a role, and starts with no permissions. Same id as in Directus.
INSERT INTO cirrus_policies (id, name, icon, description, admin_access, app_access)
VALUES ('abf8a154-5b1c-4a46-ac9c-7300570f4f17', '$t:public_label', 'public', '$t:public_description', 0, 0);
INSERT INTO cirrus_access (id, role, user, policy, sort)
VALUES ('01a1857c-69db-7212-b6c4-c1b61b492f79', NULL, NULL, 'abf8a154-5b1c-4a46-ac9c-7300570f4f17', 1);

-- Administrator role with an admin policy, for the first user (see README).
INSERT INTO cirrus_roles (id, name, icon, description)
VALUES ('01a1857c-54d5-7148-8495-9e81c8a7caa5', 'Administrator', 'verified', '$t:admin_description');
INSERT INTO cirrus_policies (id, name, icon, description, admin_access, app_access)
VALUES ('01a1857c-54dc-7546-ac55-49cd6ccdcab3', 'Administrator', 'verified', '$t:admin_description', 1, 1);
INSERT INTO cirrus_access (id, role, user, policy, sort)
VALUES ('01a1857c-54dc-7547-b07c-4c96f7ebb685', '01a1857c-54d5-7148-8495-9e81c8a7caa5', NULL, '01a1857c-54dc-7546-ac55-49cd6ccdcab3', 1);
