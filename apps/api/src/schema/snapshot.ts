import { planCreateTable, planDropTable, planTableChange, sameName } from '@cirrus/schema';
import { applyDiffEntry, deepDiff, type DiffEntry, invalidPayload, isDiffEntry, isPlainObject, sha256Hex, sortKeysDeep } from '@cirrus/shared';
import { commit, prepare } from './commit.ts';
import { directusField, newField, parseCollectionPayload, parseFieldPayload, toDirectusCollection } from './directus.ts';
import { COLLECTION_META, metaDefaults, metaToColumns } from './meta.ts';
import { assertKeyType, assertMeta, danglingGuard, parseRelation, relatedCollection, relationColumns, toDirectusRelation } from './relations.ts';
import { assertGroup } from './service.ts';
import { type CollectionRecord, fieldColumns, type FieldRecord, type RelationRecord, type Schema, tableOf } from './store.ts';

/**
 * Schema snapshots (spec §7.5, ADR-030), as Directus' `GET /schema/snapshot`, `POST /schema/diff`
 * and `POST /schema/apply`: the user collections, fields and relations as one JSON document, the
 * differences between it and this server in deep-diff's format, and applying them.
 *
 * Applying is declarative: the diff is applied to this server's own snapshot, the result is
 * checked as a whole (as if every collection, field and relation in it were created at once), and
 * the DDL and metadata writes that turn the current schema into it run in one D1 batch, so a
 * schema is applied entirely or not at all.
 */

/** Snapshot format version (Directus `version`). */
export const SNAPSHOT_VERSION = 1;
/** The Directus version Cirrus follows (ADR-009), reported as the snapshot's `directus`. */
export const DIRECTUS_VERSION = '11.17.4';
/** Directus reports its database client; Cirrus runs on D1, which is SQLite. */
export const VENDOR = 'sqlite';

type Json = Record<string, unknown>;

export type Snapshot = {
  version: number;
  directus: string;
  vendor: string;
  collections: Json[];
  fields: Json[];
  /** Directus: indexes on system fields. Cirrus' system tables are fixed, so this is always empty and ignored on input. */
  systemFields: Json[];
  relations: Json[];
};

type CollectionDiff = { collection: string; diff: DiffEntry[] };
type FieldDiff = { collection: string; field: string; diff: DiffEntry[] };
type RelationDiff = { collection: string; field: string; related_collection: string | null; diff: DiffEntry[] };

export type SchemaDiff = { collections: CollectionDiff[]; fields: FieldDiff[]; systemFields: Json[]; relations: RelationDiff[] };

// Snapshot -----------------------------------------------------------------------------------------

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The snapshot of a schema: Directus' collection, field and relation objects without ids, keys sorted. */
export function snapshotOf(schema: Schema): Snapshot {
  const collections = [...schema.collections.values()].sort((a, b) => byName(a.collection, b.collection));
  return {
    version: SNAPSHOT_VERSION,
    directus: DIRECTUS_VERSION,
    vendor: VENDOR,
    collections: collections.map((c) => {
      const { collection, meta, schema: s } = toDirectusCollection(c);
      return sortKeysDeep({ collection, meta, schema: s && { name: s.name } });
    }),
    fields: collections.flatMap((c) => c.fields.map((f) => fieldEntry(schema, f))),
    systemFields: [],
    relations: [...schema.relations]
      .sort((a, b) => byName(a.collection, b.collection) || byName(a.field, b.field))
      .map((r) => {
        const { meta, schema: s, ...rest } = toDirectusRelation(schema, r);
        const { id: _id, ...m } = meta;
        const fk = s && { ...s };
        if (fk) delete (fk as Partial<typeof fk>).foreign_key_schema;
        return sortKeysDeep({ ...rest, meta: m, schema: fk });
      }),
  };
}

function fieldEntry(schema: Schema, f: FieldRecord): Json {
  const { meta, schema: s, ...rest } = directusField(schema, f);
  const { id: _id, ...m } = meta;
  const column = s && { ...s };
  if (column) delete (column as Partial<typeof column>).comment;
  return sortKeysDeep({ ...rest, meta: m, schema: column });
}

