import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ROLE, api, createUser, errorOf, login, ok } from './helpers.ts';

/** Every test in this file shares one D1 database, so each uses its own items (or collections). */

const post = (path: string, body: unknown, token?: string | null) => api('POST', path, body, token);
const get = (path: string, token?: string | null) => api('GET', path, undefined, token);
const data = async (res: Response) => (await ok(res)).data;

const alias = (field: string) => ({ field, type: 'alias', meta: { special: ['o2m'] } });
const autoId = { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } };

async function relate(body: Record<string, unknown>) {
  return data(await post('/relations', body));
}

beforeAll(async () => {
  const collections = [
    { collection: 'authors', schema: {}, fields: [{ field: 'name', type: 'string' }, { field: 'team', type: 'string' }, alias('posts')] },
    {
      collection: 'posts',
      schema: {},
      fields: [{ field: 'title', type: 'string' }, { field: 'author', type: 'uuid' }, { field: 'editor', type: 'uuid' }, alias('comments'), alias('tags')],
    },
    { collection: 'comments', schema: {}, fields: [{ field: 'post', type: 'uuid' }, { field: 'body', type: 'string' }, { field: 'rank', type: 'integer' }, { field: 'author', type: 'uuid' }] },
    { collection: 'tags', schema: {}, fields: [{ field: 'name', type: 'string' }, alias('posts')] },
    { collection: 'posts_tags', schema: {}, fields: [autoId, { field: 'posts_id', type: 'uuid' }, { field: 'tags_id', type: 'uuid' }] },
    { collection: 'categories', schema: {}, fields: [autoId, { field: 'name', type: 'string' }, { field: 'parent', type: 'integer' }, alias('children')] },
  ];
  await ok(await post('/collections', collections));
  await relate({ collection: 'posts', field: 'author', related_collection: 'authors', meta: { one_field: 'posts' }, schema: { on_delete: 'SET NULL' } });
  await relate({ collection: 'posts', field: 'editor', related_collection: 'authors', schema: null });
  await relate({ collection: 'comments', field: 'post', related_collection: 'posts', meta: { one_field: 'comments', one_deselect_action: 'delete', sort_field: 'rank' }, schema: { on_delete: 'CASCADE' } });
  await relate({ collection: 'comments', field: 'author', related_collection: 'authors' });
  await relate({ collection: 'posts_tags', field: 'posts_id', related_collection: 'posts', meta: { one_field: 'tags', junction_field: 'tags_id' }, schema: { on_delete: 'CASCADE' } });
  await relate({ collection: 'posts_tags', field: 'tags_id', related_collection: 'tags', meta: { one_field: 'posts', junction_field: 'posts_id' }, schema: { on_delete: 'CASCADE' } });
  await relate({ collection: 'categories', field: 'parent', related_collection: 'categories', meta: { one_field: 'children', sort_field: 'name' }, schema: { on_delete: 'CASCADE' } });
});

/** Create a post with an author, two comments and two tags; returns their keys. */
async function blogPost(title: string) {
  const p = await data(
    await post('/items/posts?fields=id,author,comments,tags.id,tags.tags_id', {
      title,
      author: { name: `${title} author`, team: 'red' },
      comments: [
        { body: `${title} first`, rank: 1 },
        { body: `${title} second`, rank: 2 },
      ],
      tags: [{ tags_id: { name: `${title} news` } }, { tags_id: { name: `${title} tech` } }],
    }),
  );
  return { id: p.id as string, author: p.author as string, comments: p.comments as string[], tags: p.tags as Array<{ id: number; tags_id: string }> };
}

// /relations ---------------------------------------------------------------------------------------

