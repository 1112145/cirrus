import { invalidPayload } from '@cirrus/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { isAdmin, requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { toDirectusCollection } from '../schema/directus.ts';
import { isPlainObject } from '../schema/meta.ts';
import { createCollections, deleteCollection, updateCollections } from '../schema/service.ts';
import { getCollection, getSchema } from '../schema/store.ts';

/** SDK: readCollections, readCollection, createCollection, updateCollection, updateCollectionsBatch, deleteCollection */
export const collections = new Hono<AppEnv>();

const read = async (db: D1Database, names: string[]) => {
  const schema = await getSchema(db);
  return names.map((n) => toDirectusCollection(getCollection(schema, n)));
};

collections.get('/', async (c) => {
  // Non-admins see the collections they have permissions on (M3); for now that is none.
  if (!isAdmin(c)) return c.json({ data: [] });
  const schema = await getSchema(c.env.DB);
  return c.json({ data: [...schema.collections.values()].map(toDirectusCollection) });
});

collections.get('/:collection', requireAdmin, async (c) => {
  const [data] = await read(c.env.DB, [c.req.param('collection')]);
  return c.json({ data });
});

collections.post('/', requireAdmin, async (c) => {
  const body = await readJson(c);
  const names = await createCollections(c.env.DB, Array.isArray(body) ? body : [body]);
  const data = await read(c.env.DB, names);
  return c.json({ data: Array.isArray(body) ? data : data[0] });
});

collections.patch('/', requireAdmin, async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body)) throw invalidPayload('Expected an array of collections');
  const names = await updateCollections(
    c.env.DB,
    body.map((item: unknown) => ({ name: isPlainObject(item) ? item.collection : undefined, body: item })),
  );
  return c.json({ data: await read(c.env.DB, names) });
});

collections.patch('/:collection', requireAdmin, async (c) => {
  const name = c.req.param('collection');
  await updateCollections(c.env.DB, [{ name, body: await readJson(c) }]);
  const [data] = await read(c.env.DB, [name]);
  return c.json({ data });
});

collections.delete('/:collection', requireAdmin, async (c) => {
  await deleteCollection(c.env.DB, c.req.param('collection'));
  return c.body(null, 204);
});
