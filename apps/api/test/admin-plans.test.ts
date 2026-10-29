import { beforeAll, describe, expect, it } from 'vitest';
import { collectionPlan, fieldPlan, type Step } from '../../admin/src/lib/builder.ts';
import type { FieldType } from '../../admin/src/lib/schema.ts';
import { ADMIN_ROLE, api, call, createUser, ok } from './helpers.ts';

/**
 * The admin app builds data models with plans of API calls (apps/admin/src/lib/builder.ts). These
 * run them against the Worker: the payloads must be accepted, and the collections, fields and
 * relations they create must work for items.
 */

async function run(steps: Step[]) {
  for (const step of steps) {
    if (step.op === 'createCollection') await ok(await api('POST', '/collections', step.payload));
    else if (step.op === 'createField') await ok(await api('POST', `/fields/${step.collection}`, step.payload));
    else await ok(await api('POST', '/relations', step.payload));
  }
}

const keys: Record<string, FieldType> = { authors: 'uuid', posts: 'uuid', tags: 'integer', directus_files: 'uuid', directus_users: 'uuid' };
const keyType = (collection: string) => keys[collection]!;

let token: string;

beforeAll(async () => {
  await run(collectionPlan({ name: 'authors', primaryKey: { field: 'id', kind: 'uuid' } }));
  await run(fieldPlan({ collection: 'authors', field: 'name', kind: 'string', required: true }, keyType));
  await run(collectionPlan({ name: 'tags', primaryKey: { field: 'id', kind: 'integer' } }));
  await run(fieldPlan({ collection: 'tags', field: 'label', kind: 'string', unique: true }, keyType));
  await run(
    collectionPlan({
      name: 'posts',
      primaryKey: { field: 'id', kind: 'uuid' },
      optional: ['status', 'sort', 'user_created', 'date_created', 'user_updated', 'date_updated'],
    }),
  );
  for (const plan of [
    fieldPlan({ collection: 'posts', field: 'title', kind: 'string', required: true }, keyType),
    fieldPlan({ collection: 'posts', field: 'body', kind: 'markdown' }, keyType),
    fieldPlan({ collection: 'posts', field: 'cover', kind: 'image' }, keyType),
    fieldPlan({ collection: 'posts', field: 'author', kind: 'm2o', related: 'authors', reverse: 'posts' }, keyType),
    fieldPlan({ collection: 'posts', field: 'tags', kind: 'm2m', related: 'tags' }, keyType),
    fieldPlan({ collection: 'posts', field: 'views', kind: 'integer', defaultValue: 0 }, keyType),
    fieldPlan({ collection: 'posts', field: 'rating', kind: 'float' }, keyType),
    fieldPlan({ collection: 'posts', field: 'featured', kind: 'boolean' }, keyType),
    fieldPlan({ collection: 'posts', field: 'published_on', kind: 'timestamp' }, keyType),
    fieldPlan({ collection: 'posts', field: 'day', kind: 'date' }, keyType),
    fieldPlan({ collection: 'posts', field: 'kind', kind: 'select', choices: [{ text: 'News', value: 'news' }] }, keyType),
    fieldPlan({ collection: 'posts', field: 'keywords', kind: 'tags' }, keyType),
    fieldPlan({ collection: 'posts', field: 'extra', kind: 'json' }, keyType),
    fieldPlan({ collection: 'posts', field: 'seo', kind: 'divider' }, keyType),
    fieldPlan({ collection: 'authors', field: 'drafts', kind: 'o2m', related: 'posts', foreignKey: 'reviewer' }, keyType),
  ]) {
    await run(plan);
  }

  await createUser({ email: 'writer@example.com', password: 'writer-password', role: ADMIN_ROLE });
  const login = await ok<{ access_token: string }>(await api('POST', '/auth/login', { email: 'writer@example.com', password: 'writer-password' }, null));
  token = login.data.access_token;
});

