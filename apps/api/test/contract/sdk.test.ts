/**
 * Contract tests: @directus/sdk 21.3.0 (ships with Directus 11.17.4) calling the Worker directly.
 * Each milestone adds its new commands here (spec §17.3).
 */
import {
  authentication,
  createCollection,
  createDirectus,
  createPermission,
  createPermissions,
  createPolicy,
  createRole,
  createUser,
  createUsers,
  deletePermission,
  deletePolicy,
  deleteRole,
  deleteUser,
  login,
  logout,
  readItemPermissions,
  readMe,
  readPermission,
  readPermissions,
  readPolicies,
  readPolicy,
  readPolicyGlobals,
  readProviders,
  readRole,
  readRoles,
  readRolesMe,
  readUser,
  readUserPermissions,
  readUsers,
  refresh,
  updateMe,
  updatePermission,
  updatePolicy,
  updateRole,
  updateUser,
  createField,
  createItem,
  createRelation,
  deleteRelation,
  readRelation,
  readRelationByCollection,
  readRelations,
  updateRelation,
  createItems,
  deleteCollection,
  deleteField,
  deleteItem,
  deleteItems,
  isDirectusError,
  readCollection,
  readCollections,
  readField,
  readFields,
  readFieldsByCollection,
  readItem,
  readItems,
  readSingleton,
  rest,
  serverHealth,
  serverInfo,
  serverPing,
  staticToken,
  updateCollection,
  updateCollectionsBatch,
  updateField,
  updateFields,
  updateItem,
  updateItems,
  updateItemsBatch,
  updateSingleton,
  withSearch,
  createFolder,
  createFolders,
  deleteFile,
  deleteFiles,
  deleteFolder,
  deleteFolders,
  importFile,
  readAssetArrayBuffer,
  readAssetBlob,
  readAssetRaw,
  readFile,
  readFiles,
  readFolder,
  readFolders,
  updateFile,
  updateFiles,
  updateFilesBatch,
  updateFolder,
  updateFolders,
  updateFoldersBatch,
  uploadFiles,
} from '@directus/sdk';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JPEG, PNG } from '../fixtures.ts';
import { ADMIN_TOKEN, ADMIN_ROLE, BASE, tableSql, workerFetch } from '../helpers.ts';

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

