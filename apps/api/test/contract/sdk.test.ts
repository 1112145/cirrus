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
} from '@directus/sdk';
import { describe, expect, it } from 'vitest';
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
