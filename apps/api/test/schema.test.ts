import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { commit } from '../src/schema/commit.ts';
import { api, call, firstError, tableColumns, tableIndexes, tableSql } from './helpers.ts';

/** Every test in this file shares one D1 database, so each uses its own collection names. */

type Data<T = any> = { data: T };

const create = (body: unknown) => api('POST', '/collections', body);
const createWithTitle = (collection: string) =>
  create({ collection, schema: {}, fields: [{ field: 'title', type: 'string' }] });
const version = async () =>
  (await env.DB.prepare("SELECT value FROM cirrus_settings WHERE key = 'schema_version'").first<{ value: string }>())!.value;

describe('access', () => {
  it('schema changes need admin', async () => {
    const res = await api('POST', '/collections', { collection: 'nope', schema: {} }, null);
    expect(res.status).toBe(403);
    expect((await firstError(res)).extensions.code).toBe('FORBIDDEN');
  });

  it('public users see no collections or fields', async () => {
    await createWithTitle('hidden_from_public');
    expect(await (await api('GET', '/collections', undefined, null)).json()).toEqual({ data: [] });
    expect(await (await api('GET', '/fields', undefined, null)).json()).toEqual({ data: [] });
    expect((await api('GET', '/collections/hidden_from_public', undefined, null)).status).toBe(403);
    expect((await api('GET', '/fields/hidden_from_public', undefined, null)).status).toBe(403);
  });

  it('a wrong token is rejected everywhere', async () => {
    const res = await call('/server/ping', { headers: { Authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
    expect((await firstError(res)).extensions.code).toBe('INVALID_CREDENTIALS');
  });

  it('the token also works as ?access_token=', async () => {
    const res = await call('/collections?access_token=test-admin-token');
    expect(res.status).toBe(200);
  });
});

describe('POST /collections', () => {
  it('creates a table with a UUID primary key by default', async () => {
    const res = await create({
      collection: 'articles',
      meta: { icon: 'article', note: 'News' },
      schema: {},
      fields: [
        { field: 'title', type: 'string', meta: { interface: 'input', required: true }, schema: { is_nullable: false } },
        { field: 'slug', type: 'string', schema: { is_unique: true } },
        { field: 'published', type: 'boolean', schema: { default_value: false } },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        collection: 'articles',
        meta: {
          collection: 'articles',
          icon: 'article',
          note: 'News',
          display_template: null,
          hidden: false,
          singleton: false,
          translations: null,
          archive_field: null,
          archive_app_filter: true,
          archive_value: null,
          unarchive_value: null,
          sort_field: null,
          accountability: 'all',
          color: null,
          item_duplication_fields: null,
          sort: null,
          group: null,
          collapse: 'open',
          preview_url: null,
          versioning: false,
        },
        schema: { name: 'articles', comment: null },
      },
    });

    expect(await tableSql('articles')).toBe(
      [
        'CREATE TABLE "articles" (',
        '  "id" TEXT PRIMARY KEY NOT NULL,',
        '  "title" TEXT NOT NULL,',
        '  "slug" TEXT,',
        '  "published" INTEGER DEFAULT 0 CHECK ("published" IN (0, 1))',
        ') STRICT',
      ].join('\n'),
    );
    expect(await tableIndexes('articles')).toEqual(['articles.slug.unique']);

    const { data } = await (await api('GET', '/fields/articles')).json<Data>();
    expect(data.map((f: any) => [f.field, f.type, f.meta.sort])).toEqual([
      ['id', 'uuid', 1],
      ['title', 'string', 2],
      ['slug', 'string', 3],
      ['published', 'boolean', 4],
    ]);
    expect(data[0].meta).toMatchObject({ special: ['uuid'], hidden: true, readonly: true });
    expect(data[0].schema).toMatchObject({ is_primary_key: true, is_nullable: false, data_type: 'text' });
  });

  it('accepts an integer auto-increment primary key', async () => {
    await create({
      collection: 'counters',
      schema: {},
      fields: [{ field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } }],
    });
    expect(await tableSql('counters')).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
  });

  it('rejects names that exist, even with different case', async () => {
    await createWithTitle('things');
    const res = await createWithTitle('Things');
    expect(res.status).toBe(400);
    expect(await firstError(res)).toEqual({
      message: 'Invalid payload. Collection "Things" already exists.',
      extensions: { code: 'INVALID_PAYLOAD', reason: 'Collection "Things" already exists' },
    });
  });

  it.each([
    [{ collection: 'cirrus_x', schema: {} }, `Collections can't start with "cirrus_"`],
    [{ collection: 'bad-name', schema: {} }, 'Collection name "bad-name" is invalid'],
    [{ schema: {} }, '"collection" is required'],
    [{ collection: 'x1', schema: {}, fields: [{ field: 'a', type: 'nope' }] }, '"type" must be one of'],
    [{ collection: 'x2', schema: {}, fields: [{ field: 'a', type: 'string' }, { field: 'A', type: 'text' }] }, 'defined more than once'],
    [{ collection: 'x3', schema: {}, fields: [{ field: 'id', type: 'string' }] }, 'needs a primary key'],
    [{ collection: 'x4', schema: {}, fields: [{ field: 'a', type: 'json', schema: { is_primary_key: true } }] }, `can't be the primary key`],
    [{ collection: 'x5', schema: {}, meta: { hidden: 'yes' } }, '"meta.hidden" must be a boolean'],
    [{ collection: 'x6', schema: {}, fields: [{ field: 'n', type: 'integer', schema: { default_value: 'abc' } }] }, 'must be an integer'],
    [{ collection: 'x7', meta: { group: 'missing' } }, `"missing" used as group doesn't exist`],
  ])('validates %j', async (body, reason) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect((await firstError(res)).extensions.reason).toContain(reason);
  });

  it('rejects malformed JSON', async () => {
    const res = await call('/collections', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: '{oops',
    });
    expect(res.status).toBe(400);
    expect((await firstError(res)).extensions.code).toBe('INVALID_PAYLOAD');
  });

  it('creates folders (no schema) and several collections at once', async () => {
    const res = await create([
      { collection: 'blog', meta: { icon: 'folder' }, schema: null },
      { collection: 'blog_posts', meta: { group: 'blog' }, schema: {} },
    ]);
    const { data } = await res.json<Data>();
    expect(data.map((c: any) => [c.collection, c.schema, c.meta.group])).toEqual([
      ['blog', null, null],
      ['blog_posts', { name: 'blog_posts', comment: null }, 'blog'],
    ]);
    expect(await tableSql('blog')).toBeNull();
    expect(await tableSql('blog_posts')).not.toBeNull();

    const addField = await api('POST', '/fields/blog', { field: 'title', type: 'string' });
    expect((await firstError(addField)).extensions.reason).toContain('is a folder');
  });
});