describe('/relations', () => {
  it('lists relations in the Directus shape', async () => {
    const all = await data(await get('/relations'));
    expect(all.map((r: any) => `${r.collection}.${r.field}`)).toEqual([
      'posts.author',
      'posts.editor',
      'comments.post',
      'comments.author',
      'posts_tags.posts_id',
      'posts_tags.tags_id',
      'categories.parent',
    ]);
    expect(all[0]).toEqual({
      collection: 'posts',
      field: 'author',
      related_collection: 'authors',
      meta: {
        id: expect.any(Number),
        many_collection: 'posts',
        many_field: 'author',
        one_collection: 'authors',
        one_field: 'posts',
        one_collection_field: null,
        one_allowed_collections: null,
        junction_field: null,
        sort_field: null,
        one_deselect_action: 'nullify',
      },
      schema: {
        table: 'posts',
        column: 'author',
        foreign_key_schema: null,
        foreign_key_table: 'authors',
        foreign_key_column: 'id',
        constraint_name: null,
        on_update: 'NO ACTION',
        on_delete: 'SET NULL',
      },
    });
    // schema: null keeps no foreign key; no schema at all gets one with NO ACTION, as in Directus.
    expect(all[1].schema).toBeNull();
    expect(all[3].schema.on_delete).toBe('NO ACTION');
  });

  it('reads the relations of a collection, and one relation', async () => {
    expect((await data(await get('/relations/posts_tags'))).map((r: any) => r.field)).toEqual(['posts_id', 'tags_id']);
    expect((await data(await get('/relations/comments/post'))).meta).toMatchObject({ one_field: 'comments', one_deselect_action: 'delete', sort_field: 'rank' });
    for (const path of ['/relations/posts/title', '/relations/nope', '/relations/nope/x']) {
      expect(await errorOf(await get(path))).toEqual({ status: 403, code: 'FORBIDDEN' });
    }
  });

  it('reports the foreign key on the field', async () => {
    const field = await data(await get('/fields/posts/author'));
    expect(field.schema).toMatchObject({ foreign_key_table: 'authors', foreign_key_column: 'id' });
    expect((await data(await get('/fields/posts/editor'))).schema).toMatchObject({ foreign_key_table: null, foreign_key_column: null });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ field: 'author', related_collection: 'authors' }, '"collection" is required'],
    [{ collection: 'posts', related_collection: 'authors' }, '"field" is required'],
    [{ collection: 'ghosts', field: 'x', related_collection: 'authors' }, 'Collection "ghosts" doesn\'t exist'],
    [{ collection: 'posts', field: 'nope', related_collection: 'authors' }, 'Field "nope" doesn\'t exist in collection "posts"'],
    [{ collection: 'posts', field: 'id', related_collection: 'authors' }, "posts's primary key can't be a foreign key"],
    [{ collection: 'posts', field: 'comments', related_collection: 'authors' }, 'Field "comments" in collection "posts" is an alias and can\'t hold keys'],
    [{ collection: 'posts', field: 'title', related_collection: null }, '"related_collection" is required: many-to-any relations aren\'t supported yet'],
    [{ collection: 'posts', field: 'title', related_collection: 'ghosts' }, 'Collection "ghosts" doesn\'t exist'],
    [{ collection: 'posts', field: 'title', related_collection: 'directus_permissions' }, 'Collection "directus_permissions" doesn\'t exist'],
    [{ collection: 'posts', field: 'author', related_collection: 'authors' }, 'Field "author" in collection "posts" already has an associated relationship'],
    [{ collection: 'posts', field: 'title', related_collection: 'authors' }, 'Field "title" of type "string" can\'t hold keys of collection "authors", which are of type "uuid"'],
    [{ collection: 'posts', field: 'title', related_collection: 'categories' }, 'Field "title" of type "string" can\'t hold keys of collection "categories", which are of type "integer"'],
    [{ collection: 'comments', field: 'body', related_collection: 'posts', meta: { one_field: 'title' } }, 'Field "body" of type "string" can\'t hold keys of collection "posts", which are of type "uuid"'],
    [{ collection: 'posts', field: 'title', related_collection: 'authors', meta: { one_collection_field: 'x' } }, "Many-to-any relations aren't supported yet"],
    [{ collection: 'posts', field: 'author', related_collection: 'authors', schema: { on_delete: 'EXPLODE' } }, '"schema.on_delete" must be one of SET NULL, CASCADE, RESTRICT, NO ACTION, SET DEFAULT'],
  ])('rejects %j', async (body, reason) => {
    expect(await errorOf(await post('/relations', body))).toEqual({ status: 400, code: 'INVALID_PAYLOAD', reason });
  });

  it('checks the meta it names', async () => {
    await ok(await post('/collections', { collection: 'notes', schema: {}, fields: [{ field: 'about', type: 'uuid' }, { field: 'n', type: 'integer' }] }));
    const base = { collection: 'notes', field: 'about', related_collection: 'authors' };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ one_field: 'name' }, 'Field "name" used as "one_field" has to be an alias field of collection "authors"'],
      [{ one_field: 'posts' }, 'Field "posts" in collection "authors" already has an associated relationship'],
      [{ junction_field: 'nope' }, 'Field "nope" used as "junction_field" doesn\'t exist in collection "notes"'],
      [{ junction_field: 'about' }, '"junction_field" must be another field of the junction collection'],
      [{ sort_field: 'nope' }, 'Field "nope" used as "sort_field" doesn\'t exist in collection "notes"'],
      [{ one_deselect_action: 'drop' }, '"meta.one_deselect_action" must be "nullify" or "delete"'],
    ];
    for (const [meta, reason] of cases) {
      expect(await errorOf(await post('/relations', { ...base, meta }))).toEqual({ status: 400, code: 'INVALID_PAYLOAD', reason });
    }
    expect(await errorOf(await post('/relations', base, null))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it("refuses a foreign key over values that reference nothing, and doesn't with schema: null", async () => {
    await ok(await post('/collections', { collection: 'links', schema: {}, fields: [{ field: 'to', type: 'uuid' }] }));
    await ok(await post('/items/links', { to: '0190f5b2-8c4a-7b3e-9f00-00000000dead' }));
    const body = { collection: 'links', field: 'to', related_collection: 'authors' };
    expect(await errorOf(await post('/relations', body))).toEqual({ status: 400, code: 'INVALID_FOREIGN_KEY', collection: 'links', field: 'to' });
    expect((await relate({ ...body, schema: null })).schema).toBeNull();
    // Adding the schema later checks again.
    expect(await errorOf(await api('PATCH', '/relations/links/to', { schema: { on_delete: 'CASCADE' } }))).toMatchObject({ code: 'INVALID_FOREIGN_KEY' });
  });

  it('updates the meta and the schema, and deletes', async () => {
    await ok(await post('/collections', { collection: 'drafts', schema: {}, fields: [{ field: 'writer', type: 'uuid' }, { field: 'order', type: 'integer' }] }));
    await relate({ collection: 'drafts', field: 'writer', related_collection: 'authors', schema: null });
    const updated = await data(await api('PATCH', '/relations/drafts/writer', { meta: { sort_field: 'order', one_deselect_action: 'delete' }, schema: { on_delete: 'cascade' } }));
    expect(updated.meta).toMatchObject({ sort_field: 'order', one_deselect_action: 'delete' });
    expect(updated.schema.on_delete).toBe('CASCADE');
    expect((await data(await api('PATCH', '/relations/drafts/writer', { schema: null }))).schema).toBeNull();
    expect(await errorOf(await api('PATCH', '/relations/drafts/writer', { related_collection: 'posts' }))).toMatchObject({ reason: "A relation's related collection can't be changed" });
    expect(await errorOf(await api('PATCH', '/relations/drafts/order', {}))).toEqual({ status: 403, code: 'FORBIDDEN' });

    const res = await api('DELETE', '/relations/drafts/writer');
    expect(res.status).toBe(204);
    expect(await errorOf(await get('/relations/drafts/writer'))).toEqual({ status: 403, code: 'FORBIDDEN' });
    // The field stays.
    expect((await data(await get('/fields/drafts/writer'))).field).toBe('writer');
  });

  it("keeps M2O fields' types compatible with the related key", async () => {
    expect(await errorOf(await api('PATCH', '/fields/posts/author', { type: 'string' }))).toMatchObject({
      reason: 'Field "author" holds keys of collection "authors", which are of type "uuid"',
    });
  });
});

