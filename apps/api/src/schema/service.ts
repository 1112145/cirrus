import { planCreateTable, planDropTable, planTableChange, sameName } from '@cirrus/schema';
import { forbidden, invalidPayload } from '@cirrus/shared';
import { commit, prepare } from './commit.ts';
import {
  buildColumn,
  DEFAULT_PRIMARY_KEY,
  type FieldPayload,
  newField,
  parseCollectionMeta,
  parseCollectionPayload,
  parseFieldPayload,
} from './directus.ts';
import { COLLECTION_META, type CollectionMeta, metaDefaults } from './meta.ts';
import { keyTypesMatch, relationsOfRemovedFields } from './relations.ts';
import {
  anyCollection,
  type CollectionRecord,
  type FieldRecord,
  getCollection,
  getField,
  getSchema,
  insertCollection,
  insertField,
  m2oOf,
  type NewField,
  type Schema,
  tableOf,
  updateCollection,
  updateField,
} from './store.ts';

/**
 * Schema changes: validate against the current snapshot, plan the DDL, then run DDL + metadata
 * writes in one D1 batch (spec §7.2). Admin-only; routes check that first.
 */

// Collections --------------------------------------------------------------------------------

export async function createCollections(db: D1Database, bodies: unknown[]): Promise<string[]> {
  const schema = await getSchema(db);
  const created: string[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const body of bodies) {
    const input = parseCollectionPayload(body);
    const name = input.collection;
    if ([...schema.collections.keys(), ...created].some((n) => sameName(n, name))) {
      throw invalidPayload(`Collection "${name}" already exists`);
    }
    const meta = { ...metaDefaults(COLLECTION_META), ...input.meta };
    assertGroup(schema, name, meta.group, created);

    statements.push(insertCollection(db, { collection: name, folder: input.folder, meta }));
    if (!input.folder) {
      const fields = collectionFields(name, input.fields);
      statements.push(...prepare(db, planCreateTable({ name, fields })), ...fields.map((f) => insertField(db, f)));
    }
    created.push(name);
  }

  await commit(db, schema, statements, { collection: created[0] ?? '' });
  return created;
}

function collectionFields(collection: string, payloads: FieldPayload[]): NewField[] {
  const fields: NewField[] = [];
  for (const p of payloads) {
    const f = newField(collection, p);
    if (fields.some((x) => sameName(x.field, f.field))) throw invalidPayload(`Field "${f.field}" is defined more than once`);
    fields.push(f);
  }

  const pks = fields.filter((f) => f.column?.primaryKey);
  if (pks.length > 1) throw invalidPayload('A collection can only have one primary key');
  if (pks.length === 0) {
    if (fields.some((f) => sameName(f.field, 'id'))) {
      throw invalidPayload('The collection needs a primary key: set "schema.is_primary_key" on one field');
    }
    fields.unshift(newField(collection, DEFAULT_PRIMARY_KEY));
  }

  fields.forEach((f, i) => {
    f.meta.sort ??= i + 1;
  });
  return fields;
}

export async function updateCollections(db: D1Database, items: Array<{ name: unknown; body: unknown }>): Promise<string[]> {
  const schema = await getSchema(db);
  const updated = new Map<string, CollectionMeta>();

  for (const { name, body } of items) {
    if (typeof name !== 'string') throw invalidPayload('"collection" is required');
    const current = updated.get(name) ?? getCollection(schema, name).meta;
    const meta = { ...current, ...parseCollectionMeta(body) };
    assertGroup(schema, name, meta.group);
    updated.set(name, meta);
  }

  const statements = [...updated].map(([name, meta]) => updateCollection(db, name, meta));
  await commit(db, schema, statements, { collection: [...updated.keys()][0] ?? '' });
  return [...updated.keys()];
}

/**
 * Drops the table and everything that points at the collection: its permissions and relations,
 * the M2O fields of other collections pointing at it, and the O2M aliases listing its items
 * (as in Directus).
 */
export async function deleteCollection(db: D1Database, name: string): Promise<void> {
  const schema = await getSchema(db);
  const c = getCollection(schema, name);
  const incoming = new Map<string, string[]>();
  for (const r of schema.relations) {
    if (r.related === name && r.collection !== name) incoming.set(r.collection, [...(incoming.get(r.collection) ?? []), r.field]);
  }
  await commit(
    db,
    schema,
    [
      ...[...incoming].flatMap(([other, fields]) => removeFields(db, schema, getCollection(schema, other), fields)),
      ...schema.relations
        .filter((r) => r.collection === name && r.oneField && r.related !== name)
        .flatMap((r) => fieldMetadata(db, r.related, r.oneField!)),
      ...(c.folder ? [] : prepare(db, planDropTable(name))),
      db.prepare('DELETE FROM cirrus_permissions WHERE collection = ?1').bind(name),
      db.prepare('DELETE FROM cirrus_relations WHERE many_collection = ?1 OR one_collection = ?1').bind(name),
      // Foreign keys delete its fields and ungroup collections grouped under it.
      db.prepare('DELETE FROM cirrus_collections WHERE collection = ?1').bind(name),
    ],
    { collection: name },
  );
}

function assertGroup(schema: Schema, collection: string, group: string | null, pending: string[] = []) {
  if (group === null) return;
  if (group === collection) throw invalidPayload("A collection can't be grouped under itself");
  if (!schema.collections.has(group) && !pending.includes(group)) {
    throw invalidPayload(`Collection "${group}" used as group doesn't exist`);
  }
}

// Fields -------------------------------------------------------------------------------------

