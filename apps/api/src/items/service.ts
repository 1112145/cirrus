import {
  type Access,
  clearKeys,
  countItems,
  deleteItems,
  type Filter,
  FOREIGN_KEY_CONSTRAINT,
  foreignKeyGuard,
  guardItems,
  insertItems,
  isEmptyFilter,
  isKeyRef,
  type KeyRef,
  parseFilter,
  planRead,
  type Query,
  type QueryCollection,
  type ReadPlan,
  referenceGuard,
  type Row,
  type RowQuery,
  type Scope,
  selectKeys,
  type Statement,
  stashClosure,
  stashKeys,
  stashNewKey,
  type Target,
  updateItems,
  validatePayload,
  validationMessage,
  writeCondition,
} from '@cirrus/query';
import { type DbValue, NOW, toDbValue } from '@cirrus/schema';
import { CirrusError, CirrusErrors, forbidden, invalidPayload, isPlainObject } from '@cirrus/shared';
import type { RequestContext } from '../request.ts';
import { anyCollection, bumpSchemaVersion, invalidateSchema, m2oOf, type RelationRecord, relationsTo, type Schema } from '../schema/store.ts';
import type { SystemCollection } from '../system/collections.ts';
import { type ItemsContext, queryInfo, relatedContext } from './context.ts';
import { invalidForeignKey, translateItemError } from './errors.ts';
import { checked, defaultItem, hashSecrets, type Item, type Key, type Nested, parseKey, presenter, toRow } from './payload.ts';

/**
 * Items CRUD (spec §8), following Directus' ItemsService, with permissions (spec §10) and
 * relations (spec §9). Every call is one D1 round trip: reads batch the data, related items and
 * count queries; writes run as one batch, so each write is atomic. Writes that must check rows
 * first (permissions, nested writes, foreign keys) start with guard statements, which abort the
 * whole batch when a row doesn't qualify.
 */

type Rows = Array<Record<string, unknown>>;

/** Who statements belong to: writes to system collections may change the access snapshot. */
type Owner = { system: SystemCollection | null };

/** The statements of one request, run as one D1 batch. */
class Batch {
  readonly statements: Statement[] = [];
  /** It writes roles, policies, access or permissions: replace schema_version too. */
  snapshot = false;
  /** Its foreign key guards: what each checks, and a probe to tell afterwards which one failed. */
  readonly foreignKeys: Array<{ collection: string; field: string; probe: Statement | null }> = [];
  #slots = 0;

  /** Add statements; returns their positions (for their results). */
  add(owner: Owner, ...statements: Array<Statement | null>): number[] {
    if (owner.system?.snapshot) this.snapshot = true;
    const positions: number[] = [];
    for (const s of statements) if (s) positions.push(this.statements.push(s) - 1);
    return positions;
  }

  /** A new slot in the batch keys table; the batch empties it as its last statement. */
  slot(): number {
    return ++this.#slots;
  }

  get stashes(): boolean {
    return this.#slots > 0;
  }
}

async function run(ctx: ItemsContext, batch: Batch): Promise<Rows[]> {
  if (batch.statements.length === 0) return [];
  const statements = batch.stashes ? [...batch.statements, clearKeys()] : batch.statements;
  const prepared = statements.map((s) => ctx.db.prepare(s.sql).bind(...s.params));
  if (batch.snapshot) prepared.push(bumpSchemaVersion(ctx.db));
  try {
    const results = prepared.length === 1 ? [await prepared[0]!.all()] : await ctx.db.batch(prepared);
    return results.map((r) => r.results as Rows);
  } catch (err) {
    if ((err instanceof Error ? err.message : String(err)).includes(`CHECK constraint failed: ${FOREIGN_KEY_CONSTRAINT}`)) {
      throw await foreignKeyError(ctx, batch);
    }
    throw translateItemError(err);
  } finally {
    if (batch.snapshot) invalidateSchema();
  }
}

