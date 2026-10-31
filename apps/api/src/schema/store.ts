import type { ColumnDef, FieldDef, FieldType, TableDef } from '@cirrus/schema';
import { forbidden, uuidv7 } from '@cirrus/shared';
import { ACCESS_SQL, type AccessSnapshot, accessFromRows } from '../access/snapshot.ts';
import { SYSTEM_COLLECTIONS, SYSTEM_RELATIONS } from '../system/collections.ts';
import {
  COLLECTION_META,
  COLUMN_INPUT,
  type CollectionMeta,
  FIELD_META,
  type FieldMeta,
  metaFromRow,
  type MetaOf,
  metaToColumns,
} from './meta.ts';

export type FieldRecord = FieldDef & {
  id: number;
  collection: string;
  meta: FieldMeta;
};

export type NewField = Omit<FieldRecord, 'id'>;

/** What deleting an item does to the items that reference it (the relation's `schema.on_delete`). */
export const ON_DELETE = ['SET NULL', 'CASCADE', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'] as const;
export type OnDelete = (typeof ON_DELETE)[number];

/**
 * A relation (spec §9), as Directus stores it: `collection.field` holds a key of an item of
 * `related` (the M2O); `oneField` is the alias on `related` listing the items that point at it
 * (the O2M). M2M is a junction collection with two relations, each naming the other's field as
 * `junctionField`.
 */
export type RelationRecord = {
  id: number;
  /** Directus many_collection / many_field. */
  collection: string;
  field: string;
  /** Directus one_collection (related_collection). */
  related: string;
  oneField: string | null;
  junctionField: string | null;
  /** Default order of the O2M. */
  sortField: string | null;
  /** What a nested O2M write does with the items it no longer lists (one_deselect_action). */
  deselect: 'nullify' | 'delete';
  /**
   * The Directus relation schema: null for a relation created with `schema: null`, which nothing
   * enforces; otherwise keys must reference items and deleting one does this (ADR-021).
   */
  onDelete: OnDelete | null;
  /** Between system collections, enforced by their tables' own foreign keys (not by the items service). */
  system?: boolean;
};

export type CollectionRecord = {
  collection: string;
  /** Directus folder (schema: null): no table, no fields. */
  folder: boolean;
  meta: CollectionMeta;
  fields: FieldRecord[];
};

/** All schema metadata, loaded at once (spec §4). */
export type Schema = {
  /** Raw cirrus_settings.schema_version; replaced with a new UUIDv7 on every schema or access change. */
  version: string;
  /** User collections; system collections (directus_users, …) are defined in code (system/collections.ts). */
  collections: Map<string, CollectionRecord>;
  /** Relations of user collections; system relations are defined in code (SYSTEM_RELATIONS). */
  relations: RelationRecord[];
  access: AccessSnapshot;
};

type Row = Record<string, unknown>;

const VERSION_SQL = "SELECT value FROM cirrus_settings WHERE key = 'schema_version'";

/**
 * The snapshot is cached in isolate memory and revalidated against schema_version in D1 on each call:
 * one tiny, strongly consistent query. A cold isolate loads everything in a single batch.
 */
let cached: Schema | null = null;

export async function getSchema(db: D1Database): Promise<Schema> {
  if (cached) {
    const row = await db.prepare(VERSION_SQL).first<{ value: string }>();
    if (row?.value === cached.version) return cached;
  }
  cached = await loadSchema(db);
  return cached;
}

/** Replace schema_version so every isolate reloads the snapshot; for writes to roles, policies, access and permissions. */
export const bumpSchemaVersion = (db: D1Database) =>
  db.prepare("UPDATE cirrus_settings SET value = ?1 WHERE key = 'schema_version'").bind(JSON.stringify(uuidv7()));

/** Drop the cached snapshot after a schema change, so the next read is a single batch. */
export const invalidateSchema = () => {
  cached = null;
};

export const readSchemaVersion = async (db: D1Database) =>
  (await db.prepare(VERSION_SQL).first<{ value: string }>())?.value ?? null;

async function loadSchema(db: D1Database): Promise<Schema> {
  const [version, collections, fields, relations, ...access] = await db.batch<Row>([
    db.prepare(VERSION_SQL),
    db.prepare('SELECT * FROM cirrus_collections ORDER BY collection'),
    db.prepare('SELECT * FROM cirrus_fields ORDER BY collection, sort IS NULL, sort, id'),
    db.prepare('SELECT * FROM cirrus_relations ORDER BY id'),
    ...ACCESS_SQL.map((sql) => db.prepare(sql)),
  ]);

  const map = new Map<string, CollectionRecord>();
  for (const row of collections!.results) {
    const name = row.collection as string;
    map.set(name, { collection: name, folder: row.folder === 1, meta: metaFromRow(COLLECTION_META, row), fields: [] });
  }
  for (const row of fields!.results) map.get(row.collection as string)?.fields.push(fieldFromRow(row));

  const [roles, policies, accessRows, permissions] = access.map((r) => r.results);
  return {
    version: version!.results[0]!.value as string,
    collections: map,
    relations: relations!.results.map(relationFromRow),
    access: accessFromRows(roles!, policies!, accessRows!, permissions!),
  };
}

const relationFromRow = (row: Row): RelationRecord => ({
  id: row.id as number,
  collection: row.many_collection as string,
  field: row.many_field as string,
  related: row.one_collection as string,
  oneField: row.one_field as string | null,
  junctionField: row.junction_field as string | null,
  sortField: row.sort_field as string | null,
  deselect: row.one_deselect_action === 'delete' ? 'delete' : 'nullify',
  onDelete: row.on_delete as OnDelete | null,
});

function fieldFromRow(row: Row): FieldRecord {
  const type = row.type as FieldType;
  const c = metaFromRow(COLUMN_INPUT, row);
  const column: ColumnDef | null =
    type === 'alias'
      ? null
      : {
          primaryKey: c.is_primary_key,
          autoIncrement: c.has_auto_increment,
          nullable: c.is_nullable,
          unique: c.is_unique,
          indexed: c.is_indexed,
          defaultValue: row.default_val === null ? null : JSON.parse(row.default_val as string),
          maxLength: c.max_length,
          numericPrecision: c.numeric_precision,
          numericScale: c.numeric_scale,
        };
  return {
    id: row.id as number,
    collection: row.collection as string,
    field: row.field as string,
    type,
    column,
    meta: metaFromRow(FIELD_META, row),
  };
}

// Lookups ------------------------------------------------------------------------------------

/** Directus answers FORBIDDEN for collections and fields that don't exist. */
export function getCollection(schema: Schema, name: string): CollectionRecord {
  const c = schema.collections.get(name);
  if (!c) throw forbidden();
  return c;
}

export function getField(collection: CollectionRecord, name: string): FieldRecord {
  const f = collection.fields.find((x) => x.field === name);
  if (!f) throw forbidden();
  return f;
}

export const tableOf = (collection: CollectionRecord, fields: readonly FieldDef[] = collection.fields): TableDef => ({
  name: collection.collection,
  fields,
});

/** A user or system collection; null when there is none by that name. */
export const anyCollection = (schema: Schema, name: string): CollectionRecord | null =>
  schema.collections.get(name) ?? SYSTEM_COLLECTIONS.get(name) ?? null;

// Relations ----------------------------------------------------------------------------------

export const allRelations = (schema: Schema): readonly RelationRecord[] => [...SYSTEM_RELATIONS, ...schema.relations];

/** The relation a field holds the key of (its M2O), if any. */
export const m2oOf = (schema: Schema, collection: string, field: string) =>
  allRelations(schema).find((r) => r.collection === collection && r.field === field) ?? null;

/** The relation an alias field lists the items of (its O2M), if any. */
export const o2mOf = (schema: Schema, collection: string, field: string) =>
  allRelations(schema).find((r) => r.related === collection && r.oneField === field) ?? null;

/** Relations whose items point at items of `collection`. */
export const relationsTo = (schema: Schema, collection: string) => allRelations(schema).filter((r) => r.related === collection);

// Metadata writes (bound into the same D1 batch as the DDL) --------------------------------

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function insertCollection(db: D1Database, c: Omit<CollectionRecord, 'fields'>): D1PreparedStatement {
  const cols = metaToColumns(COLLECTION_META, c.meta);
  const names = ['collection', 'folder', ...cols.map(([name]) => name)];
  return db
    .prepare(`INSERT INTO cirrus_collections (${names.join(', ')}) VALUES (${placeholders(names.length)})`)
    .bind(c.collection, c.folder ? 1 : 0, ...cols.map(([, v]) => v));
}

export function updateCollection(db: D1Database, name: string, meta: CollectionMeta): D1PreparedStatement {
  const cols = metaToColumns(COLLECTION_META, meta);
  return db
    .prepare(`UPDATE cirrus_collections SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE collection = ?`)
    .bind(...cols.map(([, v]) => v), name);
}

export function fieldColumns(f: NewField) {
  const col = f.column;
  const props: MetaOf<typeof COLUMN_INPUT> = {
    is_primary_key: col?.primaryKey ?? false,
    has_auto_increment: col?.autoIncrement ?? false,
    is_nullable: col?.nullable ?? true,
    is_unique: col?.unique ?? false,
    is_indexed: col?.indexed ?? false,
    max_length: col?.maxLength ?? null,
    numeric_precision: col?.numericPrecision ?? null,
    numeric_scale: col?.numericScale ?? null,
  };
  return [
    ['type', f.type] as const,
    ['default_val', col?.defaultValue == null ? null : JSON.stringify(col.defaultValue)] as const,
    ...metaToColumns(COLUMN_INPUT, props),
    ...metaToColumns(FIELD_META, f.meta),
  ];
}

export function insertField(db: D1Database, f: NewField): D1PreparedStatement {
  const cols = fieldColumns(f);
  const names = ['collection', 'field', ...cols.map(([name]) => name)];
  return db
    .prepare(`INSERT INTO cirrus_fields (${names.join(', ')}) VALUES (${placeholders(names.length)})`)
    .bind(f.collection, f.field, ...cols.map(([, v]) => v));
}

export function updateField(db: D1Database, f: FieldRecord): D1PreparedStatement {
  const cols = fieldColumns(f);
  return db
    .prepare(`UPDATE cirrus_fields SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .bind(...cols.map(([, v]) => v), f.id);
}
