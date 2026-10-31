import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, errorOf, login, ok, tableColumns } from './helpers.ts';

/**
 * Every test in this file shares one D1 database, and a snapshot covers every collection, so each
 * test starts from an empty schema.
 */

type Json = Record<string, any>;

const post = (path: string, body: unknown, token?: string | null) => api('POST', path, body, token);
const data = async (res: Response) => (await ok(res)).data;
const snapshot = async (): Promise<Json> => data(await api('GET', '/schema/snapshot'));
const diff = (body: unknown, query = '') => post(`/schema/diff${query}`, body);
const apply = (body: unknown) => post('/schema/apply', body);

/** Diff against `target` and apply; returns the diff. */
async function sync(target: Json): Promise<Json> {
  const res = await diff(target);
  expect(res.status).toBe(200);
  const { data: d } = await res.json<{ data: Json }>();
  const applied = await apply(d);
  if (applied.status !== 204) throw new Error(`apply: ${applied.status} ${await applied.text()}`);
  return d;
}

const alias = (field: string, special = 'o2m') => ({ field, type: 'alias', meta: { special: [special] } });
const autoId = { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } };

/** Authors with posts (M2O + O2M), tags (M2M through posts_tags), and a folder grouping them. */
async function blog() {
  await ok(
    await post('/collections', [
      { collection: 'blog', meta: { icon: 'folder' } },
      { collection: 'authors', schema: {}, meta: { group: 'blog' }, fields: [{ field: 'name', type: 'string', schema: { is_nullable: false, default_value: 'anon' } }, alias('posts')] },
      { collection: 'posts', schema: {}, meta: { group: 'blog', sort_field: 'rank' }, fields: [{ field: 'title', type: 'string' }, { field: 'rank', type: 'integer' }, { field: 'author', type: 'uuid' }, alias('tags', 'm2m')] },
      { collection: 'tags', schema: {}, fields: [autoId, { field: 'name', type: 'string', schema: { is_unique: true } }] },
      { collection: 'posts_tags', schema: {}, meta: { hidden: true }, fields: [autoId, { field: 'posts_id', type: 'uuid' }, { field: 'tags_id', type: 'integer' }] },
    ]),
  );
  await ok(await post('/relations', { collection: 'posts', field: 'author', related_collection: 'authors', meta: { one_field: 'posts', sort_field: 'rank' }, schema: { on_delete: 'SET NULL' } }));
  await ok(await post('/relations', { collection: 'posts_tags', field: 'posts_id', related_collection: 'posts', meta: { one_field: 'tags', junction_field: 'tags_id' }, schema: { on_delete: 'CASCADE' } }));
  await ok(await post('/relations', { collection: 'posts_tags', field: 'tags_id', related_collection: 'tags', meta: { junction_field: 'posts_id' }, schema: null }));
}

beforeEach(async () => {
  const { data: list } = await ok<Json[]>(await api('GET', '/collections'));
  for (const c of list) {
    // Deleting a group collection ungroups its children, which may already be gone.
    const res = await api('DELETE', `/collections/${c.collection}`);
    expect([204, 403]).toContain(res.status);
  }
  expect((await snapshot()).collections).toEqual([]);
});