/** Identifies the schema a diff was made against (Directus: a hash of the snapshot). */
export const hashOf = (s: Snapshot) => sha256Hex(JSON.stringify([s.collections, s.fields, s.relations]));

/** Check a snapshot from a request. Directus refuses snapshots of another version or database unless forced. */
export function parseSnapshot(body: unknown, force: boolean): Snapshot {
  if (!isPlainObject(body)) throw invalidPayload('The snapshot must be an object');
  if (body.version !== SNAPSHOT_VERSION) throw invalidPayload(`"version" must be ${SNAPSHOT_VERSION}`);
  if (typeof body.directus !== 'string') throw invalidPayload('"directus" must be a string');
  if (typeof body.vendor !== 'string') throw invalidPayload('"vendor" must be a string');
  if (!force && body.directus !== DIRECTUS_VERSION) {
    throw invalidPayload(
      `Provided snapshot's directus version ${body.directus} does not match the current instance's version ${DIRECTUS_VERSION}. You can bypass this check by passing the "force" query parameter`,
    );
  }
  if (!force && body.vendor !== VENDOR) {
    throw invalidPayload(
      `Provided snapshot's vendor ${body.vendor} does not match the current instance's vendor ${VENDOR}. You can bypass this check by passing the "force" query parameter`,
    );
  }
  const list = (key: 'collections' | 'fields' | 'relations' | 'systemFields', optional = false): Json[] => {
    const v = body[key];
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) throw invalidPayload(`"${key}" must be an array`);
    v.forEach((item, i) => {
      if (!isPlainObject(item)) throw invalidPayload(`"${key}[${i}]" must be an object`);
    });
    return v as Json[];
  };
  return {
    version: SNAPSHOT_VERSION,
    directus: body.directus,
    vendor: body.vendor,
    collections: list('collections'),
    fields: list('fields'),
    systemFields: list('systemFields', true),
    relations: list('relations'),
  };
}

// The schema a snapshot describes --------------------------------------------------------------------

/** Ids given to relations that don't exist yet; below those of system relations (SYSTEM_RELATIONS). */
const NEW_RELATION = -1_000_000;

const isSystem = (name: unknown) => typeof name === 'string' && name.toLowerCase().startsWith('directus_');

/**
 * The schema a snapshot describes, checked as the API checks each change, and against the current
 * schema for what can't change in place: a folder can't become a table (or back), alias fields
 * can't get a column, primary keys stay as they are. Fields and relations keep the ids they have.
 */