// Reads ------------------------------------------------------------------------------------------

describe('reading relations', () => {
  let p: Awaited<ReturnType<typeof blogPost>>;
  beforeAll(async () => {
    p = await blogPost('Reading');
  });

  it('reads M2O fields: posts.author.name', async () => {
    expect(await data(await get(`/items/posts/${p.id}?fields=title,author.name`))).toEqual({ title: 'Reading', author: { name: 'Reading author' } });
    // Without subfields: the key.
    expect(await data(await get(`/items/posts/${p.id}?fields=author`))).toEqual({ author: p.author });
  });

  it('reads O2M fields in their sort field, and their keys with *', async () => {
    expect(await data(await get(`/items/posts/${p.id}?fields=comments.body`))).toEqual({ comments: [{ body: 'Reading first' }, { body: 'Reading second' }] });
    const all = await data(await get(`/items/posts/${p.id}`));
    expect(all).toEqual({ id: p.id, title: 'Reading', author: p.author, editor: null, comments: p.comments, tags: p.tags.map((t) => t.id) });
  });

  it('reads M2M fields: posts.tags.*', async () => {
    const { tags } = await data(await get(`/items/posts/${p.id}?fields=tags.*`));
    expect(tags).toEqual(p.tags.map((t) => ({ id: t.id, posts_id: p.id, tags_id: t.tags_id })));
    const named = await data(await get(`/items/posts/${p.id}?fields=tags.tags_id.name`));
    expect(named).toEqual({ tags: [{ tags_id: { name: 'Reading news' } }, { tags_id: { name: 'Reading tech' } }] });
    const back = await data(await get(`/items/tags/${p.tags[0]!.tags_id}?fields=name,posts.posts_id.title`));
    expect(back).toEqual({ name: 'Reading news', posts: [{ posts_id: { title: 'Reading' } }] });
  });

  it('expands *.*', async () => {
    const item = await data(await get(`/items/posts/${p.id}?fields=*.*`));
    expect(item.author).toMatchObject({ id: p.author, name: 'Reading author', posts: [p.id] });
    expect(item.comments).toHaveLength(2);
    expect(item.comments[0]).toMatchObject({ body: 'Reading first', post: p.id });
  });

  it('applies deep, as JSON and in bracket syntax', async () => {
    const deep = encodeURIComponent(JSON.stringify({ comments: { _sort: '-rank', _limit: 1 } }));
    expect(await data(await get(`/items/posts/${p.id}?fields=comments.rank&deep=${deep}`))).toEqual({ comments: [{ rank: 2 }] });
    expect(await data(await get(`/items/posts/${p.id}?fields=comments.rank&deep[comments][_filter][rank][_eq]=1`))).toEqual({ comments: [{ rank: 1 }] });
    expect(await errorOf(await get(`/items/posts/${p.id}?deep[comments][_group]=x`))).toMatchObject({ code: 'INVALID_QUERY' });
  });

  it('filters and sorts on relational fields', async () => {
    const other = await blogPost('Filtering');
    const titles = async (query: string) => (await data(await get(`/items/posts?fields=title&${query}`))).map((i: any) => i.title);
    expect(await titles('filter[author][name][_eq]=Filtering author')).toEqual(['Filtering']);
    expect(await titles('filter[comments][_some][body][_eq]=Reading second')).toEqual(['Reading']);
    expect(await titles(`filter[tags][tags_id][name][_eq]=Filtering tech`)).toEqual(['Filtering']);
    expect(await titles(`filter[id][_in]=${p.id},${other.id}&sort=-author.name`)).toEqual(['Reading', 'Filtering']);
    expect(await errorOf(await get('/items/posts?filter[author][nope][_eq]=x'))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      reason: 'You don\'t have permission to access field "author.nope" in collection "authors" or it does not exist.',
    });
  });

  it('caps relational depth', async () => {
    expect(await errorOf(await get('/items/posts?fields=a.b.c.d.e.f.g.h.i.j.k'))).toEqual({ status: 400, code: 'INVALID_QUERY', reason: 'Max relational depth exceeded' });
  });

  it('answers writes with related fields', async () => {
    const created = await data(await post('/items/comments?fields=body,post.title', { post: p.id, body: 'Answered', rank: 9 }));
    expect(created).toEqual({ body: 'Answered', post: { title: 'Reading' } });
  });
});

