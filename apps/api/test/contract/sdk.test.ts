/**
 * Contract tests: @directus/sdk 21.3.0 (ships with Directus 11.17.4) calling the Worker directly.
 * Each milestone adds its new commands here (spec §17.3).
 */
import {
  createCollection,
  createDirectus,
  createField,
  deleteCollection,
  deleteField,
  isDirectusError,
  readCollection,
  readCollections,
  readField,
  readFields,
  readFieldsByCollection,
  rest,
  serverHealth,
  serverInfo,
  serverPing,
  staticToken,
  updateCollection,
  updateCollectionsBatch,
  updateField,
  updateFields,
} from '@directus/sdk';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, BASE, tableSql, workerFetch } from '../helpers.ts';

const client = createDirectus(BASE, { globals: { fetch: workerFetch } }).with(rest());
const admin = createDirectus(BASE, { globals: { fetch: workerFetch } }).with(staticToken(ADMIN_TOKEN)).with(rest());

/** Directus error code of a rejected request. */
const errorCode = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(isDirectusError(err)).toBe(true);
  return (err as { errors: Array<{ extensions: { code: string } }> }).errors[0]?.extensions.code;
};

describe('@directus/sdk contract — M0', () => {
  it('serverPing()', async () => {
    expect(await client.request(serverPing())).toBe('pong');
  });

  it('serverInfo()', async () => {
    const info = await client.request(serverInfo());
    expect(info.project.project_name).toBe('Cirrus');
  });

  it('serverHealth()', async () => {
    const health = await client.request(serverHealth());
    expect(health).toMatchObject({ status: 'ok' });
  });

  it('errors are recognized by the SDK as DirectusError', async () => {
    const err = await client
      .request(() => ({ method: 'GET', path: '/does-not-exist' }))
      .catch((e: unknown) => e);
    expect(isDirectusError(err)).toBe(true);
    expect((err as { errors: Array<{ extensions: { code: string } }> }).errors[0]?.extensions.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('@directus/sdk contract — M1', () => {
  // Done when: a `posts` collection can be created via the API.
  it('createCollection()', async () => {
    const posts = await admin.request(
      createCollection({
        collection: 'posts',
        meta: { icon: 'article', note: 'Blog posts', sort_field: 'sort' },
        schema: {},
        fields: [
          {
            field: 'id',
            type: 'uuid',
            meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] },
            schema: { is_primary_key: true, has_auto_increment: false },
          },
          { field: 'status', type: 'string', meta: { interface: 'select-dropdown' }, schema: { default_value: 'draft', is_nullable: false } },
          { field: 'sort', type: 'integer', meta: { hidden: true }, schema: {} },
          { field: 'title', type: 'string', meta: { interface: 'input', required: true }, schema: {} },
        ],
      }),
    );
    expect(posts).toMatchObject({
      collection: 'posts',
      meta: { collection: 'posts', icon: 'article', note: 'Blog posts', sort_field: 'sort', singleton: false },
      schema: { name: 'posts' },
    });
    expect(await tableSql('posts')).toContain('CREATE TABLE "posts"');
  });

  it('createField()', async () => {
    const field = await admin.request(
      createField('posts', {
        field: 'published_at',
        type: 'timestamp',
        meta: { interface: 'datetime', width: 'half' },
        schema: { is_nullable: true },
      }),
    );
    expect(field).toMatchObject({
      collection: 'posts',
      field: 'published_at',
      type: 'timestamp',
      meta: { interface: 'datetime', width: 'half', sort: 5 },
      schema: { name: 'published_at', table: 'posts', is_nullable: true },
    });
  });

  it('readCollections() / readCollection()', async () => {
    const all = await admin.request(readCollections());
    expect(all.map((c) => c.collection)).toContain('posts');
    expect(await admin.request(readCollection('posts'))).toMatchObject({ collection: 'posts', meta: { icon: 'article' } });
  });

  it('readFields() / readFieldsByCollection() / readField()', async () => {
    const all = await admin.request(readFields());
    expect(all.filter((f) => f.collection === 'posts').map((f) => f.field)).toEqual(['id', 'status', 'sort', 'title', 'published_at']);

    const byCollection = await admin.request(readFieldsByCollection('posts'));
    expect(byCollection).toHaveLength(5);

    const status = await admin.request(readField('posts', 'status'));
    expect(status).toMatchObject({ field: 'status', type: 'string', schema: { default_value: 'draft', is_nullable: false } });
  });

  it('updateField() / updateFields()', async () => {
    const status = await admin.request(
      updateField('posts', 'status', {
        meta: { options: { choices: [{ text: 'Draft', value: 'draft' }, { text: 'Published', value: 'published' }] } },
        schema: { is_indexed: true },
      }),
    );
    expect(status).toMatchObject({ meta: { options: { choices: [{ value: 'draft' }, { value: 'published' }] } }, schema: { is_indexed: true } });

    const reordered = await admin.request(
      updateFields('posts', [
        { field: 'title', meta: { sort: 2 } },
        { field: 'status', meta: { sort: 3 } },
      ]),
    );
    expect(reordered.map((f) => [f.field, f.meta.sort])).toEqual([
      ['title', 2],
      ['status', 3],
    ]);
  });

  it('updateCollection() / updateCollectionsBatch()', async () => {
    expect(await admin.request(updateCollection('posts', { meta: { color: '#6644FF' } }))).toMatchObject({ meta: { color: '#6644FF' } });
    const batch = await admin.request(updateCollectionsBatch([{ collection: 'posts', meta: { hidden: true } }]));
    expect(batch).toMatchObject([{ collection: 'posts', meta: { hidden: true, color: '#6644FF' } }]);
  });

  it('deleteField()', async () => {
    await admin.request(deleteField('posts', 'published_at'));
    expect(await errorCode(admin.request(readField('posts', 'published_at')))).toBe('FORBIDDEN');
  });

  it('errors use Directus codes', async () => {
    expect(await errorCode(admin.request(createCollection({ collection: 'posts', schema: {} })))).toBe('INVALID_PAYLOAD');
    expect(await errorCode(client.request(createCollection({ collection: 'nope', schema: {} })))).toBe('FORBIDDEN');
    expect(await errorCode(client.request(readCollection('posts')))).toBe('FORBIDDEN');
  });

  it('deleteCollection()', async () => {
    await admin.request(deleteCollection('posts'));
    expect(await errorCode(admin.request(readCollection('posts')))).toBe('FORBIDDEN');
    expect(await tableSql('posts')).toBeNull();
  });
});
