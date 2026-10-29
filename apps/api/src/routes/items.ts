import { parseQueryString, type Query, sanitizeQuery, type SanitizeOptions } from '@cirrus/query';
import { invalidPayload, isCirrusError, isPlainObject, routeNotFound } from '@cirrus/shared';
import { type Context, Hono } from 'hono';
import type { AppEnv, Bindings } from '../env.ts';
import { itemsContext, type ItemsContext } from '../items/context.ts';
import { type Item, type Key, parseKey, parseKeys } from '../items/payload.ts';
import {
  createMany,
  deleteMany,
  deleteOne,
  readByQuery,
  readMany,
  readOne,
  readSingleton,
  updateBatch,
  updateMany,
  updateOne,
  upsertSingleton,
  validateQuery,
} from '../items/service.ts';
import { requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { getSchema } from '../schema/store.ts';

/**
 * SDK: readItems, readItem, createItem(s), updateItem(s), updateItemsBatch, deleteItem(s),
 * readSingleton, updateSingleton, and withSearch() (the SEARCH method).
 */
export const items = new Hono<AppEnv>();

// Until permissions land (M3) only admins can use items, like Directus' public role, which starts
// with no permissions.
items.use('*', requireAdmin);

const context = async (c: Context<AppEnv>, collection: string) => itemsContext(c.env.DB, await getSchema(c.env.DB), collection);

const intVar = (v: string | undefined, fallback: number) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : fallback);

const queryOptions = (env: Bindings, now: Date): SanitizeOptions => ({
  limitDefault: intVar(env.QUERY_LIMIT_DEFAULT, 100),
  limitMax: intVar(env.QUERY_LIMIT_MAX, -1),
  variables: { now },
});

/** The query from the query string, in JSON or bracket syntax. */
const urlQuery = (c: Context<AppEnv>, ctx: ItemsContext): Query =>
  sanitizeQuery(parseQueryString(new URL(c.req.url).searchParams.entries()), queryOptions(c.env, ctx.now));

const bodyQuery = (c: Context<AppEnv>, ctx: ItemsContext, raw: Record<string, unknown>): Query =>
  sanitizeQuery(raw, queryOptions(c.env, ctx.now));

type Batch = { keys?: unknown[]; query?: Record<string, unknown>; data?: unknown };

/** Directus validateBatch: an object with either `keys` or `query`; updates also need `data`. */
function parseBatch(body: unknown, needsData = false): Batch {
  if (!isPlainObject(body)) throw invalidPayload('Payload in body is required');
  if ((body.keys === undefined) === (body.query === undefined)) throw invalidPayload('Payload must contain either "keys" or "query"');
  if (body.keys !== undefined && !Array.isArray(body.keys)) throw invalidPayload('"keys" must be an array');
  if (body.query !== undefined && !isPlainObject(body.query)) throw invalidPayload('"query" must be an object');
  if (needsData && !isPlainObject(body.data)) throw invalidPayload('"data" must be an object');
  return body as Batch;
}

/** After a write, return the items as the query reads them; none readable → 204, as in Directus. */
async function readBack(c: Context<AppEnv>, read: () => Promise<Item | Item[]>) {
  try {
    return c.json({ data: await read() });
  } catch (e) {
    if (isCirrusError(e) && e.code === 'FORBIDDEN') return c.body(null, 204);
    throw e;
  }
}

items.get('/:collection', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  const q = urlQuery(c, ctx);
  return c.json(ctx.collection.meta.singleton ? await readSingleton(ctx, q) : await readByQuery(ctx, q));
});

// SEARCH: a read with the query in the body (too long for a URL), or a read by keys.
items.on('SEARCH', '/:collection', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  const batch = parseBatch(await readJson(c));
  const q = batch.query ? bodyQuery(c, ctx, batch.query) : urlQuery(c, ctx);
  if (batch.keys) return c.json({ data: await readMany(ctx, parseKeys(ctx, batch.keys), q) });
  return c.json(ctx.collection.meta.singleton ? await readSingleton(ctx, q) : await readByQuery(ctx, q));
});

items.get('/:collection/:pk', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  const q = urlQuery(c, ctx);
  return c.json({ data: await readOne(ctx, parseKey(ctx, c.req.param('pk')), q) });
});

items.post('/:collection', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  if (ctx.collection.meta.singleton) throw routeNotFound(c.req.path);
  const q = urlQuery(c, ctx);
  validateQuery(ctx, q);
  const body = await readJson(c);
  if (Array.isArray(body)) {
    const keys = await createMany(ctx, body);
    return readBack(c, () => readMany(ctx, keys, q));
  }
  const [key] = await createMany(ctx, [body]);
  return readBack(c, () => readOne(ctx, key!, q));
});

items.patch('/:collection', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  const q = urlQuery(c, ctx);
  validateQuery(ctx, q);
  const body = await readJson(c);

  if (ctx.collection.meta.singleton) {
    await upsertSingleton(ctx, body);
    return c.json({ data: (await readSingleton(ctx, { ...q, meta: [] })).data });
  }

  let keys: Key[];
  if (Array.isArray(body)) {
    keys = await updateBatch(ctx, body);
  } else {
    const batch = parseBatch(body, true);
    const target = batch.keys ? { keys: parseKeys(ctx, batch.keys) } : { query: bodyQuery(c, ctx, batch.query!) };
    keys = await updateMany(ctx, target, batch.data);
  }
  return readBack(c, () => readMany(ctx, keys, q));
});

items.patch('/:collection/:pk', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  if (ctx.collection.meta.singleton) throw routeNotFound(c.req.path);
  const q = urlQuery(c, ctx);
  validateQuery(ctx, q);
  const key = await updateOne(ctx, parseKey(ctx, c.req.param('pk')), await readJson(c));
  return readBack(c, () => readOne(ctx, key, q));
});

items.delete('/:collection', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  const body = await readJson(c);
  if (Array.isArray(body)) {
    await deleteMany(ctx, { keys: parseKeys(ctx, body) });
  } else {
    const batch = parseBatch(body);
    await deleteMany(ctx, batch.keys ? { keys: parseKeys(ctx, batch.keys) } : { query: bodyQuery(c, ctx, batch.query!) });
  }
  return c.body(null, 204);
});

items.delete('/:collection/:pk', async (c) => {
  const ctx = await context(c, c.req.param('collection'));
  await deleteOne(ctx, parseKey(ctx, c.req.param('pk')));
  return c.body(null, 204);
});
