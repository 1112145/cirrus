import {
  planCreateTable,
  planDropTable,
  planTableChange,
  REBUILD_PREFIX,
  sameName,
} from '@cirrus/schema';
import { CirrusError, forbidden, invalidPayload, uuidv7 } from '@cirrus/shared';
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
import {
  type CollectionRecord,
  type FieldRecord,
  getCollection,
  getField,
  getSchema,
  insertCollection,
  insertField,
  invalidateSchema,
  type NewField,
  readSchemaVersion,
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

/** Drops the table and everything that points at the collection. */
export async function deleteCollection(db: D1Database, name: string): Promise<void> {
  const schema = await getSchema(db);
  const c = getCollection(schema, name);
  await commit(
    db,
    schema,
    [
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

  const plan = planTableChange(tableOf(c), tableOf(c, c.fields.filter((x) => x !== f)));
  await commit(
    db,
    schema,
    [
      ...prepare(db, plan.statements),
      db.prepare('DELETE FROM cirrus_fields WHERE id = ?1').bind(f.id),
      // Like Directus: clear references to the field in collection meta and in grouped fields.
      db
        .prepare(
          `UPDATE cirrus_collections SET
             sort_field = CASE WHEN sort_field = ?2 THEN NULL ELSE sort_field END,
             archive_field = CASE WHEN archive_field = ?2 THEN NULL ELSE archive_field END
           WHERE collection = ?1`,
        )
        .bind(collection, name),
      db.prepare('UPDATE cirrus_fields SET parent = NULL WHERE collection = ?1 AND parent = ?2').bind(collection, name),
    ],
    { collection, field: name },
  );
}

function tableCollection(schema: Schema, name: string): CollectionRecord {
  const c = getCollection(schema, name);
  if (c.folder) throw invalidPayload(`Collection "${name}" is a folder and can't have fields`);
  return c;
}

// Commit -------------------------------------------------------------------------------------

const prepare = (db: D1Database, sql: string[]) => sql.map((s) => db.prepare(s));

type ErrorContext = { collection: string; field?: string | undefined };

/**
 * Run a schema change atomically. The first statement swaps schema_version for a new value only if
 * it still matches the snapshot the change was planned against; otherwise it writes invalid JSON,
 * the json_valid CHECK fails and the whole batch rolls back. D1 has no interactive transactions,
 * so this compare-and-swap is what stops two concurrent changes from overwriting each other.
 */
export async function commit(db: D1Database, schema: Pick<Schema, 'version'>, statements: D1PreparedStatement[], ctx: ErrorContext) {
  if (statements.length === 0) return;
  const bump = db
    .prepare("UPDATE cirrus_settings SET value = CASE WHEN value = ?1 THEN ?2 ELSE 'conflict' END WHERE key = 'schema_version'")
    .bind(schema.version, JSON.stringify(uuidv7()));
  try {
    await db.batch([bump, ...statements]);
  } catch (err) {
    if ((await readSchemaVersion(db)) !== schema.version) {
      throw new CirrusError('SERVICE_UNAVAILABLE', 'The schema was changed by another request. Please retry.');
    }
    throw translateDbError(err, ctx);
  } finally {
    invalidateSchema();
  }
}

const tableName = (t: string) => (t.startsWith(REBUILD_PREFIX) ? t.slice(REBUILD_PREFIX.length) : t);

/** Turn SQLite errors from DDL on existing data into Directus errors. */
export function translateDbError(err: unknown, ctx: ErrorContext): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  let m: RegExpExecArray | null;

  if ((m = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [tableName(m[1]!), m[2]!];
    return new CirrusError('CONTAINS_NULL_VALUES', `Field "${field}" in collection "${collection}" contains null values.`, {
      collection,
      field,
    });
  }
  if (msg.includes('Cannot add a NOT NULL column')) {
    return new CirrusError(
      'CONTAINS_NULL_VALUES',
      `Field "${ctx.field}" in collection "${ctx.collection}" would contain null values: make it nullable or give it a default value.`,
      { collection: ctx.collection, field: ctx.field },
    );
  }
  if ((m = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [tableName(m[1]!), m[2]!];
    return new CirrusError('RECORD_NOT_UNIQUE', `Value for field "${field}" in collection "${collection}" has to be unique.`, {
      collection,
      field,
    });
  }
  if ((m = /cannot store \w+ value in (\w+) column (\w+)\.(\w+)/.exec(msg))) {
    return invalidPayload(`Existing values of field "${m[3]}" in collection "${tableName(m[2]!)}" can't be stored as ${m[1]}`);
  }
  if (msg.includes('CHECK constraint failed')) {
    return invalidPayload(`Existing values in collection "${ctx.collection}" don't fit the new field type`);
  }
  return err;
}