describe('PATCH /collections', () => {
  it('updates meta only', async () => {
    await createWithTitle('pages');
    const before = await tableSql('pages');
    const res = await api('PATCH', '/collections/pages', { meta: { note: 'Static pages', sort_field: 'title' }, schema: { name: 'x' } });
    expect((await res.json<Data>()).data.meta).toMatchObject({ note: 'Static pages', sort_field: 'title', icon: null });
    expect(await tableSql('pages')).toBe(before);
  });

  it('updates several collections in one call', async () => {
    await createWithTitle('batch_a');
    await createWithTitle('batch_b');
    const res = await api('PATCH', '/collections', [
      { collection: 'batch_a', meta: { sort: 1 } },
      { collection: 'batch_b', meta: { sort: 2 } },
    ]);
    expect((await res.json<Data>()).data.map((c: any) => c.meta.sort)).toEqual([1, 2]);
  });

  it('applies repeated entries for one collection in order', async () => {
    await createWithTitle('batch_c');
    const res = await api('PATCH', '/collections', [
      { collection: 'batch_c', meta: { note: 'first' } },
      { collection: 'batch_c', meta: { color: '#000000' } },
    ]);
    expect((await res.json<Data>()).data).toMatchObject([{ meta: { note: 'first', color: '#000000' } }]);
  });

  it('answers FORBIDDEN for unknown collections', async () => {
    expect((await api('PATCH', '/collections/ghost', { meta: {} })).status).toBe(403);
    expect((await api('GET', '/collections/ghost')).status).toBe(403);
  });
});

