import {
  type Access,
  countItems,
  deleteItems,
  type Filter,
  guardItems,
  insertItems,
  isEmptyFilter,
  parseFilter,
  type Query,
  type Row,
  type RowQuery,
  type Scope,
  selectItems,
  selectKeys,
  type Statement,
  type Target,
  updateItems,
  validatePayload,
  validationMessage,
  writeCondition,
} from '@cirrus/query';
import { CirrusError, CirrusErrors, forbidden, invalidPayload, isPlainObject } from '@cirrus/shared';
import { bumpSchemaVersion, invalidateSchema } from '../schema/store.ts';
import { type ItemsContext, itemsContext } from './context.ts';
import { translateItemError } from './errors.ts';
import { defaultItem, hashSecrets, type Item, type Key, type Nested, parseKey, toItems, toRow } from './payload.ts';

/**
 * Items CRUD (spec §8), following Directus' ItemsService, with permissions (spec §10). Every call
 * is one D1 round trip: reads batch the data and count queries, writes run as one batch, so each
 * write is atomic. Writes that must check rows first (permissions, nested writes) start with
 * guard statements, which abort the whole batch when a row doesn't qualify.
 */

type Rows = Array<Record<string, unknown>>;

/** The statements of one request, run as one D1 batch. */
class Batch {
  readonly statements: Statement[] = [];
  /** It writes roles, policies, access or permissions: replace schema_version too. */
  snapshot = false;

  /** Add statements for a collection; returns their positions (for their results). */
  add(ctx: ItemsContext, ...statements: Array<Statement | null>): number[] {
    if (ctx.system?.snapshot) this.snapshot = true;
    const positions: number[] = [];
    for (const s of statements) if (s) positions.push(this.statements.push(s) - 1);
    return positions;
  }
}

async function run(ctx: ItemsContext, batch: Batch): Promise<Rows[]> {
  if (batch.statements.length === 0) return [];
  const prepared = batch.statements.map((s) => ctx.db.prepare(s.sql).bind(...s.params));
  if (batch.snapshot) prepared.push(bumpSchemaVersion(ctx.db));
  try {
    const results = prepared.length === 1 ? [await prepared[0]!.all()] : await ctx.db.batch(prepared);
    return results.map((r) => r.results as Rows);
  } catch (err) {
    throw translateItemError(err);
  } finally {
    if (batch.snapshot) invalidateSchema();
  }
}

const keysOf = (ctx: ItemsContext, rows: Rows | undefined): Key[] => [...new Set((rows ?? []).map((r) => r[ctx.info.primary] as Key))];

const all = (filter: Filter | null = null): RowQuery => ({ filter, search: null, sort: null, limit: -1, offset: 0 });

// Reads ------------------------------------------------------------------------------------------

export type ReadResult = { data: Item[]; meta?: Record<string, number> };

/**
 * Throws the errors a read with this query would, so writes can check the response query first.
 * Without read permission there is nothing to check: the write answers 204, as in Directus.
 */
export const validateQuery = (ctx: ItemsContext, q: Query) => {
  if (ctx.can('read')) selectItems(ctx.info, q, { access: ctx.access('read') });
};

async function readRows(ctx: ItemsContext, q: Query, restrict: Filter | null = null): Promise<ReadResult> {
  const scope: Scope = { access: ctx.access('read'), restrict };
  const select = selectItems(ctx.info, q, scope);
  const counts = q.meta.map((m) =>
    m === 'total_count' ? countItems(ctx.info, null, null, { access: scope.access }) : countItems(ctx.info, q.filter, q.search, scope),
  );
  const batch = new Batch();
  batch.add(ctx, select, ...counts);
  const [rows, ...countRows] = await run(ctx, batch);
  const data = toItems(ctx, select.fields, rows!);
  if (q.meta.length === 0) return { data };
  return { data, meta: Object.fromEntries(q.meta.map((m, i) => [m, countRows[i]![0]!.count as number])) };
}

export const readByQuery = (ctx: ItemsContext, q: Query) => readRows(ctx, q);

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
  const { data, meta } = await readRows(ctx, { ...q, limit: 1, offset: 0 });
  return {
    data: data[0] ?? defaultItem(ctx, selectItems(ctx.info, q, { access: ctx.access('read') }).fields),
    ...(meta ? { meta } : {}),
  };
}

// Payloads ---------------------------------------------------------------------------------------

type Prepared = { row: Row; nested: Nested[]; access: Access | null };

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
 * granted, presets fill in what it leaves out, system collections check and normalize it, field
 * rules (meta.validation) and the permissions' validation must pass, and then secrets are hashed.
 */
async function prepare(ctx: ItemsContext, body: unknown, action: 'create' | 'update', key: Key | null): Promise<Prepared> {
  if (!isPlainObject(body)) throw invalidPayload('An item must be an object');
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

  const { row, nested, secrets } = await toRow(ctx, payload, action);
  validate(ctx, access, row);
  await hashSecrets(ctx, row, secrets);
  return { row, nested, access };
}