describe('@directus/sdk contract — M2', () => {
  // Done when: CRUD on `posts` with nested _and/_or filters.
  type Post = { id: string; title: string; status: string; views: number; featured: boolean; tags: string[] | null };
  const ids: Record<string, string> = {};

  it('createItem() / createItems()', async () => {
    await admin.request(
      createCollection({
        collection: 'posts',
        schema: {},
        fields: [
          { field: 'title', type: 'string', schema: { is_nullable: false } },
          { field: 'status', type: 'string', schema: { default_value: 'draft' } },
          { field: 'views', type: 'integer', schema: { default_value: 0 } },
          { field: 'featured', type: 'boolean', schema: { default_value: false } },
          { field: 'tags', type: 'csv', meta: { special: ['cast-csv'] } },
        ],
      }),
    );

    const first = (await admin.request(createItem('posts', { title: 'Hello', status: 'published', views: 10, tags: ['intro'] }))) as Post;
    expect(first).toMatchObject({ title: 'Hello', status: 'published', views: 10, featured: false, tags: ['intro'] });
    ids.hello = first.id;

    const more = (await admin.request(
      createItems(
        'posts',
        [
          { title: 'Popular', status: 'published', views: 500, featured: true },
          { title: 'Draft', views: 3 },
          { title: 'Old news', status: 'archived', views: 900 },
        ],
        { fields: ['id', 'title'] },
      ),
    )) as Array<Pick<Post, 'id' | 'title'>>;
    expect(more.map((p) => p.title)).toEqual(['Popular', 'Draft', 'Old news']);
    for (const p of more) ids[p.title] = p.id;
  });

  it('readItems() with nested _and / _or filters, fields, sort and paging', async () => {
    const posts = (await admin.request(
      readItems('posts', {
        fields: ['title', 'views'],
        filter: {
          _and: [
            { _or: [{ status: { _eq: 'published' } }, { views: { _gte: 800 } }] },
            { _or: [{ featured: { _eq: true } }, { title: { _icontains: 'NEWS' } }, { tags: { _null: true } }] },
          ],
        },
        sort: ['-views'],
      }),
    )) as Array<Pick<Post, 'title' | 'views'>>;
    expect(posts).toEqual([
      { title: 'Old news', views: 900 },
      { title: 'Popular', views: 500 },
    ]);

    const page = await admin.request(readItems('posts', { fields: ['title'], sort: ['views'], limit: 2, page: 2 }));
    expect(page).toEqual([{ title: 'Popular' }, { title: 'Old news' }]);
    expect(await admin.request(readItems('posts', { fields: ['title'], search: 'draft' }))).toEqual([{ title: 'Draft' }]);
  });

  it('readItem()', async () => {
    expect(await admin.request(readItem('posts', ids.hello!, { fields: ['title', 'tags'] }))).toEqual({ title: 'Hello', tags: ['intro'] });
  });

  it('withSearch(readItems())', async () => {
    const posts = await admin.request(withSearch(readItems('posts', { fields: ['title'], filter: { views: { _between: [5, 600] } } })));
    expect(posts).toEqual([{ title: 'Hello' }, { title: 'Popular' }]);
  });

  it('updateItem() / updateItems() / updateItemsBatch()', async () => {
    expect(await admin.request(updateItem('posts', ids.Draft!, { status: 'published' }, { fields: ['status'] }))).toEqual({ status: 'published' });

    const byKeys = await admin.request(updateItems('posts', [ids.hello!, ids.Popular!], { featured: true }, { fields: ['title', 'featured'] }));
    expect(byKeys).toEqual([
      { title: 'Hello', featured: true },
      { title: 'Popular', featured: true },
    ]);

    const byQuery = await admin.request(updateItems('posts', { filter: { status: { _eq: 'archived' } } }, { views: 0 }, { fields: ['title', 'views'] }));
    expect(byQuery).toEqual([{ title: 'Old news', views: 0 }]);

    const batch = await admin.request(
      updateItemsBatch('posts', [
        { id: ids.hello, views: 11 },
        { id: ids.Draft, views: 4 },
      ], { fields: ['title', 'views'] }),
    );
    expect(batch).toEqual([
      { title: 'Hello', views: 11 },
      { title: 'Draft', views: 4 },
    ]);
  });

  it('deleteItem() / deleteItems()', async () => {
    await admin.request(deleteItem('posts', ids['Old news']!));
    expect(await errorCode(admin.request(readItem('posts', ids['Old news']!)))).toBe('FORBIDDEN');

    await admin.request(deleteItems('posts', [ids.Draft!]));
    await admin.request(deleteItems('posts', { filter: { _or: [{ title: { _eq: 'Popular' } }, { views: { _gt: 1000 } }] } }));
    expect(await admin.request(readItems('posts', { fields: ['title'] }))).toEqual([{ title: 'Hello' }]);
  });

  it('readSingleton() / updateSingleton()', async () => {
    await admin.request(
      createCollection({
        collection: 'settings_page',
        meta: { singleton: true },
        schema: {},
        fields: [{ field: 'headline', type: 'string', schema: { default_value: 'Welcome' } }],
      }),
    );
    expect(await admin.request(readSingleton('settings_page', { fields: ['headline'] }))).toEqual({ headline: 'Welcome' });
    expect(await admin.request(updateSingleton('settings_page', { headline: 'Hi' }, { fields: ['headline'] }))).toEqual({ headline: 'Hi' });
    expect(await admin.request(readSingleton('settings_page', { fields: ['headline'] }))).toEqual({ headline: 'Hi' });
  });

  it('errors use Directus codes', async () => {
    expect(await errorCode(client.request(readItems('posts')))).toBe('FORBIDDEN');
    expect(await errorCode(admin.request(readItems('nope')))).toBe('FORBIDDEN');
    expect(await errorCode(admin.request(readItems('posts', { fields: ['nope'] })))).toBe('FORBIDDEN');
    expect(await errorCode(admin.request(readItems('posts', { filter: { views: { _gt: 'many' } } })))).toBe('INVALID_QUERY');
    expect(await errorCode(admin.request(createItem('posts', { status: 'x' })))).toBe('NOT_NULL_VIOLATION');
  });
});