// Writes -----------------------------------------------------------------------------------------

describe('nested writes', () => {
  it('creates and links M2O items', async () => {
    const author = await data(await post('/items/authors', { name: 'Linked' }));
    const linked = await data(await post('/items/posts?fields=author.name', { title: 'Link', author: { id: author.id } }));
    expect(linked).toEqual({ author: { name: 'Linked' } });
    const updated = await data(await post('/items/posts?fields=author.name', { title: 'Rename', author: { id: author.id, name: 'Renamed' } }));
    expect(updated).toEqual({ author: { name: 'Renamed' } });
  });

  it('replaces O2M items, deselecting the others as the relation says', async () => {
    const p = await blogPost('Replace');
    // comments.post deselects with delete
    const kept = await data(await api('PATCH', `/items/posts/${p.id}?fields=comments.body`, { comments: [p.comments[1], { body: 'Replace third', rank: 3 }] }));
    expect(kept).toEqual({ comments: [{ body: 'Replace second' }, { body: 'Replace third' }] });
    expect((await data(await get(`/items/comments?filter[id][_eq]=${p.comments[0]}`))).length).toBe(0);
    // authors.posts deselects with nullify
    const author = await data(await post('/items/authors?fields=id,posts', { name: 'Two posts', posts: [{ title: 'A' }, { title: 'B' }] }));
    expect(author.posts).toHaveLength(2);
    await ok(await api('PATCH', `/items/authors/${author.id}`, { posts: [author.posts[0]] }));
    expect(await data(await get(`/items/posts/${author.posts[1]}?fields=title,author`))).toEqual({ title: 'B', author: null });
    expect(await data(await get(`/items/posts/${author.posts[0]}?fields=title,author`))).toEqual({ title: 'A', author: author.id });
  });

  it('changes O2M items one by one', async () => {
    const p = await blogPost('Changes');
    const result = await data(
      await api('PATCH', `/items/posts/${p.id}?fields=comments.body`, {
        comments: { create: [{ body: 'Changes new', rank: 0 }], update: [{ id: p.comments[0], body: 'Changes edited' }], delete: [p.comments[1]] },
      }),
    );
    expect(result).toEqual({ comments: [{ body: 'Changes new' }, { body: 'Changes edited' }] });
  });

  it('creates M2M links with new related items, in junctions with auto-increment keys', async () => {
    const p = await blogPost('Tags');
    expect(p.tags.map((t) => typeof t.id)).toEqual(['number', 'number']);
    const tag = await data(await post('/items/tags', { name: 'Existing tag' }));
    const result = await data(await api('PATCH', `/items/posts/${p.id}?fields=tags.tags_id.name`, { tags: [p.tags[0]!.id, { tags_id: tag.id }, { tags_id: { name: 'Brand new' } }] }));
    expect(result.tags.map((t: any) => t.tags_id.name)).toEqual(['Tags news', 'Existing tag', 'Brand new']);
  });

  it('creates nested items with auto-increment keys', async () => {
    const tree = await data(
      await post('/items/categories?fields=name,children.name,children.children.name', {
        name: 'Root',
        children: [{ name: 'B', children: [{ name: 'B1' }, { name: 'B2' }] }, { name: 'A', children: [{ name: 'A1' }] }],
      }),
    );
    expect(tree).toEqual({
      name: 'Root',
      children: [
        { name: 'A', children: [{ name: 'A1' }] },
        { name: 'B', children: [{ name: 'B1' }, { name: 'B2' }] },
      ],
    });
    const leaf = await data(await post('/items/categories?fields=name,parent.name', { name: 'Leaf', parent: { name: 'New parent' } }));
    expect(leaf).toEqual({ name: 'Leaf', parent: { name: 'New parent' } });
    const many = await data(await post('/items/categories?fields=name,children.name', [{ name: 'X', children: [{ name: 'X1' }] }, { name: 'Y' }, { name: 'Z', children: [{ name: 'Z1' }] }]));
    expect(many).toEqual([
      { name: 'X', children: [{ name: 'X1' }] },
      { name: 'Y', children: [] },
      { name: 'Z', children: [{ name: 'Z1' }] },
    ]);
  });

  it('checks that M2O keys reference items, unless the relation has no schema', async () => {
    const ghost = '0190f5b2-8c4a-7b3e-9f00-00000000beef';
    expect(await errorOf(await post('/items/posts', { title: 'Ghost', author: ghost }))).toEqual({ status: 400, code: 'INVALID_FOREIGN_KEY', collection: 'posts', field: 'author' });
    expect(await errorOf(await post('/items/posts', [{ title: 'Ghost', author: { id: ghost } }]))).toMatchObject({ code: 'INVALID_FOREIGN_KEY', field: 'author' });
    // Several guarded fields: the probe finds the one that failed.
    const author = await data(await post('/items/authors', { name: 'Real' }));
    const p = await data(await post('/items/posts', { title: 'Real' }));
    expect(await errorOf(await post('/items/comments', { post: p.id, author: ghost }))).toEqual({ status: 400, code: 'INVALID_FOREIGN_KEY', collection: 'comments', field: 'author' });
    expect(await errorOf(await post('/items/comments', { post: ghost, author: author.id }))).toEqual({ status: 400, code: 'INVALID_FOREIGN_KEY', collection: 'comments', field: 'post' });
    expect(await errorOf(await api('PATCH', `/items/posts/${p.id}`, { author: ghost }))).toMatchObject({ code: 'INVALID_FOREIGN_KEY' });
    // posts.editor was created with schema: null
    expect((await data(await post('/items/posts?fields=editor', { title: 'Ghost editor', editor: ghost }))).editor).toBe(ghost);
    // Nothing was written by the failed requests.
    expect((await data(await get('/items/posts?filter[title][_eq]=Ghost'))).length).toBe(0);
  });

  it('rolls back related writes when the item fails', async () => {
    const res = await post('/items/posts', { title: 'Rollback', author: { name: 'Rolled back' }, comments: [{ body: 'x', rank: 'NaN' }] });
    expect(await errorOf(res)).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect((await data(await get('/items/authors?filter[name][_eq]=Rolled back'))).length).toBe(0);
  });
});