export function schemaOf(snapshot: Snapshot, current: Schema): Schema {
  const collections = new Map<string, CollectionRecord>();
  for (const raw of snapshot.collections) {
    const p = parseCollectionPayload({ collection: raw.collection, meta: raw.meta, schema: raw.schema });
    if ([...collections.keys()].some((n) => sameName(n, p.collection))) {
      throw invalidPayload(`Collection "${p.collection}" is in the snapshot more than once`);
    }
    collections.set(p.collection, { collection: p.collection, folder: p.folder, meta: { ...metaDefaults(COLLECTION_META), ...p.meta }, fields: [] });
  }
  for (const c of collections.values()) assertGroup({ collections }, c.collection, c.meta.group);

  snapshot.fields.forEach((raw, i) => {
    const where = `"fields[${i}]"`;
    if (typeof raw.collection !== 'string') throw invalidPayload(`${where}: "collection" must be a string`);
    if (isSystem(raw.collection)) throw invalidPayload(`Field "${String(raw.field)}" of "${raw.collection}": the fields of system collections can't be changed`);
    const c = collections.get(raw.collection);
    if (!c) throw invalidPayload(`Field "${String(raw.field)}" belongs to collection "${raw.collection}", which isn't in the snapshot`);
    if (c.folder) throw invalidPayload(`Collection "${c.collection}" is a folder and can't have fields`);
    const payload = parseFieldPayload(raw, `fields[${i}]`);
    // Other databases report the sequence of an auto-increment key as its default (Postgres' nextval(…)).
    if (payload.schema?.is_primary_key && payload.schema.has_auto_increment) payload.schema.default_value = null;
    const f = newField(c.collection, payload);
    if (c.fields.some((x) => sameName(x.field, f.field))) throw invalidPayload(`Field "${f.field}" of collection "${c.collection}" is in the snapshot more than once`);
    const existing = current.collections.get(c.collection)?.fields.find((x) => x.field === f.field);
    c.fields.push({ ...f, id: existing?.id ?? 0 });
  });

  for (const c of collections.values()) {
    if (c.folder) continue;
    const pks = c.fields.filter((f) => f.column?.primaryKey);
    if (pks.length !== 1) throw invalidPayload(`Collection "${c.collection}" needs exactly one primary key field`);
    const cur = current.collections.get(c.collection);
    if (!cur) continue;
    if (cur.folder) throw invalidPayload(`Collection "${c.collection}" can't change between a folder and a collection with a table`);
    const [pk, oldPk] = [pks[0]!, cur.fields.find((f) => f.column?.primaryKey)!];
    if (pk.field !== oldPk.field || pk.type !== oldPk.type || pk.column!.autoIncrement !== oldPk.column!.autoIncrement) {
      throw invalidPayload(`The primary key of collection "${c.collection}" can't be changed`);
    }
    for (const f of c.fields) {
      const old = cur.fields.find((x) => x.field === f.field);
      if (old && (old.type === 'alias') !== (f.type === 'alias')) {
        throw invalidPayload(`Field "${f.field}" in collection "${c.collection}" can't change from type "${old.type}" to "${f.type}"`);
      }
    }
  }
  for (const c of current.collections.values()) {
    if (!c.folder && collections.get(c.collection)?.folder) {
      throw invalidPayload(`Collection "${c.collection}" can't change between a folder and a collection with a table`);
    }
  }

  const relations: RelationRecord[] = [];
  const schema: Schema = { version: current.version, access: current.access, collections, relations };
  snapshot.relations.forEach((raw, i) => {
    const input = parseRelation(raw);
    if (!input.collection || !input.field) throw invalidPayload(`"relations[${i}]": "collection" and "field" are required`);
    const name = `${input.collection}.${input.field}`;
    if (isSystem(input.collection)) throw invalidPayload(`Relation "${name}": the relations of system collections can't be changed`);
    const many = collections.get(input.collection);
    if (!many || many.folder) throw invalidPayload(`Relation "${name}": collection "${input.collection}" isn't in the snapshot`);
    const f = many.fields.find((x) => x.field === input.field);
    if (!f) throw invalidPayload(`Relation "${name}": field "${input.field}" isn't in the snapshot`);
    if (f.column?.primaryKey) throw invalidPayload(`${input.collection}'s primary key can't be a foreign key`);
    if (!f.column) throw invalidPayload(`Field "${input.field}" in collection "${input.collection}" is an alias and can't hold keys`);
    if (!input.related) throw invalidPayload(`Relation "${name}": "related_collection" is required: many-to-any relations aren't supported yet`);
    const related = relatedCollection(schema, input.related);
    assertKeyType(f, f.type, related);
    if (relations.some((r) => r.collection === input.collection && r.field === input.field)) {
      throw invalidPayload(`Relation "${name}" is in the snapshot more than once`);
    }
    const existing = current.relations.find((r) => r.collection === input.collection && r.field === input.field);
    relations.push({
      id: existing?.id ?? NEW_RELATION - i,
      collection: input.collection,
      field: input.field,
      related: related.collection,
      oneField: input.oneField ?? null,
      junctionField: input.junctionField ?? null,
      sortField: input.sortField ?? null,
      deselect: input.deselect ?? 'nullify',
      onDelete: input.schema === null ? null : (input.schema?.onDelete ?? 'NO ACTION'),
    });
  });
  for (const r of relations) assertMeta(schema, r);
  return schema;
}

// Diff -----------------------------------------------------------------------------------------------

const fieldKey = (x: Json) => `${String(x.collection)}\u0000${String(x.field)}`;

