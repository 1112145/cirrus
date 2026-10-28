-- Cirrus system tables (spec §6). Prefix cirrus_ dành riêng cho hệ thống.

CREATE TABLE cirrus_collections (
  collection   TEXT PRIMARY KEY,
  label        TEXT,
  icon         TEXT,
  note         TEXT,
  hidden       INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  singleton    INTEGER NOT NULL DEFAULT 0 CHECK (singleton IN (0, 1)),
  sort_field   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (collection NOT LIKE 'cirrus\_%' ESCAPE '\')
);

CREATE TABLE cirrus_fields (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  collection   TEXT NOT NULL REFERENCES cirrus_collections(collection) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  type         TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  nullable     INTEGER NOT NULL DEFAULT 1 CHECK (nullable IN (0, 1)),
  is_unique    INTEGER NOT NULL DEFAULT 0 CHECK (is_unique IN (0, 1)),
  default_val  TEXT CHECK (default_val IS NULL OR json_valid(default_val)),
  interface    TEXT,
  options      TEXT CHECK (options IS NULL OR json_valid(options)),
  validation   TEXT CHECK (validation IS NULL OR json_valid(validation)),
  sort         INTEGER,
  UNIQUE (collection, field)
);

CREATE TABLE cirrus_relations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  many_collection  TEXT NOT NULL,
  many_field       TEXT NOT NULL,
  one_collection   TEXT NOT NULL,
  one_field        TEXT,
  junction_field   TEXT,
  on_delete        TEXT NOT NULL DEFAULT 'SET NULL'
                   CHECK (on_delete IN ('SET NULL', 'CASCADE', 'RESTRICT', 'NO ACTION', 'SET DEFAULT')),
  UNIQUE (many_collection, many_field)
);

-- Access control theo mô hình Directus 11: role → access → policy → permission
CREATE TABLE cirrus_roles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  icon         TEXT,
  description  TEXT,
  parent       TEXT REFERENCES cirrus_roles(id) ON DELETE SET NULL
);

CREATE TABLE cirrus_policies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  icon         TEXT,
  description  TEXT,
  ip_access    TEXT CHECK (ip_access IS NULL OR json_valid(ip_access)),
  enforce_tfa  INTEGER NOT NULL DEFAULT 0 CHECK (enforce_tfa IN (0, 1)),
  admin_access INTEGER NOT NULL DEFAULT 0 CHECK (admin_access IN (0, 1)),
  app_access   INTEGER NOT NULL DEFAULT 0 CHECK (app_access IN (0, 1))
);

CREATE TABLE cirrus_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role          TEXT REFERENCES cirrus_roles(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('draft', 'invited', 'unverified', 'active', 'suspended', 'archived')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Gắn policy vào role HOẶC user; cả hai NULL = public policy
CREATE TABLE cirrus_access (
  id      TEXT PRIMARY KEY,
  role    TEXT REFERENCES cirrus_roles(id) ON DELETE CASCADE,
  user    TEXT REFERENCES cirrus_users(id) ON DELETE CASCADE,
  policy  TEXT NOT NULL REFERENCES cirrus_policies(id) ON DELETE CASCADE,
  sort    INTEGER,
  CHECK (role IS NULL OR user IS NULL)
);

CREATE INDEX cirrus_access_role_idx   ON cirrus_access(role);
CREATE INDEX cirrus_access_user_idx   ON cirrus_access(user);
CREATE INDEX cirrus_access_policy_idx ON cirrus_access(policy);

CREATE TABLE cirrus_permissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  policy       TEXT NOT NULL REFERENCES cirrus_policies(id) ON DELETE CASCADE,
  collection   TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('create', 'read', 'update', 'delete', 'share')),
  fields       TEXT CHECK (fields IS NULL OR json_valid(fields)),
  permissions  TEXT CHECK (permissions IS NULL OR json_valid(permissions)),
  validation   TEXT CHECK (validation IS NULL OR json_valid(validation)),
  presets      TEXT CHECK (presets IS NULL OR json_valid(presets))
);

CREATE INDEX cirrus_permissions_lookup_idx ON cirrus_permissions(collection, action, policy);

CREATE TABLE cirrus_files (
  id            TEXT PRIMARY KEY,
  storage_key   TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  mime_type     TEXT,
  filesize      INTEGER,
  width         INTEGER,
  height        INTEGER,
  uploaded_by   TEXT REFERENCES cirrus_users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE cirrus_settings (
  key   TEXT PRIMARY KEY,
  value TEXT CHECK (value IS NULL OR json_valid(value))
);

INSERT INTO cirrus_settings (key, value) VALUES ('schema_version', '1');