describe('on_delete', () => {
  it('SET NULL, CASCADE (with M2M junctions) and NO ACTION', async () => {
    const p = await blogPost('Doomed');
    // comments.author → authors is NO ACTION: still referenced
    const commenter = await data(await post('/items/authors', { name: 'Commenter' }));
    await ok(await post('/items/comments', { post: p.id, author: commenter.id, body: 'mine' }));
    expect(await errorOf(await api('DELETE', `/items/authors/${commenter.id}`))).toEqual({ status: 400, code: 'INVALID_FOREIGN_KEY', collection: 'comments', field: 'author' });

    // posts.author → SET NULL
    expect((await api('DELETE', `/items/authors/${p.author}`)).status).toBe(204);
    expect(await data(await get(`/items/posts/${p.id}?fields=author`))).toEqual({ author: null });

    // Deleting the post cascades to its comments and junction rows; the commenter is free again.
    expect((await api('DELETE', `/items/posts/${p.id}`)).status).toBe(204);
    expect(await data(await get(`/items/comments?filter[post][_eq]=${p.id}`))).toEqual([]);
    expect(await data(await get(`/items/posts_tags?filter[posts_id][_eq]=${p.id}`))).toEqual([]);
    expect((await data(await get(`/items/tags/${p.tags[0]!.tags_id}?fields=posts`))).posts).toEqual([]);
    expect((await api('DELETE', `/items/authors/${commenter.id}`)).status).toBe(204);
  });

  it('cascades through whole self-referencing subtrees, by query too', async () => {
    const root = await data(await post('/items/categories', { name: 'Doomed root', children: [{ name: 'Doomed kid', children: [{ name: 'Doomed grandkid' }] }] }));
    await ok(await post('/items/categories', { name: 'Survivor' }));
    expect((await api('DELETE', '/items/categories', { query: { filter: { id: { _eq: root.id } } } })).status).toBe(204);
    expect((await data(await get('/items/categories?filter[name][_starts_with]=Doomed'))).length).toBe(0);
    expect((await data(await get('/items/categories?filter[name][_eq]=Survivor'))).length).toBe(1);
  });

  it('RESTRICT and SET DEFAULT', async () => {
    await ok(
      await post('/collections', [
        { collection: 'owners', schema: {}, fields: [autoId, { field: 'name', type: 'string' }] },
        { collection: 'pets', schema: {}, fields: [{ field: 'owner', type: 'integer' }, { field: 'keeper', type: 'integer', schema: { default_value: 1 } }] },
      ]),
    );
    await relate({ collection: 'pets', field: 'owner', related_collection: 'owners', schema: { on_delete: 'RESTRICT' } });
    await relate({ collection: 'pets', field: 'keeper', related_collection: 'owners', schema: { on_delete: 'SET DEFAULT' } });
    const [shelter, owner] = await data(await post('/items/owners', [{ name: 'Shelter' }, { name: 'Owner' }]));
    const pet = await data(await post('/items/pets', { owner: owner.id, keeper: owner.id }));
    expect(await errorOf(await api('DELETE', `/items/owners/${owner.id}`))).toMatchObject({ code: 'INVALID_FOREIGN_KEY', collection: 'pets', field: 'owner' });
    await ok(await api('PATCH', `/items/pets/${pet.id}`, { owner: shelter.id }));
    expect((await api('DELETE', `/items/owners/${owner.id}`)).status).toBe(204);
    expect(await data(await get(`/items/pets/${pet.id}?fields=keeper`))).toEqual({ keeper: shelter.id });
  });
});