describe('GET /schema/snapshot', () => {
  it("returns Directus' snapshot: collections, fields and relations without ids", async () => {
    await blog();
    const s = await snapshot();
    expect(s).toMatchObject({ version: 1, directus: '11.17.4', vendor: 'sqlite', systemFields: [] });
    expect(s.collections.map((c: Json) => c.collection)).toEqual(['authors', 'blog', 'posts', 'posts_tags', 'tags']);
    expect(s.collections[1]).toEqual({ collection: 'blog', meta: expect.objectContaining({ collection: 'blog', icon: 'folder', group: null }), schema: null });
    expect(s.collections[0]).toMatchObject({ collection: 'authors', meta: { group: 'blog' }, schema: { name: 'authors' } });

    const name = s.fields.find((f: Json) => f.collection === 'authors' && f.field === 'name');
    expect(name).toMatchObject({
      collection: 'authors',
      field: 'name',
      type: 'string',
      meta: { collection: 'authors', field: 'name', interface: null, sort: 2 },
      schema: { name: 'name', table: 'authors', data_type: 'text', default_value: 'anon', max_length: 255, is_nullable: false, is_primary_key: false },
    });
    expect(name.meta).not.toHaveProperty('id');
    expect(name.schema).not.toHaveProperty('comment');
    // Keys are sorted, as Directus sorts them.
    expect(Object.keys(name)).toEqual(['collection', 'field', 'meta', 'schema', 'type']);
    expect(s.fields.find((f: Json) => f.field === 'author').schema).toMatchObject({ foreign_key_table: 'authors', foreign_key_column: 'id' });

    expect(s.relations.map((r: Json) => `${r.collection}.${r.field}`)).toEqual(['posts.author', 'posts_tags.posts_id', 'posts_tags.tags_id']);
    expect(s.relations[0]).toEqual({
      collection: 'posts',
      field: 'author',
      related_collection: 'authors',
      meta: {
        junction_field: null,
        many_collection: 'posts',
        many_field: 'author',
        one_allowed_collections: null,
        one_collection: 'authors',
        one_collection_field: null,
        one_deselect_action: 'nullify',
        one_field: 'posts',
        sort_field: 'rank',
      },
      schema: { column: 'author', constraint_name: null, foreign_key_column: 'id', foreign_key_table: 'authors', on_delete: 'SET NULL', on_update: 'NO ACTION', table: 'posts' },
    });
    expect(s.relations[2].schema).toBeNull();
  });

  it('downloads as a JSON file with ?export=json', async () => {
    await blog();
    const res = await api('GET', '/schema/snapshot?export=json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="schema-\d+\.json"$/);
    expect(await res.json()).toEqual(await snapshot());
    expect(await errorOf(await api('GET', '/schema/snapshot?export=yaml'))).toMatchObject({ status: 400, code: 'INVALID_QUERY' });
  });

  it('is for admins only', async () => {
    await createUser({ email: 'schema-user@example.com', password: 'pw-123456' });
    const { access_token } = await login('schema-user@example.com', 'pw-123456');
    for (const res of [
      await api('GET', '/schema/snapshot', undefined, access_token),
      await api('GET', '/schema/snapshot', undefined, null),
      await post('/schema/diff', {}, access_token),
      await post('/schema/apply', {}, access_token),
    ]) {
      expect(await errorOf(res)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
  });
});

describe('POST /schema/diff', () => {
  it('answers 204 when the snapshot matches', async () => {
    await blog();
    const res = await diff(await snapshot());
    expect(res.status).toBe(204);
  });

  it("reports the differences in deep-diff's format, with the current schema's hash", async () => {
    await blog();
    const target = await snapshot();
    // Edit: a note on posts, a longer title, a new field, no more tags.
    target.collections.find((c: Json) => c.collection === 'posts').meta.note = 'Articles';
    target.fields.find((f: Json) => f.field === 'title').schema.max_length = 500;
    target.fields.push({ collection: 'posts', field: 'body', type: 'text', meta: { interface: 'input-rich-text-html' }, schema: {} });
    target.collections = target.collections.filter((c: Json) => c.collection !== 'tags');
    target.fields = target.fields.filter((f: Json) => f.collection !== 'tags');
    target.relations = target.relations.filter((r: Json) => r.related_collection !== 'tags');

    const { data: d } = await (await diff(target)).json<{ data: Json }>();
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.diff.collections).toEqual([
      { collection: 'posts', diff: [{ kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Articles' }] },
      { collection: 'tags', diff: [{ kind: 'D', lhs: expect.objectContaining({ collection: 'tags' }) }] },
    ]);
    // Fields of a deleted collection aren't listed; the new field comes with its defaults.
    expect(d.diff.fields.map((f: Json) => [f.collection, f.field, f.diff[0].kind])).toEqual([
      ['posts', 'body', 'N'],
      ['posts', 'title', 'E'],
    ]);
    expect(d.diff.fields[0].diff[0].rhs).toMatchObject({ field: 'body', meta: { interface: 'input-rich-text-html', width: 'full', sort: null }, schema: { is_nullable: true } });
    expect(d.diff.fields[1].diff).toEqual([{ kind: 'E', path: ['schema', 'max_length'], lhs: 255, rhs: 500 }]);
    expect(d.diff.relations).toEqual([{ collection: 'posts_tags', field: 'tags_id', related_collection: 'tags', diff: [{ kind: 'D', lhs: expect.objectContaining({ field: 'tags_id' }) }] }]);
    expect(d.diff.systemFields).toEqual([]);
  });

  it('checks the version and database of the snapshot unless forced', async () => {
    const s = await snapshot();
    expect(await errorOf(await diff({ ...s, directus: '10.0.0' }))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
    const vendor = await diff({ ...s, vendor: 'postgres' });
    expect((await (await vendor.clone()).json<Json>()).errors[0].message).toContain('You can bypass this check by passing the "force" query parameter');
    expect(vendor.status).toBe(400);
    expect((await diff({ ...s, vendor: 'postgres', directus: '10.0.0' }, '?force=true')).status).toBe(204);
    expect(await errorOf(await diff({ ...s, version: 2 }, '?force=true'))).toMatchObject({ status: 400 });
    expect(await errorOf(await diff({ ...s, fields: {} }))).toMatchObject({ status: 400, reason: '"fields" must be an array' });
  });

  it('checks the snapshot as the API checks each change', async () => {
    await blog();
    const s = await snapshot();
    const without = (list: Json[], pred: (x: Json) => boolean) => list.filter((x) => !pred(x));
    const cases: Array<[Json, string]> = [
      [{ ...s, fields: without(s.fields, (f) => f.collection === 'tags' && f.field === 'id') }, 'Collection "tags" needs exactly one primary key field'],
      [{ ...s, fields: [...s.fields, { collection: 'nowhere', field: 'x', type: 'string' }] }, 'Field "x" belongs to collection "nowhere", which isn\'t in the snapshot'],
      [{ ...s, fields: [...s.fields, { collection: 'blog', field: 'x', type: 'string' }] }, 'Collection "blog" is a folder and can\'t have fields'],
      [{ ...s, fields: [...s.fields, { collection: 'directus_users', field: 'x', type: 'string' }] }, 'the fields of system collections can\'t be changed'],
      [{ ...s, collections: without(s.collections, (c) => c.collection === 'blog') }, 'Collection "blog" used as group doesn\'t exist'],
      [{ ...s, relations: [...s.relations, { collection: 'posts', field: 'title', related_collection: 'tags' }] }, 'Field "title" of type "string" can\'t hold keys of collection "tags", which are of type "integer"'],
      [{ ...s, fields: s.fields.map((f: Json) => (f.collection === 'tags' && f.field === 'id' ? { ...f, type: 'bigInteger' } : f)) }, 'The primary key of collection "tags" can\'t be changed'],
      [{ ...s, fields: s.fields.map((f: Json) => (f.field === 'posts' ? { ...f, type: 'string', schema: {} } : f)) }, 'Field "posts" in collection "authors" can\'t change from type "alias" to "string"'],
      [{ ...s, collections: s.collections.map((c: Json) => (c.collection === 'blog' ? { ...c, schema: { name: 'blog' } } : c)), fields: [...s.fields, { ...s.fields.find((f: Json) => f.collection === 'tags' && f.field === 'id'), collection: 'blog' }] }, 'Collection "blog" can\'t change between a folder and a collection with a table'],
    ];
    for (const [target, reason] of cases) {
      const error = await errorOf(await diff(target));
      expect(error, reason).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
      expect(error.reason).toContain(reason);
    }
  });
});

describe('POST /schema/apply', () => {
  it('turns the schema into the snapshot, keeping data in the tables that stay', async () => {
    await blog();
    const original = await snapshot();
    const { data: author } = await ok(await post('/items/authors', { name: 'Ann' }));
    await ok(await post('/items/posts', { title: 'Hello', rank: 1, author: author.id }));

    // Change it by hand, then bring it back from the snapshot.
    await ok(await api('PATCH', '/fields/posts/title', { schema: { max_length: 20, is_nullable: false } }));
    await ok(await api('PATCH', '/collections/posts', { meta: { note: 'changed' } }));
    await ok(await post('/fields/posts', { field: 'extra', type: 'json' }));
    expect((await api('DELETE', '/fields/authors/posts')).status).toBe(204);
    expect((await api('DELETE', '/collections/tags')).status).toBe(204);
    await ok(await post('/collections', { collection: 'scratch', schema: {}, fields: [{ field: 'x', type: 'string' }] }));

    const d = await sync(original);
    expect(d.diff.collections.map((c: Json) => c.collection)).toEqual(['posts', 'scratch', 'tags']);

    expect(await snapshot()).toEqual(original);
    expect((await diff(original)).status).toBe(204);
    expect(await tableColumns('posts')).not.toContain('extra');
    expect(await tableColumns('scratch')).toEqual([]);
    const { data: posts } = await ok(await api('GET', '/items/posts?fields=title,author.name'));
    expect(posts).toEqual([{ title: 'Hello', author: { name: 'Ann' } }]);
    // The O2M alias is back, and so is the M2M through the recreated tags.
    const { data: authors } = await ok(await api('GET', '/items/authors?fields=name,posts.title'));
    expect(authors).toEqual([{ name: 'Ann', posts: [{ title: 'Hello' }] }]);
    const { data: tag } = await ok(await post('/items/tags', { name: 'news' }));
    const { data: ids } = await ok(await api('GET', '/items/posts?fields=id'));
    const { data: tagged } = await ok(await api('PATCH', `/items/posts/${ids[0].id}?fields=tags.tags_id.name`, { tags: [{ tags_id: tag.id }] }));
    expect(tagged.tags).toEqual([{ tags_id: { name: 'news' } }]);
  });

  it('builds a whole schema from nothing', async () => {
    await blog();
    const target = await snapshot();
    const { data: list } = await ok<Json[]>(await api('GET', '/collections'));
    for (const c of list) await api('DELETE', `/collections/${c.collection}`);
    expect((await snapshot()).collections).toEqual([]);

    await sync(target);
    expect(await snapshot()).toEqual(target);
    expect(await tableColumns('posts_tags')).toEqual(['id', 'posts_id', 'tags_id']);
    // The new collections work: the unique index is there, and the grouping too.
    await ok(await post('/items/tags', { name: 'a' }));
    expect(await errorOf(await post('/items/tags', { name: 'a' }))).toMatchObject({ code: 'RECORD_NOT_UNIQUE' });
    expect((await data(await api('GET', '/collections/authors'))).meta.group).toBe('blog');
  });

  it('refuses a diff made against another schema', async () => {
    await blog();
    const target = await snapshot();
    target.collections[0].meta.note = 'x';
    const { data: d } = await (await diff(target)).json<{ data: Json }>();
    await ok(await api('PATCH', '/collections/tags', { meta: { note: 'meanwhile' } }));
    const error = await errorOf(await apply(d));
    expect(error).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
    expect(error.reason).toContain('Provided hash does not match');
    expect(await errorOf(await apply({ diff: d.diff }))).toMatchObject({ status: 400 });
    expect(await errorOf(await apply({ hash: d.hash, diff: { collections: [{ collection: 'x', diff: [{ kind: 'Q' }] }] } }))).toMatchObject({ status: 400 });
  });

  it('applies all or nothing', async () => {
    await blog();
    const { data: post1 } = await ok(await post('/items/posts', { rank: 1 }));
    const target = await snapshot();
    // A new collection, and a title that may no longer be empty while a post has none.
    target.collections.push({ collection: 'pages', meta: null, schema: { name: 'pages' } });
    target.fields.push({ collection: 'pages', field: 'id', type: 'uuid', meta: null, schema: { is_primary_key: true } });
    target.fields.find((f: Json) => f.field === 'title').schema.is_nullable = false;
    const { data: d } = await (await diff(target)).json<{ data: Json }>();

    const before = await snapshot();
    expect(await errorOf(await apply(d))).toMatchObject({ status: 400, code: 'CONTAINS_NULL_VALUES', collection: 'posts', field: 'title' });
    expect(await snapshot()).toEqual(before);
    expect(await tableColumns('pages')).toEqual([]);

    // Once the data fits, the same diff applies.
    await ok(await api('PATCH', `/items/posts/${post1.id}`, { title: 'Now titled' }));
    expect((await apply(d)).status).toBe(204);
    expect(await tableColumns('pages')).toEqual(['id']);
  });

  it('checks existing keys when a relation starts being enforced', async () => {
    await blog();
    await ok(await post('/items/posts_tags', { tags_id: 999 }));
    const target = await snapshot();
    target.relations.find((r: Json) => r.field === 'tags_id').schema = { on_delete: 'CASCADE' };
    const { data: d } = await (await diff(target)).json<{ data: Json }>();
    expect(await errorOf(await apply(d))).toMatchObject({ status: 400, code: 'INVALID_FOREIGN_KEY' });
  });

  it('imports a snapshot of a Directus project on Postgres, with force', async () => {
    const res = await diff(DIRECTUS_POSTGRES_SNAPSHOT);
    expect(res.status).toBe(400);
    const forced = await diff(DIRECTUS_POSTGRES_SNAPSHOT, '?force=true');
    expect(forced.status).toBe(200);
    const { data: d } = await forced.json<{ data: Json }>();
    expect((await apply(d)).status).toBe(204);

    const s = await snapshot();
    expect(s.collections.map((c: Json) => c.collection)).toEqual(['articles']);
    expect(s.fields.map((f: Json) => `${f.field}:${f.type}`)).toEqual(['id:integer', 'status:string', 'user_created:uuid', 'date_created:timestamp', 'title:string']);
    expect(s.relations).toMatchObject([{ collection: 'articles', field: 'user_created', related_collection: 'directus_users', schema: { on_delete: 'NO ACTION' } }]);

    const { data: item } = await ok(await post('/items/articles', { title: 'From Directus' }));
    expect(item).toMatchObject({ id: 1, status: 'draft', title: 'From Directus' });
    // Applying it again changes nothing.
    expect((await diff(DIRECTUS_POSTGRES_SNAPSHOT, '?force=true')).status).toBe(204);
  });
});

describe('@directus/sdk', () => {
  it('schemaSnapshot() / schemaDiff() / schemaApply()', async () => {
    const { createDirectus, rest, schemaApply, schemaDiff, schemaSnapshot, staticToken } = await import('@directus/sdk');
    const { ADMIN_TOKEN, BASE, workerFetch } = await import('./helpers.ts');
    const client = createDirectus(BASE, { globals: { fetch: workerFetch } }).with(staticToken(ADMIN_TOKEN)).with(rest());
    await blog();
    const target = await client.request(schemaSnapshot());
    await api('DELETE', '/collections/posts_tags');
    const d = await client.request(schemaDiff(target));
    expect(d.diff.collections).toEqual([{ collection: 'posts_tags', diff: [{ kind: 'N', rhs: expect.objectContaining({ collection: 'posts_tags' }) }] }]);
    await client.request(schemaApply(d));
    expect(await client.request(schemaSnapshot())).toEqual(target);
  });
});

/** What Directus 11 on Postgres returns for a collection made in its app (trimmed to the parts Cirrus reads, plus some it ignores). */
const DIRECTUS_POSTGRES_SNAPSHOT = {
  version: 1,
  directus: '11.10.0',
  vendor: 'postgres',
  collections: [
    {
      collection: 'articles',
      meta: { accountability: 'all', archive_app_filter: true, archive_field: 'status', archive_value: 'archived', collapse: 'open', collection: 'articles', color: null, display_template: null, group: null, hidden: false, icon: null, item_duplication_fields: null, note: null, preview_url: null, singleton: false, sort: null, sort_field: null, translations: null, unarchive_value: 'draft', versioning: false },
      schema: { name: 'articles', schema: 'public', comment: null },
    },
  ],
  fields: [
    {
      collection: 'articles',
      field: 'id',
      type: 'integer',
      meta: { collection: 'articles', conditions: null, display: null, display_options: null, field: 'id', group: null, hidden: true, interface: 'input', note: null, options: null, readonly: true, required: false, sort: 1, special: null, translations: null, validation: null, validation_message: null, width: 'full', searchable: true },
      schema: { name: 'id', table: 'articles', data_type: 'integer', default_value: "nextval('articles_id_seq'::regclass)", max_length: null, numeric_precision: 32, numeric_scale: 0, is_nullable: false, is_unique: true, is_indexed: false, is_primary_key: true, is_generated: false, generation_expression: null, has_auto_increment: true, foreign_key_table: null, foreign_key_column: null },
    },
    {
      collection: 'articles',
      field: 'status',
      type: 'string',
      meta: { collection: 'articles', field: 'status', interface: 'select-dropdown', options: { choices: [{ text: 'Published', value: 'published' }, { text: 'Draft', value: 'draft' }] }, display: 'labels', sort: 2, width: 'full', special: null, required: false, hidden: false, readonly: false },
      schema: { name: 'status', table: 'articles', data_type: 'character varying', default_value: 'draft', max_length: 255, numeric_precision: null, numeric_scale: null, is_nullable: false, is_unique: false, is_indexed: false, is_primary_key: false, is_generated: false, generation_expression: null, has_auto_increment: false, foreign_key_table: null, foreign_key_column: null },
    },
    {
      collection: 'articles',
      field: 'user_created',
      type: 'uuid',
      meta: { collection: 'articles', field: 'user_created', interface: 'select-dropdown-m2o', special: ['user-created'], hidden: true, readonly: true, sort: 3, width: 'half' },
      schema: { name: 'user_created', table: 'articles', data_type: 'uuid', default_value: null, max_length: null, numeric_precision: null, numeric_scale: null, is_nullable: true, is_unique: false, is_indexed: false, is_primary_key: false, is_generated: false, generation_expression: null, has_auto_increment: false, foreign_key_table: 'directus_users', foreign_key_column: 'id' },
    },
    {
      collection: 'articles',
      field: 'date_created',
      type: 'timestamp',
      meta: { collection: 'articles', field: 'date_created', interface: 'datetime', special: ['date-created'], hidden: true, readonly: true, sort: 4, width: 'half' },
      schema: { name: 'date_created', table: 'articles', data_type: 'timestamp with time zone', default_value: null, max_length: null, numeric_precision: null, numeric_scale: null, is_nullable: true, is_unique: false, is_indexed: false, is_primary_key: false, is_generated: false, generation_expression: null, has_auto_increment: false, foreign_key_table: null, foreign_key_column: null },
    },
    {
      collection: 'articles',
      field: 'title',
      type: 'string',
      meta: { collection: 'articles', field: 'title', interface: 'input', sort: 5, width: 'full', special: null, required: true },
      schema: { name: 'title', table: 'articles', data_type: 'character varying', default_value: null, max_length: 255, numeric_precision: null, numeric_scale: null, is_nullable: true, is_unique: false, is_indexed: false, is_primary_key: false, is_generated: false, generation_expression: null, has_auto_increment: false, foreign_key_table: null, foreign_key_column: null },
    },
  ],
  systemFields: [{ collection: 'directus_activity', field: 'timestamp', schema: { is_indexed: true } }],
  relations: [
    {
      collection: 'articles',
      field: 'user_created',
      related_collection: 'directus_users',
      meta: { junction_field: null, many_collection: 'articles', many_field: 'user_created', one_allowed_collections: null, one_collection: 'directus_users', one_collection_field: null, one_deselect_action: 'nullify', one_field: null, sort_field: null },
      schema: { table: 'articles', column: 'user_created', foreign_key_table: 'directus_users', foreign_key_column: 'id', foreign_key_schema: 'public', constraint_name: 'articles_user_created_foreign', on_update: 'NO ACTION', on_delete: 'NO ACTION' },
    },
  ],
};
