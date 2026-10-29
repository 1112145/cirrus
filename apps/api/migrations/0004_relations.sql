-- M4: relations (spec §9). Relations are kept by the items service, not by SQLite foreign keys
-- (ADR-021): D1 can't turn foreign keys off, so rebuilding a referenced table would fire their
-- ON DELETE actions on every row. Writes check the keys they set with guard statements, and
-- deletes apply on_delete themselves, in the same batch.

-- Relations ----------------------------------------------------------------------------------

-- Rebuilt to add the Directus meta Cirrus supports and to make on_delete nullable: NULL is a
-- relation created with `schema: null` (no foreign key, nothing enforced), as in Directus.
CREATE TABLE cirrus_relations_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The M2O: many_collection.many_field holds a key of one_collection.
  many_collection     TEXT NOT NULL,
  many_field          TEXT NOT NULL,
  one_collection      TEXT NOT NULL,
  -- The O2M alias on one_collection listing the items that point at it.
  one_field           TEXT,
  -- M2M: the junction's other M2O field.
  junction_field      TEXT,
  -- Default order of the O2M.
  sort_field          TEXT,
  -- What a nested O2M write does with items it no longer lists.
  one_deselect_action TEXT NOT NULL DEFAULT 'nullify' CHECK (one_deselect_action IN ('nullify', 'delete')),
  on_delete           TEXT DEFAULT 'NO ACTION'
                      CHECK (on_delete IS NULL OR on_delete IN ('SET NULL', 'CASCADE', 'RESTRICT', 'NO ACTION', 'SET DEFAULT')),
  UNIQUE (many_collection, many_field)
);

INSERT INTO cirrus_relations_new (id, many_collection, many_field, one_collection, one_field, junction_field, on_delete)
SELECT id, many_collection, many_field, one_collection, one_field, junction_field, on_delete FROM cirrus_relations;

DROP TABLE cirrus_relations;
ALTER TABLE cirrus_relations_new RENAME TO cirrus_relations;

-- An alias field lists the items of one relation only.
CREATE UNIQUE INDEX cirrus_relations_one_field_idx ON cirrus_relations (one_collection, one_field) WHERE one_field IS NOT NULL;
CREATE INDEX cirrus_relations_one_collection_idx ON cirrus_relations (one_collection);

-- Guards -------------------------------------------------------------------------------------

-- A second guard kind: `INSERT INTO cirrus_guard (fk) SELECT 0 WHERE <violation>` fails with
-- "CHECK constraint failed: cirrus_foreign_key" (INVALID_FOREIGN_KEY) rather than cirrus_guard (FORBIDDEN).
ALTER TABLE cirrus_guard ADD COLUMN fk INTEGER CONSTRAINT cirrus_foreign_key CHECK (fk = 1);

-- Batch keys -----------------------------------------------------------------------------------

-- Scratch space for one batch: the keys of rows a delete removes (so its on_delete actions and the
-- delete itself see the same rows), and the keys of items a nested write creates with an
-- auto-increment key. A batch that uses it empties it as its last statement, so it never holds rows
-- outside a transaction.
CREATE TABLE cirrus_batch_keys (
  slot  INTEGER NOT NULL,
  value NOT NULL,
  PRIMARY KEY (slot, value)
) WITHOUT ROWID;