// Schema -----------------------------------------------------------------------------------------

describe('schema changes', () => {
  it('deleting an M2O field deletes its relation and its O2M alias; deleting an alias keeps the relation', async () => {
    await ok(
      await post('/collections', [
        { collection: 'shelves', schema: {}, fields: [{ field: 'books', type: 'alias' }, { field: 'items', type: 'alias' }] },
        { collection: 'books', schema: {}, fields: [{ field: 'shelf', type: 'uuid' }, { field: 'spot', type: 'uuid' }] },
      ]),
    );
    await relate({ collection: 'books', field: 'shelf', related_collection: 'shelves', meta: { one_field: 'books' } });
    await relate({ collection: 'books', field: 'spot', related_collection: 'shelves', meta: { one_field: 'items' } });

    expect((await api('DELETE', '/fields/books/shelf')).status).toBe(204);
    expect(await errorOf(await get('/relations/books/shelf'))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await errorOf(await get('/fields/shelves/books'))).toEqual({ status: 403, code: 'FORBIDDEN' });

    expect((await api('DELETE', '/fields/shelves/items')).status).toBe(204);
    expect((await data(await get('/relations/books/spot'))).meta.one_field).toBeNull();
  });

  it('deleting a collection deletes the M2O fields pointing at it and the aliases listing its items', async () => {
    await ok(
      await post('/collections', [
        { collection: 'teams', schema: {}, fields: [{ field: 'name', type: 'string' }, { field: 'players', type: 'alias' }] },
        { collection: 'players', schema: {}, fields: [{ field: 'team', type: 'uuid' }, { field: 'name', type: 'string' }] },
      ]),
    );
    await relate({ collection: 'players', field: 'team', related_collection: 'teams', meta: { one_field: 'players' } });
    expect((await api('DELETE', '/collections/teams')).status).toBe(204);
    expect((await data(await get('/fields/players'))).map((f: any) => f.field)).toEqual(['id', 'name']);
    expect(await data(await get('/relations/players'))).toEqual([]);
    const columns = (await env.DB.prepare('PRAGMA table_info("players")').all<{ name: string }>()).results.map((c) => c.name);
    expect(columns).toEqual(['id', 'name']);

    await ok(
      await post('/collections', [
        { collection: 'leagues', schema: {}, fields: [{ field: 'clubs', type: 'alias' }] },
        { collection: 'clubs', schema: {}, fields: [{ field: 'league', type: 'uuid' }] },
      ]),
    );
    await relate({ collection: 'clubs', field: 'league', related_collection: 'leagues', meta: { one_field: 'clubs' } });
    expect((await api('DELETE', '/collections/clubs')).status).toBe(204);
    expect((await data(await get('/fields/leagues'))).map((f: any) => f.field)).toEqual(['id']);
  });
});