describe('@directus/sdk contract — M3', () => {
  // Done when: an "editor" role only sees its own posts.
  const PASSWORD = 'sdk editor password';
  const ids: Record<string, string> = {};
  let updateId = 0;
  const userClient = () => createDirectus(BASE, { globals: { fetch: workerFetch } }).with(authentication('json', { autoRefresh: false })).with(rest());

  it('createPolicy() / createPermissions() / createRole() / createUser()', async () => {
    await admin.request(
      createCollection({ collection: 'notes', schema: {}, fields: [{ field: 'text', type: 'string' }, { field: 'owner', type: 'uuid', meta: { special: ['user-created'] } }] }),
    );
    const policy = await admin.request(createPolicy({ name: 'Note taker', app_access: true }));
    expect(policy).toMatchObject({ name: 'Note taker', icon: 'badge', app_access: true, admin_access: false, enforce_tfa: false, ip_access: null });
    ids.policy = policy.id;

    const own = { owner: { _eq: '$CURRENT_USER' } };
    const permissions = await admin.request(
      createPermissions([
        { policy: policy.id, collection: 'notes', action: 'read', permissions: own, fields: ['*'] },
        { policy: policy.id, collection: 'notes', action: 'create', fields: ['text'] },
      ]),
    );
    expect(permissions.map((p) => p.action)).toEqual(['read', 'create']);
    const update = await admin.request(createPermission({ policy: policy.id, collection: 'notes', action: 'update', permissions: own, fields: ['text'] }));
    expect(update).toMatchObject({ collection: 'notes', action: 'update', permissions: own, fields: ['text'], validation: null, presets: null });
    updateId = update.id;

    const role = await admin.request(createRole({ name: 'Note takers', policies: [{ policy: policy.id }] } as never));
    expect(role).toMatchObject({ name: 'Note takers', icon: 'supervised_user_circle', parent: null });
    ids.role = role.id;

    const user = await admin.request(createUser({ email: 'sdk-ann@example.com', password: PASSWORD, role: role.id, first_name: 'Ann' }));
    expect(user).toMatchObject({ email: 'sdk-ann@example.com', first_name: 'Ann', role: role.id, status: 'active', password: '**********' });
    ids.ann = user.id;
    const [ben] = await admin.request(createUsers([{ email: 'sdk-ben@example.com', password: PASSWORD, role: role.id }]));
    ids.ben = ben!.id;
  });

  it('login() / readMe() / refresh() / logout() with authentication()', async () => {
    const ann = userClient();
    const auth = await ann.login({ email: 'sdk-ann@example.com', password: PASSWORD });
    expect(auth).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), expires: 900_000 });
    expect(await ann.request(readMe({ fields: ['id', 'email', 'role'] }))).toEqual({ id: ids.ann, email: 'sdk-ann@example.com', role: ids.role });

    const refreshed = await ann.refresh();
    expect(refreshed.refresh_token).not.toBe(auth.refresh_token);
    expect((await ann.request(readMe())).id).toBe(ids.ann);

    await ann.logout();
    expect(await ann.getToken()).toBeNull();
    expect(await errorCode(client.request(refresh({ mode: 'json', refresh_token: refreshed.refresh_token! })))).toBe('INVALID_CREDENTIALS');
  });

  it('login() / refresh() / logout() commands', async () => {
    const tokens = await client.request(login({ email: 'sdk-ben@example.com', password: PASSWORD }, { mode: 'json' }));
    expect(tokens).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), expires: 900_000 });
    const next = await client.request(refresh({ mode: 'json', refresh_token: tokens.refresh_token! }));
    expect(next.access_token).toBeTruthy();
    await client.request(logout({ mode: 'json', refresh_token: next.refresh_token! }));
    expect(await errorCode(client.request(login({ email: 'sdk-ben@example.com', password: 'wrong' }, { mode: 'json' })))).toBe('INVALID_CREDENTIALS');
  });

  it('an editor only sees their own items', async () => {
    const [ann, ben] = [userClient(), userClient()];
    await ann.login({ email: 'sdk-ann@example.com', password: PASSWORD });
    await ben.login({ email: 'sdk-ben@example.com', password: PASSWORD });

    const note = (await ann.request(createItem('notes', { text: 'Ann 1' }))) as { id: string; owner: string };
    expect(note.owner).toBe(ids.ann);
    await ben.request(createItem('notes', { text: 'Ben 1' }));

    expect(await ann.request(readItems('notes', { fields: ['text'] }))).toEqual([{ text: 'Ann 1' }]);
    expect(await ben.request(readItems('notes', { fields: ['text'] }))).toEqual([{ text: 'Ben 1' }]);
    expect(await errorCode(ben.request(readItem('notes', note.id)))).toBe('FORBIDDEN');
    expect(await errorCode(ben.request(updateItem('notes', note.id, { text: 'Ben was here' })))).toBe('FORBIDDEN');
    expect(await errorCode(ben.request(createItem('notes', { text: 'x', owner: ids.ann })))).toBe('FORBIDDEN');
    expect(await ann.request(updateItem('notes', note.id, { text: 'Ann 1b' }, { fields: ['text'] }))).toEqual({ text: 'Ann 1b' });

    expect(await ann.request(readItemPermissions('notes', note.id))).toEqual({ update: { access: true }, delete: { access: false }, share: { access: false } });
    const mine = await ann.request(readUserPermissions());
    expect((mine as Record<string, Record<string, { access: string }>>).notes!.read!.access).toBe('partial');
    expect(await ann.request(readPolicyGlobals())).toEqual({ app_access: true, admin_access: false, enforce_tfa: false });
    expect(await ann.request(readRolesMe({ fields: ['id', 'name'] }))).toEqual([{ id: ids.role, name: 'Note takers' }]);
    expect(await errorCode(ann.request(updateMe({ first_name: 'Annie' })))).toBe('FORBIDDEN');
  });

  it('readUsers() / readUser() / updateUser() / updateMe()', async () => {
    const users = await admin.request(readUsers({ fields: ['email'], filter: { email: { _starts_with: 'sdk-' } }, sort: ['email'] }));
    expect(users).toEqual([{ email: 'sdk-ann@example.com' }, { email: 'sdk-ben@example.com' }]);
    expect(await admin.request(readUser(ids.ann!, { fields: ['first_name'] }))).toEqual({ first_name: 'Ann' });
    expect(await admin.request(updateUser(ids.ann!, { title: 'Writer' }, { fields: ['title'] }))).toEqual({ title: 'Writer' });

    const ann = createDirectus(BASE, { globals: { fetch: workerFetch } }).with(staticToken('sdk-ann-static-token-0123456789')).with(rest());
    await admin.request(updateUser(ids.ann!, { token: 'sdk-ann-static-token-0123456789' }));
    expect((await ann.request(readMe({ fields: ['id'] }))).id).toBe(ids.ann);
    await admin.request(createPermission({ policy: ids.policy!, collection: 'directus_users', action: 'update', permissions: { id: { _eq: '$CURRENT_USER' } }, fields: ['first_name'] }));
    expect(await ann.request(updateMe({ first_name: 'Annie' }, { fields: ['first_name'] }))).toEqual({ first_name: 'Annie' });
  });

  it('readRoles() / readRole() / updateRole() / readPolicies() / readPolicy() / updatePolicy()', async () => {
    const roles = await admin.request(readRoles({ fields: ['name'], sort: ['name'] }));
    expect(roles).toEqual([{ name: 'Administrator' }, { name: 'Note takers' }]);
    expect(await admin.request(readRole(ADMIN_ROLE, { fields: ['name', 'icon'] }))).toEqual({ name: 'Administrator', icon: 'verified' });
    expect(await admin.request(updateRole(ids.role!, { description: 'Takes notes' }, { fields: ['description'] }))).toEqual({ description: 'Takes notes' });

    const policies = await admin.request(readPolicies({ fields: ['name'], filter: { admin_access: { _eq: true } } }));
    expect(policies).toEqual([{ name: 'Administrator' }]);
    expect(await admin.request(readPolicy(ids.policy!, { fields: ['name'] }))).toEqual({ name: 'Note taker' });
    expect(await admin.request(updatePolicy(ids.policy!, { enforce_tfa: false, icon: 'edit' }, { fields: ['icon'] }))).toEqual({ icon: 'edit' });
  });

  it('readPermissions() / readPermission() / updatePermission() / deletePermission()', async () => {
    const permissions = await admin.request(readPermissions({ fields: ['action'], filter: { collection: { _eq: 'notes' } }, sort: ['id'] }));
    expect(permissions).toEqual([{ action: 'read' }, { action: 'create' }, { action: 'update' }]);
    expect(await admin.request(readPermission(updateId, { fields: ['action'] }))).toEqual({ action: 'update' });
    expect(await admin.request(updatePermission(updateId, { fields: ['*'] }, { fields: ['fields'] }))).toEqual({ fields: ['*'] });
    await admin.request(deletePermission(updateId));
    expect(await errorCode(admin.request(readPermission(updateId)))).toBe('FORBIDDEN');
  });

  it('deleteUser() / deleteRole() / deletePolicy()', async () => {
    await admin.request(deleteUser(ids.ben!));
    expect(await errorCode(admin.request(readUser(ids.ben!)))).toBe('FORBIDDEN');
    await admin.request(deleteRole(ids.role!));
    expect(await admin.request(readUser(ids.ann!, { fields: ['role'] }))).toEqual({ role: null });
    await admin.request(deletePolicy(ids.policy!));
    expect(await admin.request(readPermissions({ filter: { policy: { _eq: ids.policy! } } }))).toEqual([]);
  });

  it('readProviders()', async () => {
    expect(await client.request(readProviders())).toEqual([]);
  });

  it('auth errors use Directus codes', async () => {
    const bad = createDirectus(BASE, { globals: { fetch: workerFetch } }).with(staticToken('not-a-token')).with(rest());
    expect(await errorCode(bad.request(readMe()))).toBe('INVALID_CREDENTIALS');
    expect(await errorCode(client.request(readMe()))).toBe('INVALID_CREDENTIALS');
  });
});