describe('fields', () => {
  it('adds a column and appends it to the sort order', async () => {
    await createWithTitle('notes');
    const res = await api('POST', '/fields/notes', {
      field: 'body',
      type: 'text',
      meta: { interface: 'input-rich-text-html', note: 'Main content' },
      schema: { default_value: '' },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json<Data>();
    expect(data).toMatchObject({
      collection: 'notes',
      field: 'body',
      type: 'text',
      meta: { collection: 'notes', field: 'body', interface: 'input-rich-text-html', note: 'Main content', sort: 3, width: 'full' },
      schema: { name: 'body', table: 'notes', data_type: 'text', default_value: '', is_nullable: true, is_unique: false },
    });
    expect(typeof data.meta.id).toBe('number');
    expect(await tableColumns('notes')).toEqual(['id', 'title', 'body']);

    const one = await (await api('GET', '/fields/notes/body')).json<Data>();
    expect(one.data).toEqual(data);
  });

  it('keeps existing rows when adding columns', async () => {
    await createWithTitle('memos');
    await env.DB.prepare(`INSERT INTO memos (id, title) VALUES ('m1', 'Hello')`).run();
    await api('POST', '/fields/memos', { field: 'pinned', type: 'boolean', schema: { default_value: true, is_nullable: false } });
    expect(await env.DB.prepare('SELECT * FROM memos').all()).toMatchObject({ results: [{ id: 'm1', title: 'Hello', pinned: 1 }] });
  });

  it("can't add a NOT NULL column without default once there are rows", async () => {
    await createWithTitle('drafts');
    expect((await api('POST', '/fields/drafts', { field: 'a', type: 'string', schema: { is_nullable: false } })).status).toBe(200);

    await env.DB.prepare(`INSERT INTO drafts (id, title, a) VALUES ('d1', 'x', 'y')`).run();
    const v = await version();
    const res = await api('POST', '/fields/drafts', { field: 'b', type: 'string', schema: { is_nullable: false } });
    expect(res.status).toBe(400);
    expect(await firstError(res)).toMatchObject({ extensions: { code: 'CONTAINS_NULL_VALUES', collection: 'drafts', field: 'b' } });
    // nothing changed
    expect(await tableColumns('drafts')).toEqual(['id', 'title', 'a']);
    expect((await (await api('GET', '/fields/drafts')).json<Data>()).data).toHaveLength(3);
    expect(await version()).toBe(v);
  });

  it('adds alias fields without a column', async () => {
    await createWithTitle('posters');
    const res = await api('POST', '/fields/posters', {
      field: 'divider',
      type: 'alias',
      meta: { interface: 'presentation-divider', special: 'alias,no-data' },
    });
    const { data } = await res.json<Data>();
    expect(data.schema).toBeNull();
    expect(data.meta.special).toEqual(['alias', 'no-data']);
    expect(await tableColumns('posters')).toEqual(['id', 'title']);
  });

  it.each([
    [{ field: 'Title', type: 'string' }, 'Field "Title" already exists in collection "widgets"'],
    [{ field: 'key', type: 'uuid', schema: { is_primary_key: true } }, 'already has a primary key'],
    [{ field: 'rowid', type: 'integer' }, 'Field name "rowid" is reserved'],
    [{ type: 'string' }, '"field" is required'],
    [{ field: 'n', type: 'integer', schema: { has_auto_increment: true } }, 'Only integer primary keys can auto-increment'],
  ])('validates new field %j', async (body, reason) => {
    if (!(await tableSql('widgets'))) await createWithTitle('widgets');
    const res = await api('POST', '/fields/widgets', body);
    expect(res.status).toBe(400);
    expect((await firstError(res)).extensions.reason).toContain(reason);
  });

  it('answers FORBIDDEN for unknown collections and fields', async () => {
    await createWithTitle('known');
    expect((await api('POST', '/fields/ghost', { field: 'a', type: 'string' })).status).toBe(403);
    expect((await api('GET', '/fields/ghost')).status).toBe(403);
    expect((await api('GET', '/fields/known/ghost')).status).toBe(403);
    expect((await api('PATCH', '/fields/known/ghost', { meta: {} })).status).toBe(403);
    expect((await api('DELETE', '/fields/known/ghost')).status).toBe(403);
  });
});

describe('PATCH /fields', () => {
  it('updates meta without touching the table', async () => {
    await createWithTitle('events');
    const before = await tableSql('events');
    const res = await api('PATCH', '/fields/events/title', { meta: { note: 'Event name', width: 'half' } });
    expect((await res.json<Data>()).data.meta).toMatchObject({ note: 'Event name', width: 'half', interface: null });
    expect(await tableSql('events')).toBe(before);
  });

  it('changes a column type by rebuilding the table, keeping data', async () => {
    await create({ collection: 'scores', schema: {}, fields: [{ field: 'points', type: 'string', schema: { is_indexed: true } }] });
    await env.DB.prepare(`INSERT INTO scores (id, points) VALUES ('a', '10'), ('b', NULL)`).run();

    const res = await api('PATCH', '/fields/scores/points', { type: 'integer', schema: { default_value: 0 } });
    expect(res.status).toBe(200);
    expect((await res.json<Data>()).data.schema).toMatchObject({ data_type: 'integer', default_value: 0, is_indexed: true });

    expect(await tableSql('scores')).toContain('"points" INTEGER DEFAULT 0');
    expect(await tableIndexes('scores')).toEqual(['scores.points.index']);
    const rows = await env.DB.prepare('SELECT id, points, typeof(points) AS t FROM scores ORDER BY id').all();
    expect(rows.results).toEqual([
      { id: 'a', points: 10, t: 'integer' },
      { id: 'b', points: null, t: 'null' },
    ]);
  });

  it("refuses type changes that existing values don't fit, changing nothing", async () => {
    await create({ collection: 'labels', schema: {}, fields: [{ field: 'code', type: 'string' }] });
    await env.DB.prepare(`INSERT INTO labels (id, code) VALUES ('a', 'X-1')`).run();
    const before = await tableSql('labels');

    const res = await api('PATCH', '/fields/labels/code', { type: 'integer' });
    expect(res.status).toBe(400);
    expect((await firstError(res)).extensions.reason).toBe(
      'Existing values of field "code" in collection "labels" can\'t be stored as INTEGER',
    );
    expect(await tableSql('labels')).toBe(before);
    expect((await (await api('GET', '/fields/labels/code')).json<Data>()).data.type).toBe('string');
  });

  it('refuses to make a column unique when values repeat', async () => {
    await create({ collection: 'handles', schema: {}, fields: [{ field: 'name', type: 'string' }] });
    await env.DB.prepare(`INSERT INTO handles (id, name) VALUES ('a', 'x'), ('b', 'x')`).run();
    const res = await api('PATCH', '/fields/handles/name', { schema: { is_unique: true } });
    expect(res.status).toBe(400);
    expect(await firstError(res)).toMatchObject({
      extensions: { code: 'RECORD_NOT_UNIQUE', collection: 'handles', field: 'name' },
    });
  });

  it('making a column required fails on existing nulls', async () => {
    await create({ collection: 'tasks', schema: {}, fields: [{ field: 'owner', type: 'string' }] });
    await env.DB.prepare(`INSERT INTO tasks (id) VALUES ('a')`).run();
    const res = await api('PATCH', '/fields/tasks/owner', { schema: { is_nullable: false } });
    expect(await firstError(res)).toMatchObject({ extensions: { code: 'CONTAINS_NULL_VALUES', collection: 'tasks', field: 'owner' } });
  });

  it('updates several fields at once (e.g. reordering)', async () => {
    await create({
      collection: 'recipes',
      schema: {},
      fields: [
        { field: 'name', type: 'string' },
        { field: 'steps', type: 'text' },
      ],
    });
    const res = await api('PATCH', '/fields/recipes', [
      { field: 'steps', meta: { sort: 2 } },
      { field: 'name', meta: { sort: 3 } },
    ]);
    expect((await res.json<Data>()).data.map((f: any) => [f.field, f.meta.sort])).toEqual([
      ['steps', 2],
      ['name', 3],
    ]);
    const { data } = await (await api('GET', '/fields/recipes')).json<Data>();
    expect(data.map((f: any) => f.field)).toEqual(['id', 'steps', 'name']);
  });

  it.each([
    [{ field: 'renamed' }, "Fields can't be renamed"],
    [{ type: 'alias' }, `can't change from type "string" to "alias"`],
    [{ schema: { is_primary_key: true } }, 'A collection can only have one primary key'],
  ])('validates %j', async (body, reason) => {
    if (!(await tableSql('gadgets'))) await createWithTitle('gadgets');
    const res = await api('PATCH', '/fields/gadgets/title', body);
    expect((await firstError(res)).extensions.reason).toContain(reason);
  });

  it('protects the primary key', async () => {
    await createWithTitle('locked');
    expect((await firstError(await api('PATCH', '/fields/locked/id', { type: 'string' }))).extensions.reason).toContain(
      "primary key's type can't be changed",
    );
    expect((await firstError(await api('PATCH', '/fields/locked/id', { schema: { is_primary_key: false } }))).extensions.reason).toContain(
      "primary key can't be removed",
    );
    expect((await firstError(await api('DELETE', '/fields/locked/id'))).extensions.reason).toContain("primary key can't be deleted");
  });
});

describe('DELETE', () => {
  it('drops a field with its index and clears references to it', async () => {
    await create({
      collection: 'products',
      meta: { sort_field: 'rank' },
      schema: {},
      fields: [
        { field: 'sku', type: 'string', schema: { is_unique: true } },
        { field: 'rank', type: 'integer' },
      ],
    });
    expect((await api('DELETE', '/fields/products/sku')).status).toBe(204);
    expect((await api('DELETE', '/fields/products/rank')).status).toBe(204);
    expect(await tableColumns('products')).toEqual(['id']);
    expect(await tableIndexes('products')).toEqual([]);
    expect((await (await api('GET', '/collections/products')).json<Data>()).data.meta.sort_field).toBeNull();
  });

  it('drops a collection with its table and metadata, ungrouping its children', async () => {
    await create([{ collection: 'shop', schema: null }, { collection: 'orders', meta: { group: 'shop' }, schema: {} }]);
    expect((await api('DELETE', '/collections/orders')).status).toBe(204);
    expect(await tableSql('orders')).toBeNull();
    expect((await api('GET', '/fields/orders')).status).toBe(403);
    const left = await env.DB.prepare(`SELECT count(*) AS n FROM cirrus_fields WHERE collection = 'orders'`).first<{ n: number }>();
    expect(left?.n).toBe(0);

    await create({ collection: 'invoices', meta: { group: 'shop' }, schema: {} });
    expect((await api('DELETE', '/collections/shop')).status).toBe(204);
    expect((await (await api('GET', '/collections/invoices')).json<Data>()).data.meta.group).toBeNull();
    expect((await api('DELETE', '/collections/shop')).status).toBe(403);
  });
});

describe('schema version', () => {
  it('changes on every schema change, and only then', async () => {
    const v1 = await version();
    await createWithTitle('versioned');
    const v2 = await version();
    expect(v2).not.toBe(v1);
    await api('GET', '/collections/versioned');
    expect(await version()).toBe(v2);
    await api('PATCH', '/collections/versioned', { meta: { note: 'x' } });
    expect(await version()).not.toBe(v2);
  });

  it('a change planned against an outdated schema is rejected atomically', async () => {
    const stale = { version: '"outdated"' };
    const run = commit(env.DB, stale, [env.DB.prepare('CREATE TABLE should_not_exist (id TEXT)')], { collection: 'x' });
    await expect(run).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(await tableSql('should_not_exist')).toBeNull();
  });

  it('reads see changes made through another path', async () => {
    await createWithTitle('cached');
    await api('GET', '/collections/cached'); // warm the snapshot
    await env.DB.batch([
      env.DB.prepare(`UPDATE cirrus_collections SET note = 'edited' WHERE collection = 'cached'`),
      env.DB.prepare(`UPDATE cirrus_settings SET value = '"external"' WHERE key = 'schema_version'`),
    ]);
    expect((await (await api('GET', '/collections/cached')).json<Data>()).data.meta.note).toBe('edited');
  });
});
