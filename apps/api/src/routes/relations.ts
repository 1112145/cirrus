import { forbidden } from '@cirrus/shared';
import { Hono } from 'hono';
import { readableFields } from '../access/visibility.ts';
import type { AppEnv } from '../env.ts';
import { requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { requestContext, type RequestContext } from '../request.ts';
import { createRelation, deleteRelation, toDirectusRelation, updateRelation } from '../schema/relations.ts';
import { anyCollection, getSchema, type RelationRecord } from '../schema/store.ts';

/**
 * SDK: readRelations, readRelationByCollection, readRelation, createRelation, updateRelation,
 * deleteRelation. Relations of user collections, in the Directus shape; like /collections, the
 * system collections' own relations aren't listed.
 */
export const relations = new Hono<AppEnv>();

/** Directus filterForbidden: the request may read the field and its collection, the related collection, and the O2M alias if any. */
function visible(req: RequestContext, r: RelationRecord): boolean {
  if (req.accountability.admin) return true;
  const can = (collection: string, field: string | null) => {
    const c = anyCollection(req.schema, collection);
    const readable = c && readableFields(req, c);
    return !!readable && (field === null || readable === 'all' || readable.has(field));
  };
  return can(r.collection, r.field) && can(r.related, r.oneField);
}

const find = (req: RequestContext, collection: string, field: string) => {
  const r = req.schema.relations.find((x) => x.collection === collection && x.field === field);
  if (!r || !visible(req, r)) throw forbidden();
  return r;
};

relations.get('/', async (c) => {
  const req = await requestContext(c);
  return c.json({ data: req.schema.relations.filter((r) => visible(req, r)).map((r) => toDirectusRelation(req.schema, r)) });
});

relations.get('/:collection', async (c) => {
  const req = await requestContext(c);
  const name = c.req.param('collection');
  const col = req.schema.collections.get(name);
  if (!col || readableFields(req, col) === null) throw forbidden();
  return c.json({ data: req.schema.relations.filter((r) => r.collection === name && visible(req, r)).map((r) => toDirectusRelation(req.schema, r)) });
});

relations.get('/:collection/:field', async (c) => {
  const req = await requestContext(c);
  const { collection, field } = c.req.param();
  return c.json({ data: toDirectusRelation(req.schema, find(req, collection, field)) });
});

const readBack = async (db: D1Database, collection: string, field: string) => {
  const schema = await getSchema(db);
  return toDirectusRelation(schema, schema.relations.find((r) => r.collection === collection && r.field === field)!);
};

relations.post('/', requireAdmin, async (c) => {
  const { collection, field } = await createRelation(c.env.DB, await readJson(c));
  return c.json({ data: await readBack(c.env.DB, collection, field) });
});

relations.patch('/:collection/:field', requireAdmin, async (c) => {
  const { collection, field } = c.req.param();
  await updateRelation(c.env.DB, collection, field, await readJson(c));
  return c.json({ data: await readBack(c.env.DB, collection, field) });
});

relations.delete('/:collection/:field', requireAdmin, async (c) => {
  const { collection, field } = c.req.param();
  await deleteRelation(c.env.DB, collection, field);
  return c.body(null, 204);
});
