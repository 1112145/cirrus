import { forbidden, invalidPayload } from '@cirrus/shared';
import { Hono } from 'hono';
import { readableFields } from '../access/visibility.ts';
import type { AppEnv } from '../env.ts';
import { requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { toDirectusField } from '../schema/directus.ts';
import { isPlainObject } from '../schema/meta.ts';
import { createField, deleteField, updateFields } from '../schema/service.ts';
import { requestContext } from '../request.ts';
import { type CollectionRecord, getCollection, getField, getSchema } from '../schema/store.ts';

/** SDK: readFields, readFieldsByCollection, readField, createField, updateField, updateFields, deleteField */
export const fields = new Hono<AppEnv>();

const read = async (db: D1Database, collection: string, names: string[]) => {
  const c = getCollection(await getSchema(db), collection);
  return names.map((n) => toDirectusField(getField(c, n)));
};

/** The fields of a collection the request may read; null when it may not read the collection. */
const visibleFields = (req: Parameters<typeof readableFields>[0], col: CollectionRecord) => {
  const readable = readableFields(req, col);
  return readable && col.fields.filter((f) => readable === 'all' || readable.has(f.field));
};

// Non-admins see the fields they may read.
fields.get('/', async (c) => {
  const req = await requestContext(c);
  return c.json({ data: [...req.schema.collections.values()].flatMap((col) => (visibleFields(req, col) ?? []).map(toDirectusField)) });
});

fields.get('/:collection', async (c) => {
  const req = await requestContext(c);
  const visible = visibleFields(req, getCollection(req.schema, c.req.param('collection')));
  if (!visible) throw forbidden();
  return c.json({ data: visible.map(toDirectusField) });
});

fields.get('/:collection/:field', async (c) => {
  const req = await requestContext(c);
  const field = visibleFields(req, getCollection(req.schema, c.req.param('collection')))?.find((f) => f.field === c.req.param('field'));
  if (!field) throw forbidden();
  return c.json({ data: toDirectusField(field) });
});

fields.post('/:collection', requireAdmin, async (c) => {
  const collection = c.req.param('collection');
  const name = await createField(c.env.DB, collection, await readJson(c));
  const [data] = await read(c.env.DB, collection, [name]);
  return c.json({ data });
});

fields.patch('/:collection', requireAdmin, async (c) => {
  const collection = c.req.param('collection');
  const body = await readJson(c);
  if (!Array.isArray(body)) throw invalidPayload('Expected an array of fields');
  const names = await updateFields(
    c.env.DB,
    collection,
    body.map((item: unknown) => ({ name: isPlainObject(item) ? item.field : undefined, body: item })),
  );
  return c.json({ data: await read(c.env.DB, collection, names) });
});

fields.patch('/:collection/:field', requireAdmin, async (c) => {
  const { collection, field } = c.req.param();
  await updateFields(c.env.DB, collection, [{ name: field, body: await readJson(c) }]);
  const [data] = await read(c.env.DB, collection, [field]);
  return c.json({ data });
});

fields.delete('/:collection/:field', requireAdmin, async (c) => {
  const { collection, field } = c.req.param();
  await deleteField(c.env.DB, collection, field);
  return c.body(null, 204);
});