describe('@directus/sdk contract — M4', () => {
  // Done when: `posts.author.name`, `posts.tags.*`.
  const ids: Record<string, string> = {};

  it('createRelation(): M2O + O2M, and M2M through a junction', async () => {
    await admin.request(deleteCollection('posts')); // M2's
    const alias = (field: string, special: string) => ({ field, type: 'alias', meta: { special: [special] } });
    await admin.request(createCollection({ collection: 'authors', schema: {}, fields: [{ field: 'name', type: 'string' }, alias('posts', 'o2m')] }));
    await admin.request(createCollection({ collection: 'tags', schema: {}, fields: [{ field: 'name', type: 'string' }] }));
    await admin.request(
      createCollection({
        collection: 'posts',
        schema: {},
        fields: [{ field: 'title', type: 'string' }, { field: 'author', type: 'uuid', meta: { special: ['m2o'] } }, alias('tags', 'm2m')],
      }),
    );
    await admin.request(
      createCollection({
        collection: 'posts_tags',
        schema: {},
        meta: { hidden: true },
        fields: [
          { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } },
          { field: 'posts_id', type: 'uuid' },
          { field: 'tags_id', type: 'uuid' },
        ],
      }),
    );

    const m2o = await admin.request(
      createRelation({ collection: 'posts', field: 'author', related_collection: 'authors', meta: { one_field: 'posts' }, schema: { on_delete: 'SET NULL' } }),
    );
    expect(m2o).toMatchObject({
      collection: 'posts',
      field: 'author',
      related_collection: 'authors',
      meta: { many_collection: 'posts', many_field: 'author', one_collection: 'authors', one_field: 'posts', one_deselect_action: 'nullify' },
      schema: { table: 'posts', column: 'author', foreign_key_table: 'authors', foreign_key_column: 'id', on_delete: 'SET NULL' },
    });
    await admin.request(
      createRelation({
        collection: 'posts_tags',
        field: 'posts_id',
        related_collection: 'posts',
        meta: { one_field: 'tags', junction_field: 'tags_id', one_deselect_action: 'delete' },
        schema: { on_delete: 'CASCADE' },
      }),
    );
    await admin.request(
      createRelation({ collection: 'posts_tags', field: 'tags_id', related_collection: 'tags', meta: { junction_field: 'posts_id' }, schema: { on_delete: 'CASCADE' } }),
    );
    expect(await errorCode(admin.request(createRelation({ collection: 'posts', field: 'author', related_collection: 'authors' })))).toBe('INVALID_PAYLOAD');
    expect(await errorCode(client.request(createRelation({ collection: 'posts', field: 'title', related_collection: 'authors' })))).toBe('FORBIDDEN');
  });

  it('readRelations() / readRelationByCollection() / readRelation()', async () => {
    const all = await admin.request(readRelations());
    expect(all.map((r) => `${r.collection}.${r.field} → ${r.related_collection}`)).toEqual([
      'posts.author → authors',
      'posts_tags.posts_id → posts',
      'posts_tags.tags_id → tags',
    ]);
    expect((await admin.request(readRelationByCollection('posts_tags'))).map((r) => r.field)).toEqual(['posts_id', 'tags_id']);
    expect(await admin.request(readRelation('posts_tags', 'posts_id'))).toMatchObject({ meta: { one_field: 'tags', junction_field: 'tags_id' } });
    expect(await errorCode(admin.request(readRelation('posts', 'title')))).toBe('FORBIDDEN');
  });

  it('updateRelation()', async () => {
    const updated = await admin.request(updateRelation('posts_tags', 'tags_id', { schema: { on_delete: 'RESTRICT' } }));
    expect(updated.schema).toMatchObject({ on_delete: 'RESTRICT' });
  });

  it('createItem() with nested M2O and M2M items', async () => {
    const author = (await admin.request(createItem('authors', { name: 'Ada' }))) as { id: string };
    ids.ada = author.id;
    const post = (await admin.request(
      createItem(
        'posts',
        { title: 'Relations', author: author.id, tags: [{ tags_id: { name: 'cms' } }, { tags_id: { name: 'edge' } }] },
        { fields: ['id', 'title', { author: ['name'] }, { tags: [{ tags_id: ['name'] }] }] },
      ),
    )) as { id: string };
    expect(post).toEqual({ id: post.id, title: 'Relations', author: { name: 'Ada' }, tags: [{ tags_id: { name: 'cms' } }, { tags_id: { name: 'edge' } }] });
    ids.post = post.id;
    await admin.request(createItem('posts', { title: 'Second', author: { name: 'Grace' } }));
  });

  it('readItems() with relational fields: posts.author.name, posts.tags.*', async () => {
    const posts = await admin.request(readItems('posts', { fields: ['title', { author: ['name'] }, { tags: ['*'] }], sort: ['title'] }));
    expect(posts).toEqual([
      {
        title: 'Relations',
        author: { name: 'Ada' },
        tags: [
          { id: expect.any(Number), posts_id: ids.post, tags_id: expect.any(String) },
          { id: expect.any(Number), posts_id: ids.post, tags_id: expect.any(String) },
        ],
      },
      { title: 'Second', author: { name: 'Grace' }, tags: [] },
    ]);
    // O2M, from the other side
    expect(await admin.request(readItem('authors', ids.ada!, { fields: ['name', { posts: ['title'] }] }))).toEqual({ name: 'Ada', posts: [{ title: 'Relations' }] });
  });

  it('readItems() with relational filters, sorts and deep', async () => {
    const byAuthor = await admin.request(readItems('posts', { fields: ['title'], filter: { author: { name: { _eq: 'Grace' } } } }));
    expect(byAuthor).toEqual([{ title: 'Second' }]);
    const byTag = await admin.request(readItems('posts', { fields: ['title'], filter: { tags: { _some: { tags_id: { name: { _eq: 'edge' } } } } } }));
    expect(byTag).toEqual([{ title: 'Relations' }]);
    const sorted = await admin.request(readItems('posts', { fields: ['title'], sort: ['-author.name'] }));
    expect(sorted).toEqual([{ title: 'Second' }, { title: 'Relations' }]);
    const deep = await admin.request(
      readItem('posts', ids.post!, { fields: [{ tags: [{ tags_id: ['name'] }] }], deep: { tags: { _limit: 1, _sort: ['-id'] } } }),
    );
    expect(deep).toEqual({ tags: [{ tags_id: { name: 'edge' } }] });
  });

  it('updateItem() with nested O2M changes', async () => {
    const tag = (await admin.request(createItem('tags', { name: 'serverless' }))) as { id: string };
    const { tags } = (await admin.request(readItem('posts', ids.post!, { fields: ['tags'] }))) as { tags: number[] };
    const updated = await admin.request(
      updateItem('posts', ids.post!, { tags: { create: [{ tags_id: tag.id }], delete: [tags[0]!] } }, { fields: [{ tags: [{ tags_id: ['name'] }] }] }),
    );
    expect(updated).toEqual({ tags: [{ tags_id: { name: 'edge' } }, { tags_id: { name: 'serverless' } }] });
    // tags_id is RESTRICT now: a tag still linked can't be deleted
    expect(await errorCode(admin.request(deleteItem('tags', tag.id)))).toBe('INVALID_FOREIGN_KEY');
  });

  it('deleteRelation()', async () => {
    await admin.request(deleteRelation('posts', 'author'));
    expect(await errorCode(admin.request(readRelation('posts', 'author')))).toBe('FORBIDDEN');
    // The field stays, now without a relation.
    expect(await admin.request(readItem('posts', ids.post!, { fields: ['author'] }))).toEqual({ author: ids.ada });
  });
});