function validate(ctx: ItemsContext, access: Access | null, row: Row) {
  const rules: Filter[] = [];
  for (const f of ctx.collection.fields) {
    if (!isEmptyFilter(f.meta.validation)) rules.push(parseFilter(f.meta.validation!, ctx.vars));
  }
  if (access?.validation) rules.push(access.validation);
  const errors = rules.flatMap((rule) => validatePayload(ctx.info, rule, row));
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
  if (!access) return {};
  const fields = ctx.can('read') ? ctx.access('read')!.fields : new Map();
  return { access: { ...access, fields } };
}

/** UPDATE, or just look the rows up when there is nothing to set. */
const update = (ctx: ItemsContext, row: Row, target: Target, scope: Scope = {}) =>
  Object.keys(row).length ? updateItems(ctx.info, row, target, scope) : selectKeys(ctx.info, target, scope);

const unchangedKey = () => invalidPayload("The primary key can't be changed");

// Writes -----------------------------------------------------------------------------------------

export async function createMany(ctx: ItemsContext, bodies: unknown[]): Promise<Key[]> {
  const batch = new Batch();
  const prepared: Prepared[] = [];
  for (const body of bodies) prepared.push(await prepare(ctx, body, 'create', null));
  const inserts = batch.add(ctx, ...insertItems(ctx.info, prepared.map((p) => p.row)));
  for (const p of prepared) {
    if (p.nested.length) await planNested(batch, ctx, newKey(ctx, p.row), p.nested, { created: true, depth: 1 });
  }
  const results = await run(ctx, batch);
  return inserts.flatMap((i) => keysOf(ctx, results[i]));
}

/** The primary key a create sets; nested writes need it before the insert has run. */
function newKey(ctx: ItemsContext, row: Row): Key {
  const key = row[ctx.info.primary];
  if (key === null || key === undefined) throw invalidPayload('Nested writes need the primary key of the new item');
  return key;
}

export async function updateOne(ctx: ItemsContext, key: Key, body: unknown): Promise<Key> {
  const p = await prepare(ctx, body, 'update', key);
  const pk = ctx.info.primary;
  if (pk in p.row) {
    if (p.row[pk] !== key) throw unchangedKey();
    delete p.row[pk];
  }
  const batch = new Batch();
  const condition = conditionFor(p);
  // With permissions or nested writes, check the item first; plain admin updates just report it missing.
  if (p.access || p.nested.length) batch.add(ctx, guardItems(ctx.info, { key }, condition));
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
  const p = await prepare(ctx, body, 'update', null);
  if (ctx.info.primary in p.row) throw unchangedKey();
  if ('keys' in target && target.keys.length === 0) return [];
  if ('query' in target && p.nested.length) throw invalidPayload('Nested writes need keys, not a query');

  const batch = new Batch();
  const condition = conditionFor(p);
  let changed: number;
  if ('keys' in target) {
    if (p.access || p.nested.length) batch.add(ctx, guardItems(ctx.info, target, condition));
    [changed] = batch.add(ctx, update(ctx, p.row, target, { restrict: condition })) as [number];
    for (const key of target.keys) await planNested(batch, ctx, key, p.nested, { created: false, depth: 1 });
  } else {
    // The query selects within the row filter; every selected row must also allow these fields.
    const scope = queryScope(ctx, p.access);
    batch.add(ctx, guardItems(ctx.info, target, condition, scope));
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
    const p = await prepare(ctx, changes, 'update', key);
    const condition = conditionFor(p);
    if (p.access || p.nested.length) batch.add(ctx, guardItems(ctx.info, { key }, condition));
    changed.push(...batch.add(ctx, update(ctx, p.row, { key }, { restrict: condition })));
    if (p.nested.length) await planNested(batch, ctx, key, p.nested, { created: false, depth: 1 });
  }
  const results = await run(ctx, batch);
  return [...new Set(changed.flatMap((i) => keysOf(ctx, results[i])))];
}

export async function deleteOne(ctx: ItemsContext, key: Key): Promise<void> {
  const access = ctx.access('delete');
  const batch = new Batch();
  const [deleted] = batch.add(ctx, deleteItems(ctx.info, { key }, { restrict: access?.filter ?? null }));
  const results = await run(ctx, batch);
  if (results[deleted!]!.length === 0) throw forbidden();
}