/**
 * Which foreign key guard failed: SQLite only names the constraint. The only field guarded, or else
 * the first whose probe still fails now that the batch rolled back.
 */
async function foreignKeyError(ctx: ItemsContext, batch: Batch): Promise<CirrusError> {
  const fields = new Map(batch.foreignKeys.map((g) => [`${g.collection}.${g.field}`, g]));
  if (fields.size === 1) {
    const [g] = fields.values();
    return invalidForeignKey(g!.collection, g!.field);
  }
  const probes = batch.foreignKeys.filter((g) => g.probe);
  if (probes.length) {
    const results = await ctx.db.batch(probes.map((g) => ctx.db.prepare(g.probe!.sql).bind(...g.probe!.params)));
    const i = results.findIndex((r) => r.results.length > 0);
    if (i >= 0) return invalidForeignKey(probes[i]!.collection, probes[i]!.field);
  }
  return invalidForeignKey();
}

const keysOf = (ctx: ItemsContext, rows: Rows | undefined): Key[] => [...new Set((rows ?? []).map((r) => r[ctx.info.primary] as Key))];

const all = (filter: Filter | null = null): RowQuery => ({ filter, search: null, sort: null, limit: -1, offset: 0 });

/** A scope that knows the request's related collections, so relational filters (permissions' too) compile. */
const scoped = (ctx: ItemsContext, scope: Scope = {}): Scope => ({ related: ctx.related, ...scope });

// Reads ------------------------------------------------------------------------------------------

export type ReadResult = { data: Item[]; meta?: Record<string, number> };

function readPlan(ctx: ItemsContext, q: Query, restrict: Filter | null = null): { plan: ReadPlan; scope: Scope } {
  const scope = scoped(ctx, { access: ctx.access('read'), restrict });
  return { plan: planRead(ctx.info, q, scope, { limitDefault: ctx.limits.limitDefault }), scope };
}

/**
 * Throws the errors a read with this query would, so writes can check the response query first.
 * Without read permission there is nothing to check: the write answers 204, as in Directus.
 */
export const validateQuery = (ctx: ItemsContext, q: Query) => {
  if (ctx.can('read')) readPlan(ctx, q);
};

async function readRows(ctx: ItemsContext, q: Query, restrict: Filter | null = null): Promise<ReadResult & { plan: ReadPlan }> {
  const { plan, scope } = readPlan(ctx, q, restrict);
  const counts = q.meta.map((m) =>
    m === 'total_count' ? countItems(ctx.info, null, null, scoped(ctx, { access: scope.access })) : countItems(ctx.info, q.filter, q.search, scope),
  );
  const batch = new Batch();
  batch.add(ctx, ...plan.statements, ...counts);
  const results = await run(ctx, batch);
  const n = plan.statements.length;
  const data = plan.assemble(results.slice(0, n), presenter(ctx.req.schema));
  if (q.meta.length === 0) return { data, plan };
  return { data, plan, meta: Object.fromEntries(q.meta.map((m, i) => [m, results[n + i]![0]!.count as number])) };
}

export async function readByQuery(ctx: ItemsContext, q: Query): Promise<ReadResult> {
  const { data, meta } = await readRows(ctx, q);
  return meta ? { data, meta } : { data };
}

export async function readOne(ctx: ItemsContext, key: Key, q: Query): Promise<Item> {
  const { data } = await readRows(ctx, { ...q, limit: 1, offset: 0, meta: [] }, { [ctx.info.primary]: { _eq: key } });
  if (!data[0]) throw forbidden();
  return data[0];
}

export async function readMany(ctx: ItemsContext, keys: Key[], q: Query): Promise<Item[]> {
  if (keys.length === 0) return [];
  const { data } = await readRows(ctx, { ...q, limit: -1, offset: 0, meta: [] }, { [ctx.info.primary]: { _in: keys } });
  return data;
}