describe('@directus/sdk contract — M5', () => {
  const ids: Record<string, string> = {};
  const jpeg = (name: string) => new File([JPEG], name, { type: 'image/jpeg' });
  type File = { id: string; title: string; filename_disk: string; type: string; width: number | null; folder: string | null };

  it('createFolder(), createFolders(), readFolders(), readFolder(), updateFolder(), updateFolders(), updateFoldersBatch()', async () => {
    const media = await admin.request(createFolder({ name: 'Media' }));
    ids.media = media.id;
    const [photos, docs] = await admin.request(createFolders([{ name: 'Photos', parent: media.id }, { name: 'Docs', parent: media.id }]));
    ids.photos = photos!.id;
    ids.docs = docs!.id;
    expect(await admin.request(readFolders({ filter: { parent: { _eq: media.id } }, sort: ['name'], fields: ['name'] }))).toEqual([{ name: 'Docs' }, { name: 'Photos' }]);
    expect(await admin.request(readFolder(photos!.id, { fields: ['name', { parent: ['name'] }] }))).toEqual({ name: 'Photos', parent: { name: 'Media' } });
    expect(await admin.request(updateFolder(docs!.id, { name: 'Documents' }, { fields: ['name'] }))).toEqual({ name: 'Documents' });
    await admin.request(updateFolders([photos!.id, docs!.id], { parent: null }));
    await admin.request(updateFoldersBatch([{ id: photos!.id, name: 'Pictures' }]));
    expect(await admin.request(readFolder(photos!.id, { fields: ['name', 'parent'] }))).toEqual({ name: 'Pictures', parent: null });
  });

  it('uploadFiles()', async () => {
    const one = new FormData();
    one.append('folder', ids.photos!);
    one.append('file', jpeg('sdk-photo.jpg'));
    const file = (await admin.request(uploadFiles(one))) as File;
    expect(file).toMatchObject({ title: 'SDK Photo', type: 'image/jpeg', width: 40, folder: ids.photos, filename_disk: `${file.id}.jpg` });
    ids.photo = file.id;

    const two = new FormData();
    two.append('title', 'Pixel');
    two.append('file', new File([PNG], 'pixel.png', { type: 'image/png' }));
    two.append('file', new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' }));
    const files = (await admin.request(uploadFiles(two, { fields: ['id', 'title', 'type'] }))) as File[];
    expect(files.map((f) => [f.title, f.type])).toEqual([
      ['Pixel', 'image/png'],
      ['Doc', 'application/pdf'],
    ]);
    ids.pixel = files[0]!.id;
    ids.doc = files[1]!.id;
  });

  it('readFiles(), readFile()', async () => {
    expect(await admin.request(readFiles({ filter: { folder: { _eq: ids.photos } }, fields: ['title', { folder: ['name'] }] }))).toEqual([
      { title: 'SDK Photo', folder: { name: 'Pictures' } },
    ]);
    expect(await admin.request(readFile(ids.pixel!, { fields: ['filename_download', 'width', 'height'] }))).toEqual({ filename_download: 'pixel.png', width: 2, height: 1 });
  });

  it('updateFile() with JSON, and with FormData to replace the contents', async () => {
    expect(await admin.request(updateFile(ids.doc!, { title: 'Spec', folder: ids.docs }, { fields: ['title', 'folder'] }))).toEqual({ title: 'Spec', folder: ids.docs });
    const replacement = new FormData();
    replacement.append('file', new File([PNG], 'spec.png', { type: 'image/png' }));
    const replaced = (await admin.request(updateFile(ids.doc!, replacement))) as File;
    expect(replaced).toMatchObject({ id: ids.doc, title: 'Spec', type: 'image/png', width: 2 });
  });

  it('updateFiles(), updateFilesBatch()', async () => {
    const updated = await admin.request(updateFiles([ids.pixel!, ids.doc!], { description: 'tiny' }, { fields: ['description'] }));
    expect(updated).toEqual([{ description: 'tiny' }, { description: 'tiny' }]);
    await admin.request(updateFilesBatch([{ id: ids.pixel!, tags: ['dot'] }]));
    expect(await admin.request(readFile(ids.pixel!, { fields: ['tags'] }))).toEqual({ tags: ['dot'] });
  });

  it('importFile()', async () => {
    const file = (await admin.request(importFile('https://files.test/images/sunset-photo.png', { folder: ids.photos }))) as File;
    expect(file).toMatchObject({ title: 'Sunset Photo.png', type: 'image/png', folder: ids.photos, width: 2 });
    ids.imported = file.id;
  });

  it('readAssetRaw(), readAssetBlob(), readAssetArrayBuffer()', async () => {
    const raw = await admin.request(readAssetRaw(ids.photo!));
    expect(new Uint8Array(await new Response(raw).arrayBuffer())).toEqual(JPEG);
    const blob = await admin.request(readAssetBlob(ids.photo!));
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(JPEG.length);
    const webp = await admin.request(readAssetArrayBuffer(ids.photo!, { width: 16, height: 16, fit: 'cover', format: 'webp' }));
    expect(new TextDecoder().decode(new Uint8Array(webp).subarray(8, 12))).toBe('WEBP');
    // Presets negotiate the format with Accept; the SDK sends none, so the file's own is kept.
    const preset = await admin.request(readAssetBlob(ids.photo!, { key: 'system-small-contain' }));
    expect(preset.type).toBe('image/jpeg');
  });

  // Done when (spec §14): a post can have a cover image.
  it('a post with a cover image: createField(), createRelation() to directus_files, readItem() through it', async () => {
    await admin.request(createCollection({ collection: 'stories', schema: {}, fields: [{ field: 'title', type: 'string' }] }));
    await admin.request(createField('stories', { field: 'cover', type: 'uuid', meta: { interface: 'file-image', special: ['file'] }, schema: {} }));
    await admin.request(createRelation({ collection: 'stories', field: 'cover', related_collection: 'directus_files', schema: { on_delete: 'SET NULL' } }));
    const story = (await admin.request(createItem('stories', { title: 'Sunset', cover: ids.imported }))) as { id: string };
    expect(await admin.request(readItem('stories', story.id, { fields: ['title', { cover: ['title', 'type', 'width'] }] }))).toEqual({
      title: 'Sunset',
      cover: { title: 'Sunset Photo.png', type: 'image/png', width: 2 },
    });
  });

  it('deleteFile(), deleteFiles(), deleteFolder(), deleteFolders()', async () => {
    const { filename_disk } = (await admin.request(readFile(ids.photo!, { fields: ['filename_disk'] }))) as File;
    await admin.request(deleteFile(ids.photo!));
    expect(await env.STORAGE!.head(filename_disk)).toBeNull();
    expect(await errorCode(admin.request(readFile(ids.photo!)))).toBe('FORBIDDEN');
    await admin.request(deleteFiles([ids.pixel!, ids.doc!, ids.imported!]));
    expect(await admin.request(readFiles({ fields: ['id'] }))).toEqual([]);
    await admin.request(deleteFolder(ids.photos!));
    await admin.request(deleteFolders([ids.docs!, ids.media!]));
    expect(await admin.request(readFolders())).toEqual([]);
  });
});

describe('@directus/sdk contract — M6', () => {
  /** fetch with a cookie jar, as the browser running the admin app keeps one. */
  function browserFetch() {
    const jar = new Map<string, string>();
    const fetchWithCookies: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (jar.size) req.headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await workerFetch(req);
      for (const header of res.headers.getSetCookie()) {
        const [pair, ...attrs] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    };
    return { jar, fetch: fetchWithCookies };
  }

  it("authentication('session'): login(), readMe(), refresh(), logout()", async () => {
    const id = (await admin.request(createUser({ email: 'sdk-session@example.com', password: 'session password', role: ADMIN_ROLE }))).id;
    const browser = browserFetch();
    const app = createDirectus(BASE, { globals: { fetch: browser.fetch } })
      .with(authentication('session', { credentials: 'include', autoRefresh: false }))
      .with(rest({ credentials: 'include' }));

    expect(await app.login({ email: 'sdk-session@example.com', password: 'session password' })).toMatchObject({ expires: 86_400_000 });
    expect(browser.jar.has('directus_session_token')).toBe(true);
    // No token for the client to hold: the cookie authenticates.
    expect(await app.getToken()).toBeNull();
    expect(await app.request(readMe({ fields: ['id'] }))).toEqual({ id });

    expect(await app.refresh()).toMatchObject({ expires: 86_400_000 });
    expect((await app.request(readMe({ fields: ['id'] }))).id).toBe(id);

    await app.logout();
    expect(browser.jar.has('directus_session_token')).toBe(false);
    expect(await errorCode(app.request(readMe()))).toBe('INVALID_CREDENTIALS');
  });
});