export async function deleteMany(ctx: ItemsContext, target: { keys: Key[] } | { query: RowQuery }): Promise<void> {
  if ('keys' in target && target.keys.length === 0) return;
  const access = ctx.access('delete');
  const batch = new Batch();
  if ('keys' in target) {
    if (access) batch.add(ctx, guardItems(ctx.info, target, access.filter));
    batch.add(ctx, deleteItems(ctx.info, target, { restrict: access?.filter ?? null }));
  } else {
    batch.add(ctx, deleteItems(ctx.info, target, queryScope(ctx, access)));
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

// Nested O2M writes ------------------------------------------------------------------------------

const MAX_NESTING = 5;

type NestedOptions = { created: boolean; depth: number };

/**
 * Directus' nested O2M writes, on the aliases that support them: an array replaces the related
 * items (primary keys link existing items, objects with a key update them, objects without one
 * create them; items no longer listed are deselected), or `{ create, update, delete }` changes
 * them one by one. Each related write is checked against the related collection's permissions.
 */
async function planNested(batch: Batch, parent: ItemsContext, parentKey: Key, nested: Nested[], opts: NestedOptions) {
  if (opts.depth > MAX_NESTING) throw invalidPayload('Nested writes are nested too deeply');
  for (const { field, value } of nested) {
    if (value === null) continue;
    const child = await itemsContext(parent.req, field.o2m.collection, { system: true });
    const fk = field.o2m.field;
    const pk = child.info.primary;
    const link = { [fk]: parentKey };
    const next = { created: true, depth: opts.depth + 1 };

    if (Array.isArray(value)) {
      const keep: Key[] = [];
      const ops: Array<() => Promise<void>> = [];
      for (const entry of value) {
        if (typeof entry === 'string' || typeof entry === 'number') {
          const key = parseKey(child, entry);
          keep.push(key);
          ops.push(() => planChildUpdate(batch, child, key, link, null, { ...next, created: false }));
        } else if (isPlainObject(entry) && entry[pk] !== undefined && entry[pk] !== null && entry[pk] !== '') {
          const key = parseKey(child, entry[pk]);
          keep.push(key);
          const { [pk]: _, ...data } = entry;
          ops.push(() => planChildUpdate(batch, child, key, { ...data, ...link }, null, { ...next, created: false }));
        } else if (isPlainObject(entry)) {
          ops.push(() => planChildCreate(batch, child, { ...entry, ...link }, next));
        } else {
          throw invalidPayload(`"${field.field}" must be a list of items or primary keys`);
        }
      }
      if (!opts.created) await planDeselect(batch, child, fk, parentKey, field.o2m.deselect, keep.length ? { [pk]: { _nin: keep } } : null);
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
      await planChildCreate(batch, child, { ...entry, ...link }, next);
    }
    for (const entry of lists.update as unknown[]) {
      if (!isPlainObject(entry) || entry[pk] === undefined || entry[pk] === null) {
        throw invalidPayload(`"${field.field}.update" must be a list of items with their primary key`);
      }
      const { [pk]: key, ...data } = entry;
      // Only items that belong to the parent can be updated through it.
      await planChildUpdate(batch, child, parseKey(child, key), { ...data, ...link }, link, { ...next, created: false });
    }
    const removed = (lists.delete as unknown[]).map((k) => parseKey(child, k));
    if (removed.length) await planDeselect(batch, child, fk, parentKey, field.o2m.deselect, { [pk]: { _in: removed } });
  }
}

async function planChildCreate(batch: Batch, ctx: ItemsContext, payload: Record<string, unknown>, opts: NestedOptions) {
  const p = await prepare(ctx, payload, 'create', null);
  batch.add(ctx, ...insertItems(ctx.info, [p.row]));
  if (p.nested.length) await planNested(batch, ctx, newKey(ctx, p.row), p.nested, opts);
}

/** Update a related item; it must exist and be writable (and, with `belongsTo`, be linked already). */
async function planChildUpdate(
  batch: Batch,
  ctx: ItemsContext,
  key: Key,
  payload: Record<string, unknown>,
  belongsTo: Filter | null,
  opts: NestedOptions,
) {
  const p = await prepare(ctx, payload, 'update', key);
  if (ctx.info.primary in p.row) throw unchangedKey();
  const condition = conditionFor(p);
  batch.add(ctx, guardItems(ctx.info, { key }, andFilters(condition, belongsTo)));
  batch.add(ctx, update(ctx, p.row, { key }, { restrict: condition }));
  if (p.nested.length) await planNested(batch, ctx, key, p.nested, opts);
}

/** Unlink related items of the parent (matching `which`): delete them, or set their foreign key to null. */
async function planDeselect(batch: Batch, ctx: ItemsContext, fk: string, parentKey: Key, action: 'delete' | 'nullify', which: Filter | null) {
  const target = { query: all() };
  const scope: Scope = { restrict: andFilters({ [fk]: { _eq: parentKey } }, which) };
  if (action === 'delete') {
    const access = ctx.access('delete');
    if (access) batch.add(ctx, guardItems(ctx.info, target, access.filter, scope));
    batch.add(ctx, deleteItems(ctx.info, target, scope));
    return;
  }
  const p = await prepare(ctx, { [fk]: null }, 'update', null);
  batch.add(ctx, guardItems(ctx.info, target, conditionFor(p), scope));
  batch.add(ctx, update(ctx, p.row, target, scope));
}