// Permissions and system collections ---------------------------------------------------------------

describe('permissions', () => {
  let token: string;
  let mine: Awaited<ReturnType<typeof blogPost>>;

  beforeAll(async () => {
    mine = await blogPost('Visible');
    const role = await data(await post('/roles', { name: 'Reader' }));
    const policy = await data(
      await post('/policies', {
        name: 'Reader',
        app_access: true,
        permissions: [
          { collection: 'posts', action: 'read', fields: ['*'] },
          // Only red authors, and not their team
          { collection: 'authors', action: 'read', fields: ['id', 'name', 'posts'], permissions: { team: { _eq: 'red' } } },
          // Comments ranked 1 only
          { collection: 'comments', action: 'read', fields: ['*'], permissions: { rank: { _eq: 1 } } },
          { collection: 'comments', action: 'create', fields: ['*'] },
          { collection: 'posts', action: 'update', fields: ['comments'] },
        ],
      }),
    );
    await ok(await api('PATCH', `/roles/${role.id}`, { policies: [{ policy: policy.id }] }));
    await createUser({ email: 'reader@example.com', password: 'secret-reader', role: role.id });
    token = (await login('reader@example.com', 'secret-reader')).access_token;
  });

  it('reads related items with the related collection\'s permissions', async () => {
    const item = await data(await get(`/items/posts/${mine.id}?fields=title,author.*,comments.*`, token));
    expect(item.author).toEqual({ id: mine.author, name: 'Visible author', posts: [mine.id] });
    expect(item.comments.map((c: any) => c.body)).toEqual(['Visible first']);
    // `*` leaves out what the request may not read; asking for it is FORBIDDEN.
    expect(Object.keys(await data(await get(`/items/posts/${mine.id}`, token)))).not.toContain('tags');
    expect(await errorOf(await get(`/items/posts/${mine.id}?fields=tags`, token))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      reason: 'You don\'t have permission to access collection "posts_tags" or it does not exist.',
    });
    expect(await errorOf(await get(`/items/posts/${mine.id}?fields=author.team`, token))).toMatchObject({ status: 403 });
  });

  it('filters on related items with their permissions', async () => {
    const titles = async (q: string) => (await data(await get(`/items/posts?fields=title&${q}`, token))).map((i: any) => i.title);
    expect(await titles('filter[comments][body][_eq]=Visible first')).toEqual(['Visible']);
    expect(await titles('filter[comments][body][_eq]=Visible second')).toEqual([]);
    expect(await errorOf(await get('/items/posts?filter[author][team][_eq]=red', token))).toMatchObject({ status: 403 });
  });

  it('applies permission filters that go through relations', async () => {
    const role = await data(await post('/roles', { name: 'Moderator' }));
    const policy = await data(
      await post('/policies', {
        name: 'Moderator',
        app_access: true,
        permissions: [
          { collection: 'comments', action: 'read', fields: ['*'] },
          // Only comments of posts by red authors
          { collection: 'comments', action: 'update', fields: ['body'], permissions: { post: { author: { team: { _eq: 'red' } } } } },
        ],
      }),
    );
    await ok(await api('PATCH', `/roles/${role.id}`, { policies: [{ policy: policy.id }] }));
    await createUser({ email: 'moderator@example.com', password: 'secret-moderator', role: role.id });
    const moderator = (await login('moderator@example.com', 'secret-moderator')).access_token;
    const blue = await data(await post('/items/posts?fields=id,comments', { title: 'Blue post', author: { name: 'Blue author', team: 'blue' }, comments: [{ body: 'blue' }] }));

    const red = mine.comments[0]!;
    expect(await data(await get(`/permissions/me/comments/${red}`, moderator))).toMatchObject({ update: { access: true } });
    expect(await data(await get(`/permissions/me/comments/${blue.comments[0]}`, moderator))).toMatchObject({ update: { access: false } });
    await ok(await api('PATCH', `/items/comments/${red}?fields=body`, { body: 'Moderated' }, moderator));
    expect(await errorOf(await api('PATCH', `/items/comments/${blue.comments[0]}`, { body: 'Moderated' }, moderator))).toMatchObject({ status: 403 });
    await ok(await api('PATCH', `/items/comments/${red}`, { body: 'Visible first' }));
  });

  it('checks the related collection\'s permissions on nested writes', async () => {
    const res = await api('PATCH', `/items/posts/${mine.id}?fields=comments.body`, { comments: { create: [{ body: 'Reader comment', rank: 1 }] } }, token);
    expect(await data(res)).toEqual({ comments: [{ body: 'Visible first' }, { body: 'Reader comment' }] });
    // Deselecting deletes, which the reader may not do.
    expect(await errorOf(await api('PATCH', `/items/posts/${mine.id}`, { comments: [] }, token))).toMatchObject({ status: 403 });
  });
});

