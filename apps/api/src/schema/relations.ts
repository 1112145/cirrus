import { GUARD_TABLE } from '@cirrus/query';
import { type FieldType, quoteIdent } from '@cirrus/schema';
import { forbidden, invalidPayload, isPlainObject } from '@cirrus/shared';
import { RELATED_SYSTEM_COLLECTIONS, SYSTEM_COLLECTIONS } from '../system/collections.ts';
import { commit } from './commit.ts';
import {
  anyCollection,
  type CollectionRecord,
  type FieldRecord,
  getSchema,
  m2oOf,
  o2mOf,
  ON_DELETE,
  type OnDelete,
  type RelationRecord,
  type Schema,
} from './store.ts';

/**
 * Relations (spec §9): the Directus relation payloads, and the changes to them. A relation is
 * metadata over an existing column; Cirrus keeps it in the items service rather than with a
 * SQLite foreign key (ADR-021), so creating or dropping one never rebuilds a table. Admin-only;
 * routes check that first.
 */

type Input = {
  collection?: string | undefined;
  field?: string | undefined;
  /** undefined: not given. */
  related?: string | null | undefined;
  oneField?: string | null | undefined;
  junctionField?: string | null | undefined;
  sortField?: string | null | undefined;
  deselect?: RelationRecord['deselect'] | undefined;
  /** undefined: not given; null: `schema: null` (nothing enforced). */
  schema?: { onDelete: OnDelete | undefined } | null | undefined;
};

function text(v: unknown, path: string): string | null | undefined {
  if (v !== undefined && v !== null && typeof v !== 'string') throw invalidPayload(`"${path}" must be a string or null`);
  return v;
}

export function parseRelation(body: unknown): Input {
  if (!isPlainObject(body)) throw invalidPayload('A relation must be an object');
  const meta = body.meta ?? {};
  if (!isPlainObject(meta)) throw invalidPayload('"meta" must be an object or null');
  if (meta.one_collection_field != null || meta.one_allowed_collections != null) {
    throw invalidPayload("Many-to-any relations aren't supported yet");
  }
  const deselect = meta.one_deselect_action;
  if (deselect !== undefined && deselect !== 'nullify' && deselect !== 'delete') {
    throw invalidPayload('"meta.one_deselect_action" must be "nullify" or "delete"');
  }

  let schema: Input['schema'];
  if (body.schema === null) schema = null;
  else if (body.schema !== undefined) {
    if (!isPlainObject(body.schema)) throw invalidPayload('"schema" must be an object or null');
    const raw = body.schema.on_delete;
    const onDelete = typeof raw === 'string' ? ON_DELETE.find((a) => a === raw.toUpperCase()) : undefined;
    if (raw !== undefined && raw !== null && !onDelete) throw invalidPayload(`"schema.on_delete" must be one of ${ON_DELETE.join(', ')}`);
    schema = { onDelete };
  }

  return {
    collection: text(body.collection, 'collection') ?? undefined,
    field: text(body.field, 'field') ?? undefined,
    related: text(body.related_collection, 'related_collection'),
    oneField: text(meta.one_field, 'meta.one_field'),
    junctionField: text(meta.junction_field, 'meta.junction_field'),
    sortField: text(meta.sort_field, 'meta.sort_field'),
    deselect: deselect as Input['deselect'],
    schema,
  };
}

/** Collections a relation may point at: user collections with items, and the system ones whose deletes apply on_delete. */
export function relatedCollection(schema: Schema, name: string): CollectionRecord {
  const c = schema.collections.get(name) ?? (RELATED_SYSTEM_COLLECTIONS.includes(name) ? SYSTEM_COLLECTIONS.get(name) : undefined);
  if (!c || c.folder) throw invalidPayload(`Collection "${name}" doesn't exist`);
  return c;
}

const primaryOf = (c: CollectionRecord) => c.fields.find((f) => f.column?.primaryKey)!;

const isInteger = (t: FieldType) => t === 'integer' || t === 'bigInteger';

/** Keys are compared as stored: the field must store them like the related primary key. */
export const keyTypesMatch = (fk: FieldType, pk: FieldType) => fk === pk || (isInteger(fk) && isInteger(pk));

export function assertKeyType(f: FieldRecord, type: FieldType, related: CollectionRecord) {
  const pk = primaryOf(related);
  if (!keyTypesMatch(type, pk.type)) {
    throw invalidPayload(`Field "${f.field}" of type "${type}" can't hold keys of collection "${related.collection}", which are of type "${pk.type}"`);
  }
}

