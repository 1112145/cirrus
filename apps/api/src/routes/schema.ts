import { invalidQuery } from '@cirrus/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { requireAdmin } from '../middleware/auth.ts';
import { readJson } from '../middleware/body.ts';
import { applySchema, diffSchema, snapshotOf } from '../schema/snapshot.ts';
import { getSchema } from '../schema/store.ts';

/** SDK: schemaSnapshot, schemaDiff, schemaApply. Admin only, as in Directus. */
export const schema = new Hono<AppEnv>();

schema.use('*', requireAdmin);

/** Directus reads `force` as a flag: present and not false. */
const flag = (v: string | undefined) => v !== undefined && v !== 'false' && v !== '0';

schema.get('/snapshot', async (c) => {
  const snapshot = snapshotOf(await getSchema(c.env.DB));
  const format = c.req.query('export');
  if (format === undefined) return c.json({ data: snapshot });
  // Directus also exports YAML; Cirrus only JSON.
  if (format !== 'json') throw invalidQuery('"export" must be "json"');
  return c.body(JSON.stringify(snapshot, null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="schema-${Date.now()}.json"`,
  });
});

schema.post('/diff', async (c) => {
  const result = await diffSchema(await getSchema(c.env.DB), await readJson(c), flag(c.req.query('force')));
  return result ? c.json({ data: result }) : c.body(null, 204);
});

schema.post('/apply', async (c) => {
  await applySchema(c.env.DB, await getSchema(c.env.DB), await readJson(c));
  return c.body(null, 204);
});