/** A singleton's one item, or its field defaults while it has none (or none is visible). */
export async function readSingleton(ctx: ItemsContext, q: Query): Promise<{ data: Item; meta?: Record<string, number> }> {
  const { data, meta, plan } = await readRows(ctx, { ...q, limit: 1, offset: 0 });
  return {
    data: data[0] ?? { ...defaultItem(ctx, plan.fields), ...plan.empty },
    ...(meta ? { meta } : {}),
  };
}

// Payloads ---------------------------------------------------------------------------------------

/** Nested writes may go this many items deep. */
const MAX_NESTING = 5;

type Prepared = {
  row: Row;
  nested: Nested[];
  /** M2O fields set to keys that must reference items. */
  refs: string[];
  /** Statements were added for related items (nested M2O writes). */
  related: boolean;
  access: Access | null;
};

type WriteOptions = {
  /** How deep in nested writes the item is: 1 for the request's own items. */
  depth: number;
  /** Fields that link a nested item to its parent: no foreign key check. */
  trusted?: ReadonlySet<string>;
};

/** Directus' reason for payload fields the request may not write. */
function deniedFields(ctx: ItemsContext, fields: string[]) {
  const c = ctx.collection.collection;
  const list = fields.map((f) => `"${f}"`).join(', ');
  return forbidden(
    fields.length === 1
      ? `You don't have permission to access field ${list} in collection "${c}" or it does not exist.`
      : `You don't have permission to access fields ${list} in collection "${c}" or they do not exist.`,
  );
}

/**
 * A payload as it will be written, following Directus' processPayload: the fields it sets must be
 * granted, presets fill in what it leaves out, system collections check and normalize it, the
 * items its M2O objects describe are written (statements added to the batch, before the item's
 * own), field rules (meta.validation) and the permissions' validation must pass, and then secrets
 * are hashed.
 */
async function prepare(batch: Batch, ctx: ItemsContext, body: unknown, action: 'create' | 'update', key: Key | null, opts: WriteOptions): Promise<Prepared> {
  if (!isPlainObject(body)) throw invalidPayload('An item must be an object');
  if (opts.depth > MAX_NESTING) throw invalidPayload('Nested writes are nested too deeply');
  const access = ctx.access(action);
  let payload: Record<string, unknown> = body;

  if (access) {
    if (!access.allFields) {
      const denied = Object.keys(payload).filter((k) => !access.fields.has(k));
      if (denied.length) throw deniedFields(ctx, denied);
    }
    payload = { ...access.presets, ...payload };
  }
  if (action === 'create' && ctx.system) payload = { ...ctx.system.defaults, ...payload };
  if (ctx.system?.normalize) payload = ctx.system.normalize(payload, { action, key, schema: ctx.req.schema });

  const { row, nested, m2o, refs, secrets } = await toRow(ctx, payload, action, opts.trusted);
  for (const n of m2o) {
    const written = await planM2O(batch, ctx, n, opts.depth);
    row[n.field.field] = written.key;
    if (written.linked && checked(n.relation)) refs.push(n.field.field);
  }
  validate(ctx, access, row);
  await hashSecrets(ctx, row, secrets);
  return { row, nested, refs, related: m2o.length > 0, access };
}

function validate(ctx: ItemsContext, access: Access | null, row: Row) {
  const values: Record<string, DbValue> = {};
  const pending = new Set<string>();
  for (const [name, v] of Object.entries(row)) {
    if (isKeyRef(v)) pending.add(name);
    else values[name] = v;
  }
  const rules: Filter[] = [];
  for (const f of ctx.collection.fields) {
    if (!isEmptyFilter(f.meta.validation)) rules.push(parseFilter(f.meta.validation!, ctx.vars));
  }
  if (access?.validation) rules.push(access.validation);
  const errors = rules.flatMap((rule) => validatePayload(ctx.info, rule, values, pending));
  if (errors.length) {
    throw new CirrusErrors(errors.map((e) => new CirrusError('FAILED_VALIDATION', validationMessage(e), { ...e, path: [] })));
  }
}