function diffList<T>(before: Json[], after: Json[], key: (x: Json) => string, entry: (x: Json, diff: DiffEntry[]) => T): T[] {
  const a = new Map(before.map((x) => [key(x), x]));
  const b = new Map(after.map((x) => [key(x), x]));
  const out: Array<{ k: string; v: T }> = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const diff = deepDiff(a.get(k), b.get(k));
    if (diff.length) out.push({ k, v: entry((b.get(k) ?? a.get(k))!, diff) });
  }
  return out.sort((x, y) => byName(x.k, y.k)).map((x) => x.v);
}

/** Directus getSnapshotDiff: what turns `current` into `desired`; the fields and relations of deleted collections go with them. */
export function diffSnapshots(current: Snapshot, desired: Snapshot): SchemaDiff {
  const collections = diffList(current.collections, desired.collections, (x) => String(x.collection), (x, diff) => ({ collection: String(x.collection), diff }));
  const deleted = new Set(collections.filter((c) => c.diff[0]?.kind === 'D' && !c.diff[0].path).map((c) => c.collection));
  const fields = diffList(current.fields, desired.fields, fieldKey, (x, diff) => ({ collection: String(x.collection), field: String(x.field), diff }));
  const relations = diffList(current.relations, desired.relations, fieldKey, (x, diff) => ({
    collection: String(x.collection),
    field: String(x.field),
    related_collection: (x.related_collection as string | null) ?? null,
    diff,
  }));
  return {
    collections,
    fields: fields.filter((f) => !deleted.has(f.collection)),
    systemFields: [],
    relations: relations.filter((r) => !deleted.has(r.collection)),
  };
}

const isEmpty = (d: SchemaDiff) => d.collections.length + d.fields.length + d.relations.length === 0;

/** `POST /schema/diff`: the hash of the current schema and the diff to the snapshot, or null when there is none. */
export async function diffSchema(current: Schema, body: unknown, force: boolean): Promise<{ hash: string; diff: SchemaDiff } | null> {
  const desired = snapshotOf(schemaOf(parseSnapshot(body, force), current));
  const now = snapshotOf(current);
  const diff = diffSnapshots(now, desired);
  return isEmpty(diff) ? null : { hash: await hashOf(now), diff };
}

// Apply ----------------------------------------------------------------------------------------------

type Entries = { list: Json[]; entries: unknown; key: (x: Json) => string; label: string; keys: string[] };

/** Apply one section of a diff (collections, fields or relations) to a snapshot's list. */
function applySection({ list, entries, key, label, keys }: Entries) {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw invalidPayload(`"diff.${label}" must be an array`);
  entries.forEach((e: unknown, i) => {
    const where = `"diff.${label}[${i}]"`;
    if (!isPlainObject(e) || keys.some((k) => typeof e[k] !== 'string')) throw invalidPayload(`${where} must have ${keys.map((k) => `"${k}"`).join(' and ')}`);
    if (!Array.isArray(e.diff) || !e.diff.every(isDiffEntry)) throw invalidPayload(`${where}: "diff" must be a list of changes`);
    const k = key(e);
    for (const change of e.diff as DiffEntry[]) {
      const at = list.findIndex((x) => key(x) === k);
      if (change.kind !== 'A' && !change.path?.length) {
        if (change.kind === 'N') {
          if (at >= 0) throw invalidPayload(`${where} creates something that already exists`);
          if (!isPlainObject(change.rhs)) throw invalidPayload(`${where}: a new entry must be an object`);
          list.push(structuredClone(change.rhs));
        } else if (at < 0) throw invalidPayload(`${where} changes something that doesn't exist`);
        else if (change.kind === 'D') list.splice(at, 1);
        else {
          if (!isPlainObject(change.rhs)) throw invalidPayload(`${where}: an entry must be an object`);
          list[at] = structuredClone(change.rhs);
        }
        continue;
      }
      if (at < 0) throw invalidPayload(`${where} changes something that doesn't exist`);
      if (!applyDiffEntry(list[at], structuredClone(change))) throw invalidPayload(`${where} doesn't fit the current schema`);
    }
  });
}

