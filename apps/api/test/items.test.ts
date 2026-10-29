import { isUuid, uuidv7Timestamp, verifySecret } from '@cirrus/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, call, firstError } from './helpers.ts';

/** Every test in this file shares one D1 database, so each uses its own collection names. */

type Body<T = any> = { data: T; meta?: Record<string, number> };

/** JSON body of a 200 response; shows the error body when the status differs. */
async function ok<T = any>(res: Response): Promise<Body<T>> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as Body<T>;
}

const createCollection = async (body: unknown) => ok(await api('POST', '/collections', body));
const get = (path: string) => api('GET', path);
const errorOf = async (res: Response) => ({ status: res.status, ...(await firstError(res)).extensions });

const ARTICLES = {
  collection: 'articles',
  schema: {},
  fields: [
    { field: 'title', type: 'string', schema: { is_nullable: false } },
    { field: 'slug', type: 'string', schema: { is_unique: true } },
    { field: 'status', type: 'string', schema: { default_value: 'draft' } },
    { field: 'views', type: 'integer', schema: { default_value: 0 } },
    { field: 'rating', type: 'float' },
    { field: 'published', type: 'boolean', schema: { default_value: false } },
    { field: 'tags', type: 'csv', meta: { special: ['cast-csv'] } },
    { field: 'data', type: 'json' },
    { field: 'published_on', type: 'date' },
    { field: 'created_at', type: 'timestamp', meta: { special: ['date-created'] } },
    { field: 'updated_at', type: 'timestamp', meta: { special: ['date-updated'] } },
    { field: 'code', type: 'string', schema: { max_length: 5 } },
    { field: 'divider', type: 'alias', meta: { special: ['alias', 'no-data'] } },
  ],
};

const SEED = [
  { title: 'Hello World', slug: 'hello', status: 'published', views: 10, rating: 4.5, published: true, tags: ['news', 'intro'], published_on: '2024-01-05' },
  { title: 'Second post', slug: 'second', status: 'published', views: 25, rating: 3, published: true, tags: ['news'], published_on: '2024-02-10' },
  { title: 'Draft notes', slug: 'notes', views: 0, data: { todo: ['write'] } },
  { title: 'Archived', slug: 'old', status: 'archived', views: 100, rating: 5, published_on: '2023-12-31' },
];

/** Titles of a list response. */
const titles = async (path: string) => (await ok(await get(path))).data.map((i: any) => i.title);

beforeAll(async () => {
  await createCollection(ARTICLES);
  await ok(await api('POST', '/items/articles', SEED));
});

describe('access', () => {
  it('is FORBIDDEN without a permission (the public policy starts with none)', async () => {
    const reason = (action: string) => `You don't have permission to "${action}" from collection "articles" or it does not exist.`;
    expect(await errorOf(await api('GET', '/items/articles', undefined, null))).toEqual({ status: 403, code: 'FORBIDDEN', reason: reason('read') });
    expect(await errorOf(await api('POST', '/items/articles', { title: 'x' }, null))).toEqual({ status: 403, code: 'FORBIDDEN', reason: reason('create') });
  });

  it('answers FORBIDDEN for collections without items', async () => {
    await createCollection({ collection: 'just_a_folder', schema: null });
    for (const name of ['ghost', 'just_a_folder', 'cirrus_collections', 'directus_users']) {
      expect(await errorOf(await get(`/items/${name}`))).toEqual({ status: 403, code: 'FORBIDDEN' });
    }
  });
});

