import { invalidPayload } from '@cirrus/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { isAdmin, requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { toDirectusField } from '../schema/directus.ts';
import { isPlainObject } from '../schema/meta.ts';
import { createField, deleteField, updateFields } from '../schema/service.ts';
import { getCollection, getField, getSchema } from '../schema/store.ts';

/** SDK: readFields, readFieldsByCollection, readField, createField, updateField, updateFields, deleteField */
export const fields = new Hono<AppEnv>();

const read = async (db: D1Database, collection: string, names: string[]) => {
  const c = getCollection(await getSchema(db), collection);
  return names.map((n) => toDirectusField(getField(c, n)));
};

fields.get('/', async (c) => {
  // Non-admins see the fields they have permissions on (M3); for now that is none.
  if (!isAdmin(c)) return c.json({ data: [] });
  const schema = await getSchema(c.env.DB);
  return c.json({ data: [...schema.collections.values()].flatMap((col) => col.fields.map(toDirectusField)) });
});

fields.get('/:collection', requireAdmin, async (c) => {
  const col = getCollection(await getSchema(c.env.DB), c.req.param('collection'));
  return c.json({ data: col.fields.map(toDirectusField) });
});

fields.get('/:collection/:field', requireAdmin, async (c) => {
  const [data] = await read(c.env.DB, c.req.param('collection'), [c.req.param('field')]);
  return c.json({ data });
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