/** The condition rows must meet for this write: the row filter, and the conditions of the fields it sets. */
const conditionFor = (p: Prepared): Filter | null =>
  p.access ? writeCondition(p.access, [...Object.keys(p.row), ...p.nested.map((n) => n.field.field)]) : null;

const andFilters = (...filters: Array<Filter | null>): Filter | null => {
  const list = filters.filter((f): f is Filter => !isEmptyFilter(f));
  return list.length === 0 ? null : list.length === 1 ? list[0]! : { _and: list };
};

/**
 * The scope of a write by query: the rows the action allows, and a query that may use the fields
 * the request may read (delete permissions usually grant no fields at all).
 */
function queryScope(ctx: ItemsContext, access: Access | null): Scope {
  if (!access) return scoped(ctx);
  const fields = ctx.can('read') ? ctx.access('read')!.fields : new Map();
  return scoped(ctx, { access: { ...access, fields } });
}

/** UPDATE, or just look the rows up when there is nothing to set. */
const update = (ctx: ItemsContext, row: Row, target: Target, scope: Scope = {}) =>
  Object.keys(row).length ? updateItems(ctx.info, row, target, scoped(ctx, scope)) : selectKeys(ctx.info, target, scoped(ctx, scope));

const unchangedKey = () => invalidPayload("The primary key can't be changed");

/**
 * Guards that the keys M2O fields are set to reference items (ADR-021): one statement per field,
 * for every key the items set it to. Keys of items the batch creates need none.
 */
function guardKeys(batch: Batch, ctx: ItemsContext, prepared: readonly Prepared[]) {
  const keys = new Map<string, Set<Key>>();
  for (const p of prepared) {
    for (const field of p.refs) {
      const v = p.row[field];
      if (v === null || v === undefined || isKeyRef(v)) continue;
      let set = keys.get(field);
      if (!set) keys.set(field, (set = new Set()));
      set.add(v);
    }
  }
  for (const [field, set] of keys) {
    const relation = m2oOf(ctx.req.schema, ctx.collection.collection, field)!;
    const g = foreignKeyGuard(ctx.related.collection(relation.related), [...set]);
    if (!g) continue;
    batch.add(ctx, g.guard);
    batch.foreignKeys.push({ collection: ctx.collection.collection, field, probe: g.probe });
  }
}

/**
 * The key a new item gets, which nested writes need before its insert has run: the one its row
 * sets, or for an auto-increment key a slot it is stashed in right after the insert.
 */
function newKey(batch: Batch, ctx: ItemsContext, row: Row): Key | KeyRef {
  const key = row[ctx.info.primary];
  if (key !== null && key !== undefined && !isKeyRef(key)) return key;
  if (ctx.collection.fields.find((f) => f.field === ctx.info.primary)?.column?.autoIncrement) return { slot: batch.slot() };
  throw invalidPayload('Nested writes need the primary key of the new item');
}

// Writes -----------------------------------------------------------------------------------------

export async function createMany(ctx: ItemsContext, bodies: unknown[]): Promise<Key[]> {
  const batch = new Batch();
  const prepared: Prepared[] = [];
  for (const body of bodies) prepared.push(await prepare(batch, ctx, body, 'create', null, { depth: 1 }));
  guardKeys(batch, ctx, prepared);

  const inserts: number[] = [];
  const later: Array<{ key: Key | KeyRef; nested: Nested[] }> = [];
  let group: Row[] = [];
  const flush = () => {
    if (group.length) inserts.push(...batch.add(ctx, ...insertItems(ctx.info, group)));
    group = [];
  };
  for (const p of prepared) {
    if (p.nested.length === 0) {
      group.push(p.row);
      continue;
    }
    const key = newKey(batch, ctx, p.row);
    if (isKeyRef(key)) {
      // Its key is known once it is inserted: on its own, then stashed.
      flush();
      inserts.push(...batch.add(ctx, ...insertItems(ctx.info, [p.row])));
      batch.add(ctx, stashNewKey(ctx.info, key.slot));
    } else {
      group.push(p.row);
    }
    later.push({ key, nested: p.nested });
  }
  flush();
  for (const { key, nested } of later) await planNested(batch, ctx, key, nested, { created: true, depth: 1 });

  const results = await run(ctx, batch);
  return inserts.flatMap((i) => keysOf(ctx, results[i]));
}