describe('create', () => {
  it('creates an item with a UUIDv7, defaults and specials, and returns it', async () => {
    const before = Date.now();
    const { data } = await ok(await api('POST', '/items/articles', { title: 'New', slug: 'new', tags: 'a,b', data: [1, { x: true }] }));
    expect(isUuid(data.id)).toBe(true);
    expect(uuidv7Timestamp(data.id)).toBeGreaterThanOrEqual(before - 1);
    expect(data).toEqual({
      id: data.id,
      title: 'New',
      slug: 'new',
      status: 'draft',
      views: 0,
      rating: null,
      published: false,
      tags: ['a', 'b'],
      data: [1, { x: true }],
      published_on: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      updated_at: null,
      code: null,
    });
    expect(Date.parse(data.created_at)).toBeGreaterThanOrEqual(before - 1000);

    const row = await env.DB.prepare('SELECT published, tags, data FROM articles WHERE id = ?').bind(data.id).first();
    expect(row).toEqual({ published: 0, tags: 'a,b', data: '[1,{"x":true}]' });
  });

  it('creates several items in one atomic statement', async () => {
    const { data } = await ok(await api('POST', '/items/articles?fields=title,views', [
      { title: 'Batch A', views: 1 },
      { title: 'Batch B', views: 2 },
    ]));
    expect(data).toEqual(expect.arrayContaining([{ title: 'Batch A', views: 1 }, { title: 'Batch B', views: 2 }]));

    const res = await api('POST', '/items/articles', [{ title: 'Batch C', slug: 'batch-c' }, { title: 'Batch D', slug: 'hello' }]);
    expect(await errorOf(res)).toEqual({ status: 400, code: 'RECORD_NOT_UNIQUE', collection: 'articles', field: 'slug' });
    // Rows setting different columns go in separate statements of one batch: still all or nothing.
    const mixed = await api('POST', '/items/articles', [{ title: 'Batch C', slug: 'batch-c' }, { title: 'Batch D', slug: 'hello', views: 1 }]);
    expect(await errorOf(mixed)).toMatchObject({ code: 'RECORD_NOT_UNIQUE' });
    expect(await titles('/items/articles?filter[title][_eq]=Batch C')).toEqual([]);
  });

  it('normalizes values to their field type', async () => {
    const { data } = await ok(await api('POST', '/items/articles', {
      title: 42,
      views: '7',
      published: 'true',
      published_on: '2024-03-01T23:00:00+05:00',
      created_at: '1999-01-01T00:00:00Z', // date-created wins
    }));
    expect(data).toMatchObject({ title: '42', views: 7, published: true, published_on: '2024-03-01' });
    expect(data.created_at).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it.each([
    [{ title: 'x', views: 'many' }, { status: 400, code: 'INVALID_PAYLOAD', reason: '"views" must be an integer' }],
    [{ title: 'x', published: 'yes' }, { status: 400, code: 'INVALID_PAYLOAD', reason: '"published" must be a boolean' }],
    [{ title: 'x', published_on: 'tomorrow' }, { status: 400, code: 'INVALID_PAYLOAD', reason: '"published_on" must be a date (YYYY-MM-DD)' }],
    [{ title: 'x', id: 'nope' }, { status: 400, code: 'INVALID_PAYLOAD', reason: '"id" must be a UUID' }],
    [{ title: 'x', code: 'toolong' }, { status: 400, code: 'VALUE_TOO_LONG', collection: 'articles', field: 'code' }],
    [{ slug: 'no-title' }, { status: 400, code: 'NOT_NULL_VIOLATION', collection: 'articles', field: 'title' }],
    [{ title: null }, { status: 400, code: 'NOT_NULL_VIOLATION', collection: 'articles', field: 'title' }],
    ['just a string', { status: 400, code: 'INVALID_PAYLOAD', reason: 'An item must be an object' }],
  ])('rejects %j', async (body, error) => {
    expect(await errorOf(await api('POST', '/items/articles', body))).toEqual(error);
  });

  it('ignores keys that are not columns, as Directus does', async () => {
    const { data } = await ok(await api('POST', '/items/articles?fields=title', { title: 'Extra', nope: 1, divider: 'x' }));
    expect(data).toEqual({ title: 'Extra' });
  });

  it('checks the response query before writing anything', async () => {
    const res = await api('POST', '/items/articles?fields=nope', { title: 'Never' });
    expect(await errorOf(res)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await titles('/items/articles?filter[title][_eq]=Never')).toEqual([]);
  });
});

describe('read', () => {
  const seeded = '/items/articles?filter[slug][_in]=hello,second,notes,old';

  it('lists items sorted by primary key, with Directus query parameters', async () => {
    expect(await titles(seeded)).toEqual(['Hello World', 'Second post', 'Draft notes', 'Archived']);
    expect(await titles(`${seeded}&sort=-views`)).toEqual(['Archived', 'Second post', 'Hello World', 'Draft notes']);
    expect(await titles(`${seeded}&sort=views&limit=2&page=2`)).toEqual(['Second post', 'Archived']);
    expect(await titles(`${seeded}&sort=views&limit=1&offset=1`)).toEqual(['Hello World']);
  });

  it('selects fields', async () => {
    const { data } = await ok(await get(`${seeded}&fields=slug,published,tags&limit=1`));
    expect(data).toEqual([{ slug: 'hello', published: true, tags: ['news', 'intro'] }]);
    const star = await ok(await get(`${seeded}&fields=*&limit=1`));
    expect(Object.keys(star.data[0])).toEqual(['id', 'title', 'slug', 'status', 'views', 'rating', 'published', 'tags', 'data', 'published_on', 'created_at', 'updated_at', 'code']);
  });

  it('filters with nested _and / _or, in JSON or bracket syntax', async () => {
    const filter = {
      _and: [
        { _or: [{ status: { _eq: 'published' } }, { views: { _gte: 100 } }] },
        { _or: [{ rating: { _gt: 4 } }, { published_on: { _lt: '2024-01-01' } }] },
      ],
    };
    const expected = ['Hello World', 'Archived'];
    expect(await titles(`/items/articles?filter=${encodeURIComponent(JSON.stringify(filter))}`)).toEqual(expected);
    expect(
      await titles(
        '/items/articles?filter[_and][0][_or][0][status][_eq]=published&filter[_and][0][_or][1][views][_gte]=100' +
          '&filter[_and][1][_or][0][rating][_gt]=4&filter[_and][1][_or][1][published_on][_lt]=2024-01-01',
      ),
    ).toEqual(expected);
  });

  it('reads booleans, nulls and $NOW in filters', async () => {
    expect(await titles(`${seeded}&filter[published][_eq]=true`)).toEqual(['Hello World', 'Second post']);
    expect(await titles(`${seeded}&filter[rating][_null]=true`)).toEqual(['Draft notes']);
    expect(await titles(`${seeded}&filter[published_on][_lt]=$NOW`)).toEqual(['Hello World', 'Second post', 'Archived']);
    expect(await titles(`${seeded}&filter[created_at][_gt]=$NOW(-1 hour)&sort=title&limit=1`)).toEqual(['Archived']);
  });

  it('searches', async () => {
    expect(await titles(`${seeded}&search=hello`)).toEqual(['Hello World']);
    expect(await titles(`${seeded}&search=25`)).toEqual(['Second post']);
  });

  it('returns counts with meta', async () => {
    const all = (await ok(await get('/items/articles?limit=0&meta=total_count'))).meta!.total_count!;
    const res = await ok(await get(`${seeded}&filter[status][_eq]=published&meta=*&limit=1`));
    expect(res.data).toHaveLength(1);
    expect(res.meta).toEqual({ total_count: all, filter_count: 2 });
    expect(all).toBeGreaterThanOrEqual(4);
    expect((await ok(await get(seeded))).meta).toBeUndefined();
  });

  it('reads one item', async () => {
    const [hello] = (await ok(await get('/items/articles?filter[slug][_eq]=hello'))).data;
    expect((await ok(await get(`/items/articles/${hello.id}?fields=slug`))).data).toEqual({ slug: 'hello' });
    expect((await ok(await get(`/items/articles/${hello.id.toUpperCase()}?fields=slug`))).data).toEqual({ slug: 'hello' });
    expect(await errorOf(await get('/items/articles/0190f5b2-8c4a-7b3e-9f00-000000000000'))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await errorOf(await get('/items/articles/not-a-uuid'))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  it.each([
    ['limit=abc', { status: 400, code: 'INVALID_QUERY', reason: '"limit" must be an integer' }],
    ['limit=1001', { status: 400, code: 'INVALID_QUERY', reason: '"limit" must be less than or equal to 1000' }],
    ['filter={nope', { status: 400, code: 'INVALID_QUERY', reason: 'Invalid JSON for filter object' }],
    ['filter[views][_gt]=many', { status: 400, code: 'INVALID_QUERY', reason: 'The filter value for "views" must be a number' }],
    ['filter[title][_like]=x', { status: 400, code: 'INVALID_QUERY', reason: '"_like" is not a valid filter operator' }],
    ['fields=title,nope', { status: 403, code: 'FORBIDDEN', reason: `You don't have permission to access field "nope" in collection "articles" or it does not exist.` }],
    ['sort=nope', { status: 403, code: 'FORBIDDEN', reason: `You don't have permission to access field "nope" in collection "articles" or it does not exist.` }],
    ['filter[nope][_eq]=1', { status: 403, code: 'FORBIDDEN', reason: `You don't have permission to access field "nope" in collection "articles" or it does not exist.` }],
  ])('rejects %s', async (qs, error) => {
    expect(await errorOf(await get(`/items/articles?${qs}`))).toEqual(error);
  });

  it('sees fields added after the collection was created', async () => {
    await createCollection({ collection: 'growing', schema: {}, fields: [{ field: 'name', type: 'string' }] });
    await ok(await api('POST', '/items/growing', { name: 'a' }));
    await ok(await api('POST', '/fields/growing', { field: 'size', type: 'integer', schema: { default_value: 3 } }));
    expect((await ok(await get('/items/growing?fields=name,size'))).data).toEqual([{ name: 'a', size: 3 }]);
  });
});

describe('SEARCH', () => {
  it('takes the query from the body', async () => {
    const res = await api('SEARCH', '/items/articles', { query: { filter: { slug: { _in: ['hello', 'old'] } }, fields: ['slug'], sort: ['-views'] } });
    expect((await ok(res)).data).toEqual([{ slug: 'old' }, { slug: 'hello' }]);
  });

  it('reads by keys', async () => {
    const ids = (await ok(await get('/items/articles?filter[slug][_in]=hello,second&fields=id'))).data.map((i: any) => i.id);
    expect((await ok(await api('SEARCH', '/items/articles?fields=slug', { keys: ids }))).data).toEqual([{ slug: 'hello' }, { slug: 'second' }]);
  });

  it('needs keys or a query', async () => {
    expect(await errorOf(await api('SEARCH', '/items/articles', {}))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
  });
});

describe('update', () => {
  const seed = async (...slugs: string[]) => {
    const { data } = await ok(await api('POST', '/items/articles?fields=id', slugs.map((slug) => ({ title: slug, slug }))));
    return data.map((i: any) => i.id as string);
  };

  it('updates one item, setting date-updated', async () => {
    const [id] = await seed('u1');
    const { data } = await ok(await api('PATCH', `/items/articles/${id}`, { views: 5, tags: ['x'], id }));
    expect(data).toMatchObject({ id, title: 'u1', views: 5, tags: ['x'] });
    expect(data.updated_at).toMatch(/Z$/);
    expect((await ok(await api('PATCH', `/items/articles/${id}?fields=views`, {}))).data).toEqual({ views: 5 });
  });

  it('refuses to change the primary key or update missing items', async () => {
    const [id] = await seed('u2');
    expect(await errorOf(await api('PATCH', `/items/articles/${id}`, { id: '0190f5b2-8c4a-7b3e-9f00-000000000000' }))).toMatchObject({
      status: 400,
      reason: "The primary key can't be changed",
    });
    expect(await errorOf(await api('PATCH', '/items/articles/0190f5b2-8c4a-7b3e-9f00-000000000000', { views: 1 }))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  it('updates several items by keys, by query, or each with its own data', async () => {
    const ids = await seed('m1', 'm2', 'm3');
    const byKeys = await ok(await api('PATCH', '/items/articles?fields=slug,views', { keys: [ids[0], ids[1], '0190f5b2-8c4a-7b3e-9f00-000000000000'], data: { views: 11 } }));
    expect(byKeys.data).toEqual([{ slug: 'm1', views: 11 }, { slug: 'm2', views: 11 }]);

    const byQuery = await ok(await api('PATCH', '/items/articles?fields=slug,status', { query: { filter: { slug: { _in: ['m2', 'm3'] } } }, data: { status: 'review' } }));
    expect(byQuery.data).toEqual([{ slug: 'm2', status: 'review' }, { slug: 'm3', status: 'review' }]);

    const batch = await ok(await api('PATCH', '/items/articles?fields=slug,views', [{ id: ids[0], views: 1 }, { id: ids[2], views: 3 }]));
    expect(batch.data).toEqual([{ slug: 'm1', views: 1 }, { slug: 'm3', views: 3 }]);
  });

  it('validates batch bodies', async () => {
    expect(await errorOf(await api('PATCH', '/items/articles', { keys: [] }))).toMatchObject({ reason: '"data" must be an object' });
    expect(await errorOf(await api('PATCH', '/items/articles', { data: {} }))).toMatchObject({ reason: 'Payload must contain either "keys" or "query"' });
    expect(await errorOf(await api('PATCH', '/items/articles', [{ views: 1 }]))).toMatchObject({ reason: 'Item in update misses primary key' });
    expect(await errorOf(await api('PATCH', '/items/articles', { keys: [{}], data: {} }))).toMatchObject({ reason: '"keys" must be an array of primary keys' });
  });
});

describe('delete', () => {
  const seed = async (...slugs: string[]) =>
    (await ok(await api('POST', '/items/articles?fields=id', slugs.map((slug) => ({ title: slug, slug }))))).data.map((i: any) => i.id as string);

  it('deletes one item', async () => {
    const [id] = await seed('d1');
    expect((await api('DELETE', `/items/articles/${id}`)).status).toBe(204);
    expect(await errorOf(await get(`/items/articles/${id}`))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await errorOf(await api('DELETE', `/items/articles/${id}`))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  it('deletes by keys and by query', async () => {
    const ids = await seed('d2', 'd3', 'd4', 'd5');
    expect((await api('DELETE', '/items/articles', [ids[0]])).status).toBe(204);
    expect((await api('DELETE', '/items/articles', { keys: [ids[1]] })).status).toBe(204);
    expect((await api('DELETE', '/items/articles', { query: { filter: { slug: { _in: ['d4', 'd5'] } } } })).status).toBe(204);
    expect(await titles('/items/articles?filter[slug][_starts_with]=d')).toEqual([]);
  });
});

describe('primary keys', () => {
  it('lets SQLite number integer primary keys', async () => {
    await createCollection({ collection: 'tickets', schema: {}, fields: [{ field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } }, { field: 'subject', type: 'string' }] });
    const { data } = await ok(await api('POST', '/items/tickets', [{ subject: 'a' }, { subject: 'b' }, {}]));
    expect(data).toEqual([{ id: 1, subject: 'a' }, { id: 2, subject: 'b' }, { id: 3, subject: null }]);
    expect((await ok(await get('/items/tickets/2'))).data).toEqual({ id: 2, subject: 'b' });
    expect(await errorOf(await get('/items/tickets/two'))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect((await ok(await api('PATCH', '/items/tickets', { keys: ['1', 3], data: { subject: 'z' } }))).data).toEqual([{ id: 1, subject: 'z' }, { id: 3, subject: 'z' }]);
  });

  it('requires string primary keys', async () => {
    await createCollection({ collection: 'countries', schema: {}, fields: [{ field: 'code', type: 'string', schema: { is_primary_key: true } }, { field: 'name', type: 'string' }] });
    expect(await errorOf(await api('POST', '/items/countries', { name: 'Vietnam' }))).toEqual({ status: 400, code: 'NOT_NULL_VIOLATION', collection: 'countries', field: 'code' });
    await ok(await api('POST', '/items/countries', { code: 'VN', name: 'Vietnam' }));
    expect((await ok(await get('/items/countries/VN'))).data).toEqual({ code: 'VN', name: 'Vietnam' });
    expect(await errorOf(await api('POST', '/items/countries', { code: 'VN' }))).toEqual({ status: 400, code: 'RECORD_NOT_UNIQUE', collection: 'countries', field: 'code' });
  });
});

describe('collection meta', () => {
  it('sorts by the sort field by default', async () => {
    await createCollection({ collection: 'slides', meta: { sort_field: 'sort' }, schema: {}, fields: [{ field: 'name', type: 'string' }, { field: 'sort', type: 'integer' }] });
    await ok(await api('POST', '/items/slides', [{ name: 'b', sort: 2 }, { name: 'c', sort: 3 }, { name: 'a', sort: 1 }]));
    expect((await ok(await get('/items/slides?fields=name'))).data.map((i: any) => i.name)).toEqual(['a', 'b', 'c']);
  });

  it('serves singletons', async () => {
    await createCollection({
      collection: 'site',
      meta: { singleton: true },
      schema: {},
      fields: [{ field: 'name', type: 'string', schema: { default_value: 'My site' } }, { field: 'open', type: 'boolean', schema: { default_value: true } }],
    });
    expect((await ok(await get('/items/site'))).data).toEqual({ id: null, name: 'My site', open: true });
    const created = await ok(await api('PATCH', '/items/site', { name: 'Cirrus' }));
    expect(created.data).toMatchObject({ name: 'Cirrus', open: true });
    await ok(await api('PATCH', '/items/site', { open: false }));
    expect((await ok(await get('/items/site?fields=name,open'))).data).toEqual({ name: 'Cirrus', open: false });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM site').first())?.n).toBe(1);

    expect(await errorOf(await api('POST', '/items/site', { name: 'x' }))).toMatchObject({ status: 404, code: 'ROUTE_NOT_FOUND' });
    expect(await errorOf(await api('PATCH', `/items/site/${created.data.id}`, { name: 'x' }))).toMatchObject({ status: 404, code: 'ROUTE_NOT_FOUND' });
  });
});

describe('field specials', () => {
  it('hashes hash fields, conceals, and generates UUIDs', async () => {
    await createCollection({
      collection: 'accounts',
      schema: {},
      fields: [
        { field: 'email', type: 'string' },
        { field: 'pin', type: 'hash', meta: { special: ['hash', 'conceal'] } },
        { field: 'token', type: 'hash' },
        { field: 'ref', type: 'uuid', meta: { special: ['uuid'] } },
        { field: 'owner', type: 'uuid', meta: { special: ['user-created'] } },
      ],
    });
    const { data } = await ok(await api('POST', '/items/accounts', { email: 'a@b.c', pin: '1234', token: 'secret', owner: '0190f5b2-8c4a-7b3e-9f00-000000000000' }));
    expect(data).toMatchObject({ email: 'a@b.c', pin: '**********', owner: null });
    expect(isUuid(data.ref)).toBe(true);
    expect(data.token).toMatch(/^\$pbkdf2-sha256\$/);
    expect(await verifySecret('secret', data.token)).toBe(true);
    const row = await env.DB.prepare('SELECT pin FROM accounts WHERE id = ?').bind(data.id).first<{ pin: string }>();
    expect(await verifySecret('1234', row!.pin)).toBe(true);
  });
});

describe('D1 limits', () => {
  it('handles hundreds of items and keys per request', async () => {
    await createCollection({ collection: 'readings', schema: {}, fields: [{ field: 'value', type: 'integer' }, { field: 'note', type: 'text' }] });
    const rows = Array.from({ length: 400 }, (_, i) => ({ value: i, note: 'x'.repeat(100) }));
    const { data } = await ok(await api('POST', '/items/readings?fields=id', rows));
    expect(data).toHaveLength(400);
    const ids = data.map((i: any) => i.id);

    const search = await ok(await api('SEARCH', '/items/readings', { query: { filter: { id: { _in: ids } }, limit: -1, fields: ['value'], meta: ['filter_count'] } }));
    expect(search.meta).toEqual({ filter_count: 400 });
    expect(search.data).toHaveLength(400);

    const long = encodeURIComponent('y'.repeat(300));
    expect((await ok(await get(`/items/readings?filter[note][_contains]=${long}`))).data).toEqual([]);

    expect((await api('DELETE', '/items/readings', ids)).status).toBe(204);
    expect((await ok(await get('/items/readings?meta=total_count&limit=0'))).meta).toEqual({ total_count: 0 });
  });
});

describe('errors', () => {
  it('rejects malformed bodies', async () => {
    const res = await call('/items/articles', { method: 'POST', headers: { Authorization: 'Bearer test-admin-token' }, body: '{oops' });
    expect(await errorOf(res)).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD', reason: 'Request body is not valid JSON' });
  });
});
