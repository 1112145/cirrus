import { parseQueryString, type Query, sanitizeQuery } from '@cirrus/query';
import { invalidPayload, isCirrusError, isPlainObject, routeNotFound } from '@cirrus/shared';
import type { Context, Hono } from 'hono';
import type { AppEnv, Bindings } from '../env.ts';
import type { ItemsContext } from '../items/context.ts';
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
import { readJson } from '../middleware/body.ts';

/**
 * The Directus items endpoints, for /items/:collection and for the system collections' own paths
 * (/users, /roles, …): list, SEARCH, read, create, update and delete, one or many.
 */

const intVar = (v: string | undefined, fallback: number) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : fallback);

/** A sanitized query, with the dynamic variables of the request (and the user fields it refers to). */
export async function toQuery(env: Bindings, ctx: ItemsContext, raw: Record<string, unknown>): Promise<Query> {
  return sanitizeQuery(raw, {
    limitDefault: intVar(env.QUERY_LIMIT_DEFAULT, 100),
    limitMax: intVar(env.QUERY_LIMIT_MAX, -1),
    variables: await ctx.req.variables.for(raw),
  });
}

/** The query from the query string, in JSON or bracket syntax. */
export const urlQuery = (c: Context<AppEnv>, ctx: ItemsContext) => toQuery(c.env, ctx, parseQueryString(new URL(c.req.url).searchParams.entries()));

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
export async function readBack(c: Context<AppEnv>, read: () => Promise<Item | Item[]>) {
  try {
    return c.json({ data: await read() });
  } catch (e) {
    if (isCirrusError(e) && e.code === 'FORBIDDEN') return c.body(null, 204);
    throw e;
  }
}

/** Register the items endpoints on `app` under `base` ('' for the app's root); `resolve` names the collection. */
export function itemRoutes(app: Hono<AppEnv>, base: string, resolve: (c: Context<AppEnv>) => Promise<ItemsContext>) {
  const root = base || '/';
  const one = `${base}/:pk`;
  const key = (c: Context<AppEnv>, ctx: ItemsContext): Key => parseKey(ctx, c.req.param('pk'));

  app.get(root, async (c) => {
    const ctx = await resolve(c);
    const q = await urlQuery(c, ctx);
    return c.json(ctx.collection.meta.singleton ? await readSingleton(ctx, q) : await readByQuery(ctx, q));
  });

  // SEARCH: a read with the query in the body (too long for a URL), or a read by keys.
  app.on('SEARCH', root, async (c) => {
    const ctx = await resolve(c);
    const batch = parseBatch(await readJson(c));
    const q = batch.query ? await toQuery(c.env, ctx, batch.query) : await urlQuery(c, ctx);
    if (batch.keys) return c.json({ data: await readMany(ctx, parseKeys(ctx, batch.keys), q) });
    return c.json(ctx.collection.meta.singleton ? await readSingleton(ctx, q) : await readByQuery(ctx, q));
  });

  app.get(one, async (c) => {
    const ctx = await resolve(c);
    const q = await urlQuery(c, ctx);
    return c.json({ data: await readOne(ctx, key(c, ctx), q) });
  });

  app.post(root, async (c) => {
    const ctx = await resolve(c);
    if (ctx.collection.meta.singleton) throw routeNotFound(c.req.path);
    const q = await urlQuery(c, ctx);
    validateQuery(ctx, q);
    const body = await readJson(c);
    if (Array.isArray(body)) {
      const keys = await createMany(ctx, body);
      return readBack(c, () => readMany(ctx, keys, q));
    }
    const [created] = await createMany(ctx, [body]);
    return readBack(c, () => readOne(ctx, created!, q));
  });

  app.patch(root, async (c) => {
    const ctx = await resolve(c);
    const q = await urlQuery(c, ctx);
    validateQuery(ctx, q);
    const body = await readJson(c);

    if (ctx.collection.meta.singleton) {
      await upsertSingleton(ctx, body);
      return readBack(c, async () => (await readSingleton(ctx, { ...q, meta: [] })).data);
    }

    let keys: Key[];
    if (Array.isArray(body)) {
      keys = await updateBatch(ctx, body);
    } else {
      const batch = parseBatch(body, true);
      const target = batch.keys ? { keys: parseKeys(ctx, batch.keys) } : { query: await toQuery(c.env, ctx, batch.query!) };
      keys = await updateMany(ctx, target, batch.data);
    }
    return readBack(c, () => readMany(ctx, keys, q));
  });

  app.patch(one, async (c) => {
    const ctx = await resolve(c);
    if (ctx.collection.meta.singleton) throw routeNotFound(c.req.path);
    const q = await urlQuery(c, ctx);
    validateQuery(ctx, q);
    const updated = await updateOne(ctx, key(c, ctx), await readJson(c));
    return readBack(c, () => readOne(ctx, updated, q));
  });

  app.delete(root, async (c) => {
    const ctx = await resolve(c);
    const body = await readJson(c);
    if (Array.isArray(body)) {
      await deleteMany(ctx, { keys: parseKeys(ctx, body) });
    } else {
      const batch = parseBatch(body);
      await deleteMany(ctx, batch.keys ? { keys: parseKeys(ctx, batch.keys) } : { query: await toQuery(c.env, ctx, batch.query!) });
    }
    return c.body(null, 204);
  });

  app.delete(one, async (c) => {
    const ctx = await resolve(c);
    await deleteOne(ctx, key(c, ctx));
    return c.body(null, 204);
  });
}