export async function updateOne(ctx: ItemsContext, key: Key, body: unknown): Promise<Key> {
  const batch = new Batch();
  const p = await prepare(batch, ctx, body, 'update', key, { depth: 1 });
  const pk = ctx.info.primary;
  if (pk in p.row) {
    if (p.row[pk] !== key) throw unchangedKey();
    delete p.row[pk];
  }
  const condition = conditionFor(p);
  // With permissions or nested writes, check the item first; plain admin updates just report it missing.
  if (p.access || p.nested.length || p.related) batch.add(ctx, guardItems(ctx.info, { key }, condition, scoped(ctx)));
  guardKeys(batch, ctx, [p]);
  const [changed] = batch.add(ctx, update(ctx, p.row, { key }, { restrict: condition }));
  if (p.nested.length) await planNested(batch, ctx, key, p.nested, { created: false, depth: 1 });
  const results = await run(ctx, batch);
  // Directus answers FORBIDDEN for items that don't exist.
  if (results[changed!]!.length === 0) throw forbidden();
  return key;
}

/**
 * The same changes to several items, by keys or by query. Admins skip items that don't exist;
 * otherwise every key must exist and be writable, or nothing is written (Directus validateAccess).
 */
export async function updateMany(ctx: ItemsContext, target: { keys: Key[] } | { query: RowQuery }, body: unknown): Promise<Key[]> {
  const batch = new Batch();
  const p = await prepare(batch, ctx, body, 'update', null, { depth: 1 });
  if (ctx.info.primary in p.row) throw unchangedKey();
  if ('keys' in target && target.keys.length === 0) return [];
  if ('query' in target && p.nested.length) throw invalidPayload('Nested writes need keys, not a query');

  const condition = conditionFor(p);
  let changed: number;
  if ('keys' in target) {
    if (p.access || p.nested.length || p.related) batch.add(ctx, guardItems(ctx.info, target, condition, scoped(ctx)));
    guardKeys(batch, ctx, [p]);
    [changed] = batch.add(ctx, update(ctx, p.row, target, { restrict: condition })) as [number];
    for (const key of target.keys) await planNested(batch, ctx, key, p.nested, { created: false, depth: 1 });
  } else {
    // The query selects within the row filter; every selected row must also allow these fields.
    const scope = queryScope(ctx, p.access);
    batch.add(ctx, guardItems(ctx.info, target, condition, scope));
    guardKeys(batch, ctx, [p]);
    [changed] = batch.add(ctx, update(ctx, p.row, target, scope)) as [number];
  }
  const results = await run(ctx, batch);
  return keysOf(ctx, results[changed]);
}

/** Different changes per item; each item carries its primary key. */
export async function updateBatch(ctx: ItemsContext, items: unknown[]): Promise<Key[]> {
  const pk = ctx.info.primary;
  const batch = new Batch();
  const changed: number[] = [];
  for (const item of items) {
    if (!isPlainObject(item)) throw invalidPayload('An item must be an object');
    if (item[pk] === undefined || item[pk] === null || item[pk] === '') throw invalidPayload('Item in update misses primary key');
    const key = parseKey(ctx, item[pk]);
    const { [pk]: _, ...changes } = item;
    const p = await prepare(batch, ctx, changes, 'update', key, { depth: 1 });
    const condition = conditionFor(p);
    if (p.access || p.nested.length || p.related) batch.add(ctx, guardItems(ctx.info, { key }, condition, scoped(ctx)));
    guardKeys(batch, ctx, [p]);
    changed.push(...batch.add(ctx, update(ctx, p.row, { key }, { restrict: condition })));
    if (p.nested.length) await planNested(batch, ctx, key, p.nested, { created: false, depth: 1 });
  }
  const results = await run(ctx, batch);
  return [...new Set(changed.flatMap((i) => keysOf(ctx, results[i])))];
}