describe('data model plans of the admin app', () => {
  it('create the relations the app shows', async () => {
    const { data } = await ok<Array<{ collection: string; field: string; related_collection: string; meta: Record<string, unknown> }>>(await api('GET', '/relations'));
    const summary = data.map((r) => `${r.collection}.${r.field} → ${r.related_collection} (${r.meta.one_field ?? '-'}, ${r.meta.junction_field ?? '-'})`).sort();
    expect(summary).toEqual([
      'posts.author → authors (posts, -)',
      'posts.cover → directus_files (-, -)',
      'posts.reviewer → authors (drafts, -)',
      'posts.user_created → directus_users (-, -)',
      'posts.user_updated → directus_users (-, -)',
      'posts_tags.posts_id → posts (tags, tags_id)',
      'posts_tags.tags_id → tags (-, posts_id)',
    ]);
    const { data: collection } = await ok(await api('GET', '/collections/posts'));
    expect(collection.meta).toMatchObject({ sort_field: 'sort', archive_field: 'status', archive_value: 'archived', unarchive_value: 'draft' });
    const { data: junction } = await ok(await api('GET', '/collections/posts_tags'));
    expect(junction.meta).toMatchObject({ hidden: true });
  });

  it('give fields that work for items, nested relations included', async () => {
    const upload = new FormData();
    upload.append('file', new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b])], 'pixel.gif', { type: 'image/gif' }));
    const file = await ok<{ id: string }>(await call('/files', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: upload }));

    const author = await ok<{ id: string }>(await api('POST', '/items/authors', { name: 'Ada' }, token));
    const created = await ok(
      await api(
        'POST',
        '/items/posts?fields=*,tags.tags_id.label,author.name',
        {
          title: 'Hello',
          body: '# Hi',
          cover: file.data.id,
          author: author.data.id,
          tags: [{ tags_id: { label: 'news' } }, { tags_id: { label: 'cloud' } }],
          rating: 4.5,
          featured: true,
          published_on: '2026-10-29T09:30:00.000Z',
          day: '2026-10-29',
          kind: 'news',
          keywords: ['a', 'b'],
          extra: { nested: [1] },
        },
        token,
      ),
    );
    const post = created.data;
    expect(post).toMatchObject({
      status: 'draft',
      views: 0,
      title: 'Hello',
      cover: file.data.id,
      author: { name: 'Ada' },
      featured: true,
      keywords: ['a', 'b'],
      extra: { nested: [1] },
      reviewer: null,
    });
    expect(post.tags.map((t: { tags_id: { label: string } }) => t.tags_id.label).sort()).toEqual(['cloud', 'news']);
    // The server fills in who created the item and when.
    const me = await ok<{ id: string }>(await api('GET', '/users/me', undefined, token));
    expect(post.user_created).toBe(me.data.id);
    expect(post.date_created).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(post).not.toHaveProperty('seo');

    // The reverse O2M lists the author's posts; the second O2M its own.
    const { data: ada } = await ok(await api('GET', `/items/authors/${author.data.id}?fields=posts.title,drafts`, undefined, token));
    expect(ada).toEqual({ posts: [{ title: 'Hello' }], drafts: [] });
    await ok(await api('PATCH', `/items/authors/${author.data.id}`, { drafts: [post.id] }, token));
    const { data: reviewed } = await ok(await api('GET', `/items/posts/${post.id}?fields=reviewer`, undefined, token));
    expect(reviewed.reviewer).toBe(author.data.id);

    // Unlinking a tag deletes its junction row (one_deselect_action: delete), not the tag.
    const { data: before } = await ok(await api('GET', `/items/posts/${post.id}?fields=tags.id,tags.tags_id.label`, undefined, token));
    const keep = before.tags.find((t: { tags_id: { label: string } }) => t.tags_id.label === 'news');
    await ok(await api('PATCH', `/items/posts/${post.id}`, { tags: [keep.id] }, token));
    const { data: junction } = await ok<unknown[]>(await api('GET', '/items/posts_tags', undefined, token));
    expect(junction).toHaveLength(1);
    const { data: tags } = await ok<unknown[]>(await api('GET', '/items/tags', undefined, token));
    expect(tags).toHaveLength(2);

    // Deleting the post deletes its junction rows (on_delete: CASCADE); deleting the file clears the cover.
    await api('DELETE', `/files/${file.data.id}`, undefined, token);
    const { data: afterFile } = await ok(await api('GET', `/items/posts/${post.id}?fields=cover`, undefined, token));
    expect(afterFile.cover).toBeNull();
    expect((await api('DELETE', `/items/posts/${post.id}`, undefined, token)).status).toBe(204);
    expect((await ok<unknown[]>(await api('GET', '/items/posts_tags', undefined, token))).data).toEqual([]);
  });

  it('give a unique field that refuses duplicates', async () => {
    await ok(await api('POST', '/items/tags', { label: 'unique-one' }));
    const res = await api('POST', '/items/tags', { label: 'unique-one' });
    expect(res.status).toBe(400);
    expect((await res.json<{ errors: Array<{ extensions: { code: string } }> }>()).errors[0]!.extensions.code).toBe('RECORD_NOT_UNIQUE');
  });

  it('give a singleton with a manual key', async () => {
    await run(collectionPlan({ name: 'pages', primaryKey: { field: 'slug', kind: 'string' }, singleton: false }));
    await run(fieldPlan({ collection: 'pages', field: 'heading', kind: 'string' }, keyType));
    await ok(await api('POST', '/items/pages', { slug: 'home', heading: 'Welcome' }));
    expect((await ok(await api('GET', '/items/pages/home'))).data).toEqual({ slug: 'home', heading: 'Welcome' });

    await run(collectionPlan({ name: 'site', primaryKey: { field: 'id', kind: 'integer' }, singleton: true }));
    await run(fieldPlan({ collection: 'site', field: 'name', kind: 'string', defaultValue: 'Cirrus' }, keyType));
    expect((await ok(await api('GET', '/items/site'))).data).toMatchObject({ name: 'Cirrus' });
    await ok(await api('PATCH', '/items/site', { name: 'My site' }));
    expect((await ok(await api('GET', '/items/site'))).data).toMatchObject({ id: 1, name: 'My site' });
  });
});