describe('system relations', () => {
  it('reads users.role.name and roles.users', async () => {
    const role = await data(await post('/roles', { name: 'Relational role' }));
    const user = await createUser({ email: 'relational@example.com', password: 'secret-relational', role: role.id });
    expect(await data(await get(`/users/${user}?fields=email,role.name`))).toEqual({ email: 'relational@example.com', role: { name: 'Relational role' } });
    expect(await data(await get(`/roles/${role.id}?fields=users.email`))).toEqual({ users: [{ email: 'relational@example.com' }] });
    const { access_token } = await login('relational@example.com', 'secret-relational');
    // Without a permission to read themselves, users only get their id (Directus /users/me).
    expect(await data(await get('/users/me?fields=role.name', access_token))).toEqual({ id: user });
    expect(await data(await get(`/users/${user}?fields=policies.policy.name`))).toEqual({ policies: [] });
    expect(await data(await get(`/roles/${ADMIN_ROLE}?fields=policies.policy.admin_access`))).toEqual({ policies: [{ policy: { admin_access: true } }] });
  });

  it('relates user collections to directus_users, with on_delete when users are deleted', async () => {
    await ok(await post('/collections', { collection: 'memos', schema: {}, fields: [{ field: 'owner', type: 'uuid' }, { field: 'text', type: 'string' }] }));
    await relate({ collection: 'memos', field: 'owner', related_collection: 'directus_users', schema: { on_delete: 'SET NULL' } });
    const user = await createUser({ email: 'memo@example.com' });
    const memo = await data(await post('/items/memos?fields=id,owner.email', { owner: user, text: 'hi' }));
    expect(memo.owner).toEqual({ email: 'memo@example.com' });
    expect((await api('DELETE', `/users/${user}`)).status).toBe(204);
    expect(await data(await get(`/items/memos/${memo.id}?fields=owner`))).toEqual({ owner: null });
  });

  it('masks concealed fields of related items and refuses to filter or sort on them', async () => {
    await ok(await post('/collections', { collection: 'vaults', schema: {}, fields: [{ field: 'owner', type: 'uuid' }] }));
    await relate({ collection: 'vaults', field: 'owner', related_collection: 'directus_users' });
    const user = await createUser({ email: 'concealed@example.com', password: 'secret-concealed' });
    expect(await data(await post('/items/vaults?fields=owner.email,owner.password', { owner: user }))).toEqual({
      owner: { email: 'concealed@example.com', password: '**********' },
    });
    expect(await errorOf(await get('/items/vaults?filter[owner][password][_starts_with]=$'))).toMatchObject({ code: 'INVALID_QUERY' });
    expect(await errorOf(await get('/items/vaults?sort=owner.password'))).toMatchObject({ code: 'INVALID_QUERY' });
    expect((await data(await get('/items/vaults?filter[owner][password][_nnull]=true'))).length).toBe(1);
  });

  it('reads a singleton without its item with null and empty relational fields', async () => {
    await ok(
      await post('/collections', {
        collection: 'homepage',
        meta: { singleton: true },
        schema: {},
        fields: [{ field: 'headline', type: 'string', schema: { default_value: 'Welcome' } }, { field: 'hero', type: 'uuid' }],
      }),
    );
    await relate({ collection: 'homepage', field: 'hero', related_collection: 'authors' });
    expect(await data(await get('/items/homepage?fields=headline,hero.name'))).toEqual({ headline: 'Welcome', hero: null });
  });

  it('resolves $CURRENT_USER paths through relations in permissions', async () => {
    await ok(await post('/collections', { collection: 'boards', schema: {}, fields: [{ field: 'team', type: 'string' }] }));
    const role = await data(await post('/roles', { name: 'Blue' }));
    const policy = await data(
      await post('/policies', {
        name: 'Boards by role name',
        permissions: [{ collection: 'boards', action: 'read', fields: ['*'], permissions: { team: { _eq: '$CURRENT_USER.role.name' } } }],
      }),
    );
    await ok(await api('PATCH', `/roles/${role.id}`, { policies: [{ policy: policy.id }] }));
    await createUser({ email: 'blue@example.com', password: 'secret-blue', role: role.id });
    const { access_token } = await login('blue@example.com', 'secret-blue');
    await ok(await post('/items/boards', [{ team: 'Blue' }, { team: 'Red' }]));
    expect((await data(await get('/items/boards?fields=team', access_token))).map((b: any) => b.team)).toEqual(['Blue']);
  });
});