/** The fields a relation names must exist, and an O2M alias can list the items of one relation only. */
export function assertMeta(schema: Schema, r: RelationRecord) {
  const many = schema.collections.get(r.collection)!;
  const column = (name: string, what: string) => {
    const f = many.fields.find((x) => x.field === name);
    if (!f?.column) throw invalidPayload(`Field "${name}" used as ${what} doesn't exist in collection "${r.collection}"`);
  };
  if (r.junctionField !== null) {
    column(r.junctionField, '"junction_field"');
    if (r.junctionField === r.field) throw invalidPayload('"junction_field" must be another field of the junction collection');
  }
  if (r.sortField !== null) column(r.sortField, '"sort_field"');
  if (r.oneField !== null) {
    const one = schema.collections.get(r.related);
    const alias = one?.fields.find((f) => f.field === r.oneField);
    if (!one || !alias || alias.column) {
      throw invalidPayload(`Field "${r.oneField}" used as "one_field" has to be an alias field of collection "${r.related}"`);
    }
    const other = o2mOf(schema, r.related, r.oneField);
    if (other && other.id !== r.id) {
      throw invalidPayload(`Field "${r.oneField}" in collection "${r.related}" already has an associated relationship`);
    }
  }
}

/**
 * Fails the batch (INVALID_FOREIGN_KEY) when existing values of the field reference no item: what
 * adding a foreign key to a column with data would do.
 */
export function danglingGuard(db: D1Database, r: RelationRecord, schema: Schema): D1PreparedStatement {
  const related = anyCollection(schema, r.related)!;
  const table = SYSTEM_COLLECTIONS.get(r.related)?.table ?? r.related;
  const fk = quoteIdent(r.field);
  return db.prepare(
    `INSERT INTO ${quoteIdent(GUARD_TABLE)} ("fk") SELECT 0 WHERE EXISTS (SELECT 1 FROM ${quoteIdent(r.collection)} ` +
      `WHERE ${fk} IS NOT NULL AND ${fk} NOT IN (SELECT ${quoteIdent(primaryOf(related).field)} FROM ${quoteIdent(table)}))`,
  );
}

export const relationColumns = (r: RelationRecord) =>
  [
    ['many_collection', r.collection],
    ['many_field', r.field],
    ['one_collection', r.related],
    ['one_field', r.oneField],
    ['junction_field', r.junctionField],
    ['sort_field', r.sortField],
    ['one_deselect_action', r.deselect],
    ['on_delete', r.onDelete],
  ] as const;

// Changes --------------------------------------------------------------------------------------------

/** Directus RelationsService.createOne. Returns the relation's collection and field. */
export async function createRelation(db: D1Database, body: unknown): Promise<{ collection: string; field: string }> {
  const schema = await getSchema(db);
  const input = parseRelation(body);
  if (!input.collection) throw invalidPayload('"collection" is required');
  if (!input.field) throw invalidPayload('"field" is required');
  const many = schema.collections.get(input.collection);
  if (!many || many.folder) throw invalidPayload(`Collection "${input.collection}" doesn't exist`);
  const f = many.fields.find((x) => x.field === input.field);
  if (!f) throw invalidPayload(`Field "${input.field}" doesn't exist in collection "${input.collection}"`);
  if (f.column?.primaryKey) throw invalidPayload(`${input.collection}'s primary key can't be a foreign key`);
  if (!f.column) throw invalidPayload(`Field "${input.field}" in collection "${input.collection}" is an alias and can't hold keys`);
  if (!input.related) throw invalidPayload('"related_collection" is required: many-to-any relations aren\'t supported yet');
  const related = relatedCollection(schema, input.related);
  if (m2oOf(schema, input.collection, input.field)) {
    throw invalidPayload(`Field "${input.field}" in collection "${input.collection}" already has an associated relationship`);
  }
  assertKeyType(f, f.type, related);

  const r: RelationRecord = {
    id: 0,
    collection: input.collection,
    field: input.field,
    related: related.collection,
    oneField: input.oneField ?? null,
    junctionField: input.junctionField ?? null,
    sortField: input.sortField ?? null,
    deselect: input.deselect ?? 'nullify',
    // As in Directus, a relation without `schema: null` gets a foreign key, whose default is NO ACTION.
    onDelete: input.schema === null ? null : (input.schema?.onDelete ?? 'NO ACTION'),
  };
  assertMeta(schema, r);

  const cols = relationColumns(r);
  const statements = [
    db.prepare(`INSERT INTO cirrus_relations (${cols.map(([c]) => c).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map(([, v]) => v)),
  ];
  if (r.onDelete !== null) statements.unshift(danglingGuard(db, r, schema));
  await commit(db, schema, statements, { collection: r.collection, field: r.field });
  return { collection: r.collection, field: r.field };
}

/** Directus RelationsService.updateOne: the meta, and the schema (on_delete, or null to stop enforcing it). */
export async function updateRelation(db: D1Database, collection: string, field: string, body: unknown): Promise<void> {
  const schema = await getSchema(db);
  const existing = schema.relations.find((r) => r.collection === collection && r.field === field);
  if (!existing) throw forbidden();
  const input = parseRelation(body);
  if ((input.collection !== undefined && input.collection !== collection) || (input.field !== undefined && input.field !== field)) {
    throw invalidPayload("A relation's collection and field can't be changed");
  }
  if (input.related !== undefined && input.related !== existing.related) {
    throw invalidPayload("A relation's related collection can't be changed");
  }
  const pick = <T>(v: T | undefined, current: T) => (v === undefined ? current : v);
  const r: RelationRecord = {
    ...existing,
    oneField: pick(input.oneField, existing.oneField),
    junctionField: pick(input.junctionField, existing.junctionField),
    sortField: pick(input.sortField, existing.sortField),
    deselect: input.deselect ?? existing.deselect,
    onDelete: input.schema === undefined ? existing.onDelete : input.schema === null ? null : (input.schema.onDelete ?? existing.onDelete ?? 'NO ACTION'),
  };
  assertMeta(schema, r);

  const cols = relationColumns(r).slice(3);
  const statements = [db.prepare(`UPDATE cirrus_relations SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map(([, v]) => v), r.id)];
  if (r.onDelete !== null && existing.onDelete === null) statements.unshift(danglingGuard(db, r, schema));
  await commit(db, schema, statements, { collection: r.collection, field: r.field });
}

