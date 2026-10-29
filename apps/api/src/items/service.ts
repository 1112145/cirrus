import {
  countItems,
  deleteItems,
  type Filter,
  insertItems,
  type Query,
  type Row,
  type RowQuery,
  selectItems,
  selectKeys,
  type Statement,
  type Target,
  updateItems,
} from '@cirrus/query';
import { forbidden, invalidPayload, isPlainObject } from '@cirrus/shared';
import type { ItemsContext } from './context.ts';
import { translateItemError } from './errors.ts';
import { defaultItem, type Item, type Key, parseKey, toItems, toRow } from './payload.ts';

/**
 * Items CRUD (spec §8), following Directus' ItemsService. Every call is one D1 round trip: reads
 * batch the data and count queries, writes run as one batch, so each write is atomic.
 */

type Rows = Array<Record<string, unknown>>;

async function exec(ctx: ItemsContext, statements: Statement[]): Promise<Rows[]> {
  if (statements.length === 0) return [];
  const prepared = statements.map((s) => ctx.db.prepare(s.sql).bind(...s.params));
  try {
    const results = prepared.length === 1 ? [await prepared[0]!.all()] : await ctx.db.batch(prepared);
    return results.map((r) => r.results as Rows);
  } catch (err) {
    throw translateItemError(err);
  }
}

const keysOf = (ctx: ItemsContext, rows: Rows): Key[] => [...new Set(rows.map((r) => r[ctx.info.primary] as Key))];

// Reads ------------------------------------------------------------------------------------------

export type ReadResult = { data: Item[]; meta?: Record<string, number> };

/** Throws the errors a read with this query would, so writes can check the response query first. */
export const validateQuery = (ctx: ItemsContext, q: Query) => void selectItems(ctx.info, q);

export async function readByQuery(ctx: ItemsContext, q: Query): Promise<ReadResult> {
  const select = selectItems(ctx.info, q);
  const counts = q.meta.map((m) => (m === 'total_count' ? countItems(ctx.info, null, null) : countItems(ctx.info, q.filter, q.search)));
  const [rows, ...countRows] = await exec(ctx, [select, ...counts]);
  const data = toItems(ctx, select.fields, rows!);
  if (q.meta.length === 0) return { data };
  return { data, meta: Object.fromEntries(q.meta.map((m, i) => [m, countRows[i]![0]!.count as number])) };
}

/** The query, restricted to rows matching `filter` as well. */
const restrict = (q: Query, filter: Filter): Query => ({ ...q, filter: q.filter ? { _and: [q.filter, filter] } : filter, meta: [] });

export async function readOne(ctx: ItemsContext, key: Key, q: Query): Promise<Item> {
  const { data } = await readByQuery(ctx, { ...restrict(q, { [ctx.info.primary]: { _eq: key } }), limit: 1, offset: 0 });
  if (!data[0]) throw forbidden();
  return data[0];
}

export async function readMany(ctx: ItemsContext, keys: Key[], q: Query): Promise<Item[]> {
  if (keys.length === 0) return [];
  const { data } = await readByQuery(ctx, { ...restrict(q, { [ctx.info.primary]: { _in: keys } }), limit: -1, offset: 0 });
  return data;
}

/** A singleton's one item, or its field defaults while it has none. */
export async function readSingleton(ctx: ItemsContext, q: Query): Promise<{ data: Item; meta?: Record<string, number> }> {
  const { data, meta } = await readByQuery(ctx, { ...q, limit: 1, offset: 0 });
  return { data: data[0] ?? defaultItem(ctx, selectItems(ctx.info, q).fields), ...(meta ? { meta } : {}) };
}

// Writes -----------------------------------------------------------------------------------------

export async function createMany(ctx: ItemsContext, bodies: unknown[]): Promise<Key[]> {
  const rows: Row[] = [];
  for (const body of bodies) rows.push(await toRow(ctx, body, 'create'));
  return (await exec(ctx, insertItems(ctx.info, rows))).flatMap((r) => keysOf(ctx, r));
}

/** UPDATE, or just look the rows up when there is nothing to set. */
const update = (ctx: ItemsContext, row: Row, target: Target) =>
  Object.keys(row).length ? updateItems(ctx.info, row, target) : selectKeys(ctx.info, target);

const unchangedKey = () => invalidPayload("The primary key can't be changed");

export async function updateOne(ctx: ItemsContext, key: Key, body: unknown): Promise<Key> {
  const row = await toRow(ctx, body, 'update');
  const pk = ctx.info.primary;
  if (pk in row) {
    if (row[pk] !== key) throw unchangedKey();
    delete row[pk];
  }
  const [changed] = await exec(ctx, [update(ctx, row, { key })]);
  // Directus answers FORBIDDEN for items that don't exist.
  if (changed!.length === 0) throw forbidden();
  return key;
}

/** The same changes to several items, by keys or by query. Items that don't exist are skipped. */
export async function updateMany(ctx: ItemsContext, target: { keys: Key[] } | { query: RowQuery }, body: unknown): Promise<Key[]> {
  const row = await toRow(ctx, body, 'update');
  if (ctx.info.primary in row) throw unchangedKey();
  if ('keys' in target && target.keys.length === 0) return [];
  const [changed] = await exec(ctx, [update(ctx, row, target)]);
  return keysOf(ctx, changed!);
}

/** Different changes per item; each item carries its primary key. */
export async function updateBatch(ctx: ItemsContext, items: unknown[]): Promise<Key[]> {
  const pk = ctx.info.primary;
  const statements: Statement[] = [];
  for (const item of items) {
    if (!isPlainObject(item)) throw invalidPayload('An item must be an object');
    if (item[pk] === undefined || item[pk] === null || item[pk] === '') throw invalidPayload('Item in update misses primary key');
    const key = parseKey(ctx, item[pk]);
    const { [pk]: _, ...changes } = item;
    statements.push(update(ctx, await toRow(ctx, changes, 'update'), { key }));
  }
  return keysOf(ctx, (await exec(ctx, statements)).flat());
}

export async function deleteOne(ctx: ItemsContext, key: Key): Promise<void> {
  const [deleted] = await exec(ctx, [deleteItems(ctx.info, { key })]);
  if (deleted!.length === 0) throw forbidden();
}

export async function deleteMany(ctx: ItemsContext, target: { keys: Key[] } | { query: RowQuery }): Promise<void> {
  if ('keys' in target && target.keys.length === 0) return;
  await exec(ctx, [deleteItems(ctx.info, target)]);
}

/** Update the singleton's item, creating it the first time. */
export async function upsertSingleton(ctx: ItemsContext, body: unknown): Promise<Key> {
  const first = { query: { filter: null, search: null, sort: null, limit: 1, offset: 0 } };
  const [existing] = await exec(ctx, [selectKeys(ctx.info, first)]);
  const key = existing![0]?.[ctx.info.primary] as Key | undefined;
  if (key !== undefined) return updateOne(ctx, key, body);
  const [created] = await createMany(ctx, [body]);
  return created!;
}
