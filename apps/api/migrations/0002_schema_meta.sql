-- M1: store the full Directus 11 collection/field meta, so /collections and /fields round-trip
-- what @directus/sdk sends. Storage stays flat; the API maps it to the meta/schema shape (spec §17.2).

-- Collections ------------------------------------------------------------------------------

-- Directus "folder" collections (schema: null) have no table and no fields.
ALTER TABLE cirrus_collections ADD COLUMN folder INTEGER NOT NULL DEFAULT 0 CHECK (folder IN (0, 1));
ALTER TABLE cirrus_collections ADD COLUMN display_template TEXT;
ALTER TABLE cirrus_collections ADD COLUMN color TEXT;
ALTER TABLE cirrus_collections ADD COLUMN sort INTEGER;
-- meta.group: the collection this one is grouped under
ALTER TABLE cirrus_collections ADD COLUMN parent TEXT REFERENCES cirrus_collections(collection) ON DELETE SET NULL;
ALTER TABLE cirrus_collections ADD COLUMN collapse TEXT NOT NULL DEFAULT 'open' CHECK (collapse IN ('open', 'closed', 'locked'));
ALTER TABLE cirrus_collections ADD COLUMN accountability TEXT DEFAULT 'all' CHECK (accountability IS NULL OR accountability IN ('all', 'activity'));
ALTER TABLE cirrus_collections ADD COLUMN archive_field TEXT;
ALTER TABLE cirrus_collections ADD COLUMN archive_app_filter INTEGER NOT NULL DEFAULT 1 CHECK (archive_app_filter IN (0, 1));
ALTER TABLE cirrus_collections ADD COLUMN archive_value TEXT;
ALTER TABLE cirrus_collections ADD COLUMN unarchive_value TEXT;
ALTER TABLE cirrus_collections ADD COLUMN preview_url TEXT;
ALTER TABLE cirrus_collections ADD COLUMN translations TEXT CHECK (translations IS NULL OR json_valid(translations));
ALTER TABLE cirrus_collections ADD COLUMN item_duplication_fields TEXT CHECK (item_duplication_fields IS NULL OR json_valid(item_duplication_fields));
ALTER TABLE cirrus_collections ADD COLUMN versioning INTEGER NOT NULL DEFAULT 0 CHECK (versioning IN (0, 1));

-- Fields: admin meta -----------------------------------------------------------------------

ALTER TABLE cirrus_fields ADD COLUMN special TEXT CHECK (special IS NULL OR json_valid(special));
ALTER TABLE cirrus_fields ADD COLUMN display TEXT;
ALTER TABLE cirrus_fields ADD COLUMN display_options TEXT CHECK (display_options IS NULL OR json_valid(display_options));
ALTER TABLE cirrus_fields ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0 CHECK (readonly IN (0, 1));
ALTER TABLE cirrus_fields ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
ALTER TABLE cirrus_fields ADD COLUMN width TEXT DEFAULT 'full';
ALTER TABLE cirrus_fields ADD COLUMN translations TEXT CHECK (translations IS NULL OR json_valid(translations));
ALTER TABLE cirrus_fields ADD COLUMN note TEXT;
ALTER TABLE cirrus_fields ADD COLUMN conditions TEXT CHECK (conditions IS NULL OR json_valid(conditions));
ALTER TABLE cirrus_fields ADD COLUMN required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1));
ALTER TABLE cirrus_fields ADD COLUMN searchable INTEGER NOT NULL DEFAULT 1 CHECK (searchable IN (0, 1));
-- meta.group: the group (alias) field this field sits in
ALTER TABLE cirrus_fields ADD COLUMN parent TEXT;
ALTER TABLE cirrus_fields ADD COLUMN validation_message TEXT;

-- Fields: column properties (Directus `schema`), alongside is_primary/nullable/is_unique/default_val

ALTER TABLE cirrus_fields ADD COLUMN auto_increment INTEGER NOT NULL DEFAULT 0 CHECK (auto_increment IN (0, 1));
ALTER TABLE cirrus_fields ADD COLUMN is_indexed INTEGER NOT NULL DEFAULT 0 CHECK (is_indexed IN (0, 1));
ALTER TABLE cirrus_fields ADD COLUMN max_length INTEGER;
ALTER TABLE cirrus_fields ADD COLUMN numeric_precision INTEGER;
ALTER TABLE cirrus_fields ADD COLUMN numeric_scale INTEGER;