/** Directus RelationsService.deleteOne: the fields stay, they just aren't related any more. */
export async function deleteRelation(db: D1Database, collection: string, field: string): Promise<void> {
  const schema = await getSchema(db);
  const existing = schema.relations.find((r) => r.collection === collection && r.field === field);
  if (!existing) throw forbidden();
  await commit(db, schema, [db.prepare('DELETE FROM cirrus_relations WHERE id = ?1').bind(existing.id)], { collection, field });
}

// Cleanup ----------------------------------------------------------------------------------------

/**
 * What removing fields of a collection does to relations (Directus FieldsService.deleteField):
 * an M2O loses its relation, and its O2M alias on the other side goes too; an O2M alias leaves
 * its relation without one; relations naming them as junction or sort field forget them.
 * Returns the metadata statements, and the alias fields of other collections to delete.
 */
export function relationsOfRemovedFields(db: D1Database, schema: Schema, collection: string, fields: readonly string[]) {
  const statements: D1PreparedStatement[] = [];
  const aliases: Array<{ collection: string; field: string }> = [];
  for (const field of fields) {
    const m2o = schema.relations.find((r) => r.collection === collection && r.field === field);
    if (m2o) {
      statements.push(db.prepare('DELETE FROM cirrus_relations WHERE id = ?1').bind(m2o.id));
      if (m2o.oneField && !(m2o.related === collection && fields.includes(m2o.oneField))) aliases.push({ collection: m2o.related, field: m2o.oneField });
    }
    const o2m = schema.relations.find((r) => r.related === collection && r.oneField === field);
    if (o2m && o2m !== m2o) statements.push(db.prepare('UPDATE cirrus_relations SET one_field = NULL WHERE id = ?1').bind(o2m.id));
    statements.push(
      db.prepare('UPDATE cirrus_relations SET junction_field = NULL WHERE many_collection = ?1 AND junction_field = ?2').bind(collection, field),
      db.prepare('UPDATE cirrus_relations SET sort_field = NULL WHERE many_collection = ?1 AND sort_field = ?2').bind(collection, field),
    );
  }
  return { statements, aliases };
}

// Output -----------------------------------------------------------------------------------------

/** The Directus shape of a relation; `schema` describes the foreign key Cirrus enforces (null when it enforces none). */
export function toDirectusRelation(schema: Schema, r: RelationRecord) {
  const related = anyCollection(schema, r.related);
  return {
    collection: r.collection,
    field: r.field,
    related_collection: r.related,
    meta: {
      id: r.id,
      many_collection: r.collection,
      many_field: r.field,
      one_collection: r.related,
      one_field: r.oneField,
      one_collection_field: null,
      one_allowed_collections: null,
      junction_field: r.junctionField,
      sort_field: r.sortField,
      one_deselect_action: r.deselect,
    },
    schema:
      r.onDelete === null
        ? null
        : {
            table: r.collection,
            column: r.field,
            foreign_key_schema: null,
            foreign_key_table: r.related,
            foreign_key_column: related ? primaryOf(related).field : null,
            constraint_name: null,
            on_update: 'NO ACTION',
            on_delete: r.onDelete,
          },
  };
}
