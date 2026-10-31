import {
  assertCollectionName,
  assertFieldName,
  type ColumnDef,
  type FieldType,
  isFieldType,
  normalizeDefault,
  TYPE_INFO,
} from '@cirrus/schema';
import { invalidPayload } from '@cirrus/shared';
import {
  COLLECTION_META,
  COLUMN_INPUT,
  type CollectionMeta,
  FIELD_META,
  type FieldMeta,
  isPlainObject,
  type MetaOf,
  metaDefaults,
  parseMeta,
} from './meta.ts';
import { anyCollection, type CollectionRecord, type FieldRecord, m2oOf, type NewField, type Schema } from './store.ts';

/**
 * Mapping between Directus payloads ({ collection, meta, schema } / { field, type, meta, schema })
 * and the internal model (spec §17.2).
 */

// Input --------------------------------------------------------------------------------------

export type ColumnInput = Partial<MetaOf<typeof COLUMN_INPUT>> & { default_value?: unknown };

export type FieldPayload = {
  field?: string;
  type?: FieldType;
  meta: Partial<FieldMeta>;
  /** null when the payload has no `schema` object. */
  schema: ColumnInput | null;
};

export function parseFieldPayload(body: unknown, path = 'field'): FieldPayload {
  if (!isPlainObject(body)) throw invalidPayload(`"${path}" must be an object`);
  if (body.field !== undefined) assertFieldName(body.field);
  if (body.type !== undefined && !isFieldType(body.type)) {
    throw invalidPayload(`"type" must be one of ${Object.keys(TYPE_INFO).join(', ')}`);
  }
  if (body.schema !== undefined && body.schema !== null && !isPlainObject(body.schema)) {
    throw invalidPayload('"schema" must be an object or null');
  }
  const schema: ColumnInput | null = isPlainObject(body.schema)
    ? { ...parseMeta(COLUMN_INPUT, body.schema, 'schema'), default_value: body.schema.default_value }
    : null;
  return {
    field: body.field as string | undefined,
    type: body.type as FieldType | undefined,
    meta: parseMeta(FIELD_META, body.meta, 'meta'),
    schema,
  };
}

export type CollectionPayload = {
  collection: string;
  folder: boolean;
  meta: Partial<CollectionMeta>;
  fields: FieldPayload[];
};

export function parseCollectionPayload(body: unknown): CollectionPayload {
  if (!isPlainObject(body)) throw invalidPayload('A collection must be an object');
  if (body.collection === undefined) throw invalidPayload('"collection" is required');
  assertCollectionName(body.collection);

  // As in Directus, a collection without `schema` is a folder: metadata only, no table.
  if (body.schema !== undefined && body.schema !== null && !isPlainObject(body.schema)) {
    throw invalidPayload('"schema" must be an object or null');
  }
  const folder = !isPlainObject(body.schema);

  if (body.fields !== undefined && body.fields !== null && !Array.isArray(body.fields)) {
    throw invalidPayload('"fields" must be an array');
  }
  const fields = ((body.fields as unknown[] | null | undefined) ?? []).map((f, i) => parseFieldPayload(f, `fields[${i}]`));
  if (folder && fields.length) throw invalidPayload("A collection without schema is a folder and can't have fields");

  return { collection: body.collection, folder, meta: parseMeta(COLLECTION_META, body.meta, 'meta'), fields };
}

export const parseCollectionMeta = (body: unknown) => {
  if (!isPlainObject(body)) throw invalidPayload('A collection must be an object');
  return parseMeta(COLLECTION_META, body.meta, 'meta');
};

/**
 * Column properties from a `schema` object, on top of `base` (the field's current column when
 * updating). Size properties only carry over while the type stays the same.
 */