export async function deleteOne(ctx: ItemsContext, key: Key): Promise<void> {
  const access = ctx.access('delete');
  const batch = new Batch();
  const deleted = planDelete(batch, ctx, { key }, scoped(ctx, { restrict: access?.filter ?? null }));
  const results = await run(ctx, batch);
  if (results[deleted]!.length === 0) throw forbidden();
}

export async function deleteMany(ctx: ItemsContext, target: { keys: Key[] } | { query: RowQuery }): Promise<void> {
  if ('keys' in target && target.keys.length === 0) return;
  const access = ctx.access('delete');
  const batch = new Batch();
  if ('keys' in target) {
    if (access) batch.add(ctx, guardItems(ctx.info, target, access.filter, scoped(ctx)));
    planDelete(batch, ctx, target, scoped(ctx, { restrict: access?.filter ?? null }));
  } else {
    planDelete(batch, ctx, target, queryScope(ctx, access));
  }
  await run(ctx, batch);
}

/** Update the singleton's item, creating it the first time. */
export async function upsertSingleton(ctx: ItemsContext, body: unknown): Promise<Key> {
  const batch = new Batch();
  batch.add(ctx, selectKeys(ctx.info, { query: { ...all(), limit: 1 } }));
  const [existing] = await run(ctx, batch);
  const key = existing![0]?.[ctx.info.primary] as Key | undefined;
  if (key !== undefined) return updateOne(ctx, key, body);
  const [created] = await createMany(ctx, [body]);
  return created!;
}

// Deletes and on_delete --------------------------------------------------------------------------

/** What a delete needs to know about a collection. */
type Deletable = Owner & { req: RequestContext; info: QueryCollection };

/** Cascades may go this many relations deep; deeper references fail the delete instead. */
const MAX_CASCADE = 10;

/**
 * Delete the target rows and apply the on_delete of the relations pointing at them (ADR-021), as
 * a database would: the rows' keys are stashed first, so every action and the delete itself see
 * the same rows; RESTRICT fails when anything still points at them, CASCADE deletes what does
 * (whole subtrees for self-references), SET NULL and SET DEFAULT reset those keys, and NO ACTION
 * fails if references remain once the other actions have run. Like a database's, these actions
 * don't check the request's permissions. Returns the position of the statement returning the
 * deleted keys.
 */
function planDelete(batch: Batch, d: Deletable, target: Target, scope: Scope, depth = 0): number {
  const { schema } = d.req;
  const name = d.info.collection;
  const effects = relationsTo(schema, name).filter((r) => checked(r) && queryInfo(schema, r.collection));
  if (effects.length === 0) return batch.add(d, deleteItems(d.info, target, scope))[0]!;

  const slot = batch.slot();
  batch.add(d, stashKeys(d.info, target, scope, slot));
  const subtree = effects.filter((r) => r.collection === name && r.onDelete === 'CASCADE').map((r) => r.field);
  if (subtree.length) batch.add(d, stashClosure(d.info, slot, subtree));

  const many = (r: RelationRecord): Deletable => ({ req: d.req, info: queryInfo(schema, r.collection)!, system: null });
  const refuse = (r: RelationRecord) => {
    batch.add(d, referenceGuard(many(r).info, r.field, slot, r.collection === name));
    batch.foreignKeys.push({ collection: r.collection, field: r.field, probe: null });
  };
  const refs = (r: RelationRecord): Target => ({ refs: { field: r.field, slot } });

  for (const r of effects) if (r.onDelete === 'RESTRICT') refuse(r);
  for (const r of effects) {
    if (r.onDelete === 'CASCADE' && r.collection !== name) {
      if (depth < MAX_CASCADE) planDelete(batch, many(r), refs(r), {}, depth + 1);
      else refuse(r);
    } else if (r.onDelete === 'SET NULL' || r.onDelete === 'SET DEFAULT') {
      const c = many(r);
      batch.add(c, updateItems(c.info, { [r.field]: r.onDelete === 'SET NULL' ? null : defaultKey(schema, r) }, refs(r)));
    }
  }
  for (const r of effects) if (r.onDelete === 'NO ACTION') refuse(r);
  return batch.add(d, deleteItems(d.info, { slot }))[0]!;
}