/** The snapshot a diff turns `snapshot` into. */
export function applyDiff(snapshot: Snapshot, diff: Json): Snapshot {
  const next = structuredClone(snapshot);
  applySection({ list: next.collections, entries: diff.collections, key: (x) => String(x.collection), label: 'collections', keys: ['collection'] });
  applySection({ list: next.fields, entries: diff.fields, key: fieldKey, label: 'fields', keys: ['collection', 'field'] });
  applySection({ list: next.relations, entries: diff.relations, key: fieldKey, label: 'relations', keys: ['collection', 'field'] });
  // What belonged to a deleted collection goes with it, as Directus deletes it.
  const names = new Set(next.collections.map((c) => c.collection));
  next.fields = next.fields.filter((f) => names.has(f.collection));
  next.relations = next.relations.filter((r) => names.has(r.collection));
  return next;
}

/** `POST /schema/apply`: refuse a diff made against another schema, then turn the schema into what it describes, in one batch. */
export async function applySchema(db: D1Database, current: Schema, body: unknown): Promise<void> {
  if (!isPlainObject(body) || typeof body.hash !== 'string' || !isPlainObject(body.diff)) {
    throw invalidPayload('"hash" (a string) and "diff" (an object) are required');
  }
  const now = snapshotOf(current);
  if (body.hash !== (await hashOf(now))) {
    throw invalidPayload(
      "Provided hash does not match the current instance's schema hash, indicating the schema has changed after this diff was generated. Please generate a new diff and try again",
    );
  }
  const desired = schemaOf(applyDiff(now, body.diff), current);
  const statements = planChanges(db, current, desired);
  const first = statements.length ? [...desired.collections.keys(), ...current.collections.keys()][0] : undefined;
  await commit(db, current, statements, { collection: first ?? '' });
}

// Planning ---------------------------------------------------------------------------------------------

type DbValue = string | number | null;

/** Rows travel as JSON arrays read with json_each() (spec §8.5): one statement per table, whatever the number of rows. */
const MAX_JSON = 512 * 1024;

function chunks(rows: DbValue[][]): string[] {
  const out: string[] = [];
  let current: DbValue[][] = [];
  let size = 0;
  for (const row of rows) {
    const length = JSON.stringify(row).length + 1;
    if (current.length && size + length > MAX_JSON) {
      out.push(JSON.stringify(current));
      [current, size] = [[], 0];
    }
    current.push(row);
    size += length;
  }
  if (current.length) out.push(JSON.stringify(current));
  return out;
}

const extract = (i: number, from = 'value') => `json_extract(${from}, '$[${i}]')`;