export function buildColumn(
  type: FieldType,
  input: ColumnInput | null,
  base: { type: FieldType; column: ColumnDef } | null = null,
): ColumnDef {
  const s = input ?? {};
  const prev = base?.column;
  const sameType = base?.type === type;
  const info = TYPE_INFO[type];

  const primaryKey = s.is_primary_key ?? prev?.primaryKey ?? false;
  if (primaryKey && !info.primaryKey) throw invalidPayload(`A field of type "${type}" can't be the primary key`);
  if (s.has_auto_increment && !(primaryKey && info.sql === 'INTEGER')) {
    throw invalidPayload('Only integer primary keys can auto-increment');
  }

  const defaultValue = normalizeDefault(type, s.default_value !== undefined ? s.default_value : (prev?.defaultValue ?? null));
  if (primaryKey && defaultValue !== null) throw invalidPayload("The primary key can't have a default value");

  const size = (key: 'maxLength' | 'numericPrecision' | 'numericScale', value: number | null | undefined, fallback: number | null) =>
    value !== undefined ? value : sameType && prev ? prev[key] : fallback;

  return {
    primaryKey,
    autoIncrement: primaryKey && info.sql === 'INTEGER' && (s.has_auto_increment ?? prev?.autoIncrement ?? false),
    nullable: !primaryKey && (s.is_nullable ?? prev?.nullable ?? true),
    unique: !primaryKey && (s.is_unique ?? prev?.unique ?? false),
    indexed: !primaryKey && (s.is_indexed ?? prev?.indexed ?? false),
    defaultValue,
    // Directus strings default to varchar(255)
    maxLength: size('maxLength', s.max_length, type === 'string' ? 255 : null),
    numericPrecision: size('numericPrecision', s.numeric_precision, null),
    numericScale: size('numericScale', s.numeric_scale, null),
  };
}

/** A new field from a validated payload; `field` and `type` must be present. */
export function newField(collection: string, p: FieldPayload): NewField {
  if (p.field === undefined) throw invalidPayload('"field" is required');
  if (p.type === undefined) throw invalidPayload('"type" is required');
  return {
    collection,
    field: p.field,
    type: p.type,
    column: p.type === 'alias' ? null : buildColumn(p.type, p.schema),
    meta: { ...metaDefaults(FIELD_META), ...p.meta },
  };
}

/** ADR-007: collections get a UUIDv7 primary key unless the payload defines one. */
export const DEFAULT_PRIMARY_KEY: FieldPayload = {
  field: 'id',
  type: 'uuid',
  meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] },
  schema: { is_primary_key: true },
};

// Output -------------------------------------------------------------------------------------

export const toDirectusCollection = (c: CollectionRecord) => ({
  collection: c.collection,
  meta: { collection: c.collection, ...c.meta },
  schema: c.folder ? null : { name: c.collection, comment: null },
});

/** `foreignKey`: the related table and key an M2O field references, when Cirrus enforces it (spec §9). */
export function toDirectusField(f: FieldRecord, foreignKey: { table: string; column: string } | null = null) {
  const col = f.column;
  return {
    collection: f.collection,
    field: f.field,
    type: f.type,
    meta: { id: f.id, collection: f.collection, field: f.field, ...f.meta },
    schema: col && {
      name: f.field,
      table: f.collection,
      data_type: TYPE_INFO[f.type].sql!.toLowerCase(),
      default_value: col.defaultValue,
      max_length: col.maxLength,
      numeric_precision: col.numericPrecision,
      numeric_scale: col.numericScale,
      is_generated: false,
      generation_expression: null,
      is_nullable: col.nullable,
      is_unique: col.unique || col.primaryKey,
      is_indexed: col.indexed,
      is_primary_key: col.primaryKey,
      has_auto_increment: col.autoIncrement,
      foreign_key_column: foreignKey?.column ?? null,
      foreign_key_table: foreignKey?.table ?? null,
      comment: null,
    },
  };
}

/** A field in the Directus shape, with the foreign key of its relation, if Cirrus enforces one. */
export function directusField(schema: Schema, f: FieldRecord) {
  const r = m2oOf(schema, f.collection, f.field);
  const pk = r && r.onDelete !== null ? anyCollection(schema, r.related)?.fields.find((x) => x.column?.primaryKey) : null;
  return toDirectusField(f, pk ? { table: r!.related, column: pk.field } : null);
}