/** The default of an M2O field, for ON DELETE SET DEFAULT; null without one. */
function defaultKey(schema: Schema, r: RelationRecord): DbValue {
  const f = anyCollection(schema, r.collection)?.fields.find((x) => x.field === r.field);
  const d = f?.column?.defaultValue ?? null;
  if (!f || d === null || d === NOW) return null;
  try {
    return toDbValue(f.type, d);
  } catch {
    return null;
  }
}

// Nested writes ----------------------------------------------------------------------------------

type NestedOptions = { created: boolean; depth: number };

/**
 * Directus' nested M2O writes: an object with the related key updates that item (only the key:
 * links it), one without creates it. Its statements go before the parent's; returns the key for
 * the parent's field, and whether it only links an existing item (whose key must be checked).
 */
async function planM2O(batch: Batch, parent: ItemsContext, n: Nested & { value: Record<string, unknown> }, depth: number): Promise<{ key: Key | KeyRef; linked: boolean }> {
  const child = await relatedContext(parent.req, n.relation.related);
  const pk = child.info.primary;
  const raw = n.value[pk];
  if (raw !== undefined && raw !== null && raw !== '') {
    const key = parseKey(child, raw);
    const { [pk]: _, ...data } = n.value;
    if (Object.keys(data).length === 0) return { key, linked: true };
    await planChildUpdate(batch, child, key, data, null, { depth: depth + 1 });
    return { key, linked: false };
  }
  return { key: (await planChildCreate(batch, child, n.value, { depth: depth + 1 }, true))!, linked: false };
}

/**
 * Directus' nested O2M writes: an array replaces the related items (primary keys link existing
 * items, objects with a key update them, objects without one create them; items no longer listed
 * are deselected: deleted or unlinked, as the relation says), or `{ create, update, delete }`
 * changes them one by one. Each related write is checked against the related collection's
 * permissions. M2M is the same on the junction collection, whose items' M2O objects reach the
 * other side.
 */
async function planNested(batch: Batch, parent: ItemsContext, parentKey: Key | KeyRef, nested: Nested[], opts: NestedOptions) {
  for (const { field, relation, value } of nested) {
    if (value === null) continue;
    const child = await relatedContext(parent.req, relation.collection);
    const fk = relation.field;
    const pk = child.info.primary;
    const link = { [fk]: parentKey };
    const next: WriteOptions = { depth: opts.depth + 1, trusted: new Set([fk]) };

    if (Array.isArray(value)) {
      const keep: Key[] = [];
      const ops: Array<() => Promise<unknown>> = [];
      for (const entry of value) {
        if (typeof entry === 'string' || typeof entry === 'number') {
          const key = parseKey(child, entry);
          keep.push(key);
          ops.push(() => planChildUpdate(batch, child, key, link, null, next));
        } else if (isPlainObject(entry) && entry[pk] !== undefined && entry[pk] !== null && entry[pk] !== '') {
          const key = parseKey(child, entry[pk]);
          keep.push(key);
          const { [pk]: _, ...data } = entry;
          ops.push(() => planChildUpdate(batch, child, key, { ...data, ...link }, null, next));
        } else if (isPlainObject(entry)) {
          ops.push(() => planChildCreate(batch, child, { ...entry, ...link }, next, false));
        } else {
          throw invalidPayload(`"${field.field}" must be a list of items or primary keys`);
        }
      }
      if (!opts.created) await planDeselect(batch, child, fk, parentKey as Key, relation.deselect, keep.length ? { [pk]: { _nin: keep } } : null);
      for (const op of ops) await op();
      continue;
    }

    if (!isPlainObject(value)) throw invalidPayload(`"${field.field}" must be an array or an object with "create", "update" and "delete"`);
    const lists = { create: value.create ?? [], update: value.update ?? [], delete: value.delete ?? [] };
    for (const [name, list] of Object.entries(lists)) {
      if (!Array.isArray(list)) throw invalidPayload(`"${field.field}.${name}" must be an array`);
    }
    for (const entry of lists.create as unknown[]) {
      if (!isPlainObject(entry)) throw invalidPayload(`"${field.field}.create" must be a list of items`);
      await planChildCreate(batch, child, { ...entry, ...link }, next, false);
    }
    for (const entry of lists.update as unknown[]) {
      if (!isPlainObject(entry) || entry[pk] === undefined || entry[pk] === null) {
        throw invalidPayload(`"${field.field}.update" must be a list of items with their primary key`);
      }
      // Only items that belong to the parent can be updated through it; a new parent has none yet.
      if (opts.created) throw forbidden();
      const { [pk]: key, ...data } = entry;
      await planChildUpdate(batch, child, parseKey(child, key), { ...data, ...link }, link, next);
    }
    const removed = (lists.delete as unknown[]).map((k) => parseKey(child, k));
    if (removed.length && !opts.created) await planDeselect(batch, child, fk, parentKey as Key, relation.deselect, { [pk]: { _in: removed } });
  }
}

