-- M5: files on R2 (spec §11). directus_files and directus_folders over cirrus_files and
-- cirrus_folders, with Directus 11's columns. The objects themselves live in the R2 bucket, under
-- filename_disk.

-- Folders ----------------------------------------------------------------------------------------

CREATE TABLE cirrus_folders (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  -- As in Directus, a folder with subfolders can't be deleted (no ON DELETE action).
  parent  TEXT REFERENCES cirrus_folders(id)
);

CREATE INDEX cirrus_folders_parent_idx ON cirrus_folders(parent);

-- Files ------------------------------------------------------------------------------------------

-- The M0 placeholder never held rows (nothing wrote it before M5) and nothing references it.
DROP TABLE cirrus_files;

CREATE TABLE cirrus_files (
  id                TEXT PRIMARY KEY,
  -- The storage location; Cirrus has one, the R2 bucket bound as STORAGE.
  storage           TEXT NOT NULL,
  -- The object's key in the bucket; set by Cirrus, never by requests. NULL for a record without
  -- an upload (POST /files with JSON).
  filename_disk     TEXT UNIQUE,
  filename_download TEXT NOT NULL,
  title             TEXT,
  type              TEXT,
  folder            TEXT REFERENCES cirrus_folders(id) ON DELETE SET NULL,
  uploaded_by       TEXT REFERENCES cirrus_users(id) ON DELETE SET NULL,
  created_on        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  modified_by       TEXT REFERENCES cirrus_users(id) ON DELETE SET NULL,
  modified_on       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  charset           TEXT,
  filesize          INTEGER,
  width             INTEGER,
  height            INTEGER,
  duration          INTEGER,
  embed             TEXT,
  description       TEXT,
  location          TEXT,
  tags              TEXT CHECK (tags IS NULL OR json_valid(tags)),
  metadata          TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  focal_point_x     INTEGER,
  focal_point_y     INTEGER,
  -- When the current contents were uploaded (Directus 11: created_on is when the record was).
  uploaded_on       TEXT
);

CREATE INDEX cirrus_files_folder_idx ON cirrus_files(folder);
CREATE INDEX cirrus_files_uploaded_by_idx ON cirrus_files(uploaded_by);
CREATE INDEX cirrus_files_modified_by_idx ON cirrus_files(modified_by);

-- directus_users.avatar holds a file key. cirrus_users can't get a foreign key without a rebuild,
-- which would fire the cascades of the tables referencing it (ADR-021), so the items service keeps
-- this relation, like user relations: avatars must be files, and deleting a file clears them.