export async function createField(db: D1Database, collection: string, body: unknown): Promise<string> {
  const schema = await getSchema(db);
  const c = tableCollection(schema, collection);
  const p = parseFieldPayload(body);
  const f = newField(collection, p);

  if (c.fields.some((x) => sameName(x.field, f.field))) {
    throw invalidPayload(`Field "${f.field}" already exists in collection "${collection}"`);
  }
  if (f.column?.primaryKey) throw invalidPayload(`Collection "${collection}" already has a primary key`);

  // Like Directus: append at the end of its group.
  f.meta.sort ??= Math.max(0, ...c.fields.filter((x) => x.meta.group === f.meta.group).map((x) => x.meta.sort ?? 0)) + 1;

  const plan = planTableChange(tableOf(c), tableOf(c, [...c.fields, f]));
  await commit(db, schema, [...prepare(db, plan.statements), insertField(db, f)], { collection, field: f.field });
  return f.field;
}

/** Update one or more fields of a collection; any column changes are planned together. */
export async function updateFields(db: D1Database, collection: string, items: Array<{ name: unknown; body: unknown }>) {
  const schema = await getSchema(db);
  const c = tableCollection(schema, collection);
  const fields: FieldRecord[] = [...c.fields];
  const updated = new Map<string, FieldRecord>();

  for (const { name, body } of items) {
    if (typeof name !== 'string') throw invalidPayload('"field" is required');
    const p = parseFieldPayload(body);
    if (p.field !== undefined && p.field !== name) throw invalidPayload("Fields can't be renamed");
    const i = fields.findIndex((f) => f.field === name);
    if (i < 0) throw forbidden();
    const next = applyFieldUpdate(fields[i]!, p);
    // The key of an M2O must stay comparable with the related primary key.
    const relation = m2oOf(schema, collection, name);
    const related = relation && anyCollection(schema, relation.related);
    const pk = related?.fields.find((f) => f.column?.primaryKey);
    if (pk && next.type !== fields[i]!.type && !keyTypesMatch(next.type, pk.type)) {
      throw invalidPayload(`Field "${name}" holds keys of collection "${relation!.related}", which are of type "${pk.type}"`);
    }
    fields[i] = next;
    updated.set(name, next);
  }

  const plan = planTableChange(tableOf(c), tableOf(c, fields));
  const writes = [...updated.values()].map((f) => updateField(db, f));
  const only = updated.size === 1 ? [...updated.keys()][0] : undefined;
  await commit(db, schema, [...prepare(db, plan.statements), ...writes], { collection, field: only });
  return [...updated.keys()];
}

function applyFieldUpdate(current: FieldRecord, p: FieldPayload): FieldRecord {
  const type = p.type ?? current.type;
  if ((type === 'alias') !== (current.type === 'alias')) {
    throw invalidPayload(`Field "${current.field}" can't change from type "${current.type}" to "${type}"`);
  }

  let column = current.column;
  if (column && (p.schema || type !== current.type)) {
    const next = buildColumn(type, p.schema, { type: current.type, column });
    if (next.primaryKey !== column.primaryKey) {
      throw invalidPayload(column.primaryKey ? "The primary key can't be removed" : 'A collection can only have one primary key');
    }
    if (column.primaryKey && (type !== current.type || next.autoIncrement !== column.autoIncrement)) {
      throw invalidPayload("The primary key's type can't be changed");
    }
    column = next;
  }

  return { ...current, type, column, meta: { ...current.meta, ...p.meta } };
}

export async function deleteField(db: D1Database, collection: string, name: string): Promise<void> {
  const schema = await getSchema(db);
  const c = tableCollection(schema, collection);
  const f = getField(c, name);
  if (f.column?.primaryKey) throw invalidPayload("The primary key can't be deleted");
  await commit(db, schema, removeFields(db, schema, c, [name]), { collection, field: name });
}

/**
 * Remove fields of a collection: their columns, their metadata and what refers to them. As in
 * Directus: collection meta and grouped fields forget them, and so do relations; an M2O's relation
 * goes, and with it the O2M alias on the other side (relationsOfRemovedFields).
 */
function removeFields(db: D1Database, schema: Schema, c: CollectionRecord, names: readonly string[]): D1PreparedStatement[] {
  const plan = planTableChange(tableOf(c), tableOf(c, c.fields.filter((x) => !names.includes(x.field))));
  const { statements, aliases } = relationsOfRemovedFields(db, schema, c.collection, names);
  return [
    ...prepare(db, plan.statements),
    ...names.flatMap((name) => fieldMetadata(db, c.collection, name)),
    ...statements,
    ...aliases.flatMap((a) => fieldMetadata(db, a.collection, a.field)),
  ];
}

/** Delete a field's metadata and clear references to it in collection meta and in grouped fields. */
const fieldMetadata = (db: D1Database, collection: string, name: string) => [
  db.prepare('DELETE FROM cirrus_fields WHERE collection = ?1 AND field = ?2').bind(collection, name),
  db
    .prepare(
      `UPDATE cirrus_collections SET
         sort_field = CASE WHEN sort_field = ?2 THEN NULL ELSE sort_field END,
         archive_field = CASE WHEN archive_field = ?2 THEN NULL ELSE archive_field END
       WHERE collection = ?1`,
    )
    .bind(collection, name),
  db.prepare('UPDATE cirrus_fields SET parent = NULL WHERE collection = ?1 AND parent = ?2').bind(collection, name),
];

function tableCollection(schema: Schema, name: string): CollectionRecord {
  const c = getCollection(schema, name);
  if (c.folder) throw invalidPayload(`Collection "${name}" is a folder and can't have fields`);
  return c;
}