function insertRows(db: D1Database, table: string, columns: readonly string[], rows: DbValue[][]): D1PreparedStatement[] {
  return chunks(rows).map((json) =>
    db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map((_, i) => extract(i)).join(', ')} FROM json_each(?1)`).bind(json),
  );
}

/** Update rows by key: each row is [key, ...values of `columns`]. */
function updateRows(db: D1Database, table: string, key: string, columns: readonly string[], rows: DbValue[][]): D1PreparedStatement[] {
  return chunks(rows).map((json) =>
    db
      .prepare(
        `UPDATE ${table} SET ${columns.map((c, i) => `${c} = ${extract(i + 1, 'j.value')}`).join(', ')} ` +
          `FROM json_each(?1) AS j WHERE ${table}.${key} = ${extract(0, 'j.value')}`,
      )
      .bind(json),
  );
}

const deleteRows = (db: D1Database, table: string, key: string, values: DbValue[]) =>
  values.length ? [db.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(values))] : [];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const collectionColumns = (c: CollectionRecord) => metaToColumns(COLLECTION_META, c.meta);

/**
 * The statements that turn `current` into `desired`, for one batch. Order matters for the system
 * tables' foreign keys: collections are deleted before they're created, created without a group
 * and grouped once they all exist, and fields are written once their collections are. Relations
 * that change are deleted and written again with their ids, so their unique keys never clash
 * midway. Guards run last, on the final tables.
 */
export function planChanges(db: D1Database, current: Schema, desired: Schema): D1PreparedStatement[] {
  const removed = [...current.collections.values()].filter((c) => !desired.collections.has(c.collection));
  const added = [...desired.collections.values()].filter((c) => !current.collections.has(c.collection));
  const kept = [...desired.collections.values()].filter((c) => current.collections.has(c.collection));

  const oldRelations = new Map(current.relations.map((r) => [r.id, r]));
  const relationChanged = (r: RelationRecord) => !oldRelations.has(r.id) || !same(relationColumns(r), relationColumns(oldRelations.get(r.id)!));
  const writtenRelations = desired.relations.filter(relationChanged);
  const goneRelations = current.relations.filter((r) => !desired.relations.some((x) => x.id === r.id) || writtenRelations.some((x) => x.id === r.id));

  const statements: D1PreparedStatement[] = [
    ...deleteRows(db, 'cirrus_relations', 'id', goneRelations.map((r) => r.id)),
    ...deleteRows(db, 'cirrus_permissions', 'collection', removed.map((c) => c.collection)),
    ...removed.filter((c) => !c.folder).flatMap((c) => prepare(db, planDropTable(c.collection))),
    // Their fields go by cascade; collections grouped under them are regrouped below.
    ...deleteRows(db, 'cirrus_collections', 'collection', removed.map((c) => c.collection)),
  ];

  const metaColumns = metaToColumns(COLLECTION_META, metaDefaults(COLLECTION_META)).map(([c]) => c);
  if (added.length) {
    const ungrouped = added.map((c) => [c.collection, c.folder ? 1 : 0, ...collectionColumns({ ...c, meta: { ...c.meta, group: null } }).map(([, v]) => v)]);
    statements.push(...insertRows(db, 'cirrus_collections', ['collection', 'folder', ...metaColumns], ungrouped));
  }

  for (const c of added) if (!c.folder) statements.push(...prepare(db, planCreateTable(tableOf(c))));
  for (const c of kept) if (!c.folder) statements.push(...prepare(db, planTableChange(tableOf(current.collections.get(c.collection)!), tableOf(c)).statements));

  // Fields: removed ones of kept collections, new ones, and changed ones.
  const goneFields = kept.flatMap((c) => current.collections.get(c.collection)!.fields.filter((f) => !c.fields.some((x) => x.field === f.field)));
  statements.push(...deleteRows(db, 'cirrus_fields', 'id', goneFields.map((f) => f.id)));
  const allFields = [...added, ...kept].flatMap((c) => c.fields);
  const newFields = allFields.filter((f) => f.id === 0);
  const oldFields = new Map([...current.collections.values()].flatMap((c) => c.fields.map((f) => [f.id, f] as const)));
  const changedFields = allFields.filter((f) => f.id !== 0 && !same(fieldColumns(f), fieldColumns(oldFields.get(f.id)!)));
  const sample = allFields[0];
  if (sample) {
    const columns = fieldColumns(sample).map(([c]) => c);
    statements.push(
      ...insertRows(db, 'cirrus_fields', ['collection', 'field', ...columns], newFields.map((f) => [f.collection, f.field, ...fieldColumns(f).map(([, v]) => v)])),
      ...updateRows(db, 'cirrus_fields', 'id', columns, changedFields.map((f) => [f.id, ...fieldColumns(f).map(([, v]) => v)])),
    );
  }

  // Collections' meta, groups included, once every collection exists.
  const regrouped = [...added.filter((c) => c.meta.group !== null), ...kept.filter((c) => !same(collectionColumns(c), collectionColumns(current.collections.get(c.collection)!)))];
  if (regrouped.length) statements.push(...updateRows(db, 'cirrus_collections', 'collection', metaColumns, regrouped.map((c) => [c.collection, ...collectionColumns(c).map(([, v]) => v)])));

  if (writtenRelations.length) {
    const columns = relationColumns(writtenRelations[0]!).map(([c]) => c);
    // New relations get an id from AUTOINCREMENT (NULL); changed ones keep theirs.
    const rows = writtenRelations.map((r) => [r.id > 0 ? r.id : null, ...relationColumns(r).map(([, v]) => v)]);
    statements.push(...insertRows(db, 'cirrus_relations', ['id', ...columns], rows));
  }
  // Existing keys must reference items, as when creating the relation (or starting to enforce it).
  for (const r of writtenRelations) {
    const old = oldRelations.get(r.id);
    if (r.onDelete !== null && (!old || old.onDelete === null || old.related !== r.related)) statements.push(danglingGuard(db, r, desired));
  }

  return statements;
}