/** Create a related item. Returns its key when `needKey` or its own nested writes need it. */
async function planChildCreate(batch: Batch, ctx: ItemsContext, payload: Record<string, unknown>, opts: WriteOptions, needKey: boolean): Promise<Key | KeyRef | null> {
  const p = await prepare(batch, ctx, payload, 'create', null, opts);
  guardKeys(batch, ctx, [p]);
  const key = needKey || p.nested.length ? newKey(batch, ctx, p.row) : null;
  batch.add(ctx, ...insertItems(ctx.info, [p.row]));
  if (isKeyRef(key)) batch.add(ctx, stashNewKey(ctx.info, key.slot));
  if (p.nested.length) await planNested(batch, ctx, key!, p.nested, { created: true, depth: opts.depth });
  return key;
}

/** Update a related item; it must exist and be writable (and, with `belongsTo`, be linked already). */
async function planChildUpdate(batch: Batch, ctx: ItemsContext, key: Key, payload: Record<string, unknown>, belongsTo: Filter | null, opts: WriteOptions) {
  const p = await prepare(batch, ctx, payload, 'update', key, opts);
  if (ctx.info.primary in p.row) throw unchangedKey();
  const condition = conditionFor(p);
  batch.add(ctx, guardItems(ctx.info, { key }, andFilters(condition, belongsTo), scoped(ctx)));
  guardKeys(batch, ctx, [p]);
  batch.add(ctx, update(ctx, p.row, { key }, { restrict: condition }));
  if (p.nested.length) await planNested(batch, ctx, key, p.nested, { created: false, depth: opts.depth });
}

/** Unlink related items of the parent (matching `which`): delete them, or set their foreign key to null. */
async function planDeselect(batch: Batch, ctx: ItemsContext, fk: string, parentKey: Key, action: 'delete' | 'nullify', which: Filter | null) {
  const target = { query: all() };
  const scope = scoped(ctx, { restrict: andFilters({ [fk]: { _eq: parentKey } }, which) });
  if (action === 'delete') {
    const access = ctx.access('delete');
    if (access) batch.add(ctx, guardItems(ctx.info, target, access.filter, scope));
    planDelete(batch, ctx, target, scope);
    return;
  }
  const p = await prepare(batch, ctx, { [fk]: null }, 'update', null, { depth: 1 });
  batch.add(ctx, guardItems(ctx.info, target, conditionFor(p), scope));
  batch.add(ctx, update(ctx, p.row, target, scope));
}
