import { forbidden, invalidPayload } from '@cirrus/shared';
import { Hono } from 'hono';
import { readableFields } from '../access/visibility.ts';
import type { AppEnv } from '../env.ts';
import { requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { toDirectusCollection } from '../schema/directus.ts';
import { isPlainObject } from '../schema/meta.ts';
import { createCollections, deleteCollection, updateCollections } from '../schema/service.ts';
import { requestContext } from '../request.ts';
import { getCollection, getSchema } from '../schema/store.ts';

/** SDK: readCollections, readCollection, createCollection, updateCollection, updateCollectionsBatch, deleteCollection */
export const collections = new Hono<AppEnv>();

const read = async (db: D1Database, names: string[]) => {
  const schema = await getSchema(db);
  return names.map((n) => toDirectusCollection(getCollection(schema, n)));
};

// Non-admins see the collections they may read (folders only to admins).
collections.get('/', async (c) => {
  const req = await requestContext(c);
  const visible = [...req.schema.collections.values()].filter((col) => readableFields(req, col) !== null);
  return c.json({ data: visible.map(toDirectusCollection) });
});

collections.get('/:collection', async (c) => {
  const req = await requestContext(c);
  const col = getCollection(req.schema, c.req.param('collection'));
  if (readableFields(req, col) === null) throw forbidden();
  return c.json({ data: toDirectusCollection(col) });
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
