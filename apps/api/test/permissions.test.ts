import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, call, createUser, errorOf, firstError, login, ok, PUBLIC_POLICY } from './helpers.ts';

/**
 * Roles, policies and permissions (spec §10). Every test in this file shares one D1 database;
 * the setup below is the milestone's "done when": an Editor role only sees its own posts.
 */

const PASSWORD = 'editor password';

type Post = { id: string; title: string; body?: string | null; status?: string; author?: string; note?: string | null };

let editorPolicy: string;
let editorRole: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };

const as = (who: { token: string } | null) => (method: string, path: string, body?: unknown) => api(method, path, body, who?.token ?? null);
const data = async <T = any>(res: Response) => (await ok<T>(res)).data;
const titles = (items: Post[]) => items.map((p) => p.title).sort();

/** Add permissions to a policy as admin. */
const grant = async (policy: string, permissions: Array<Record<string, unknown>>) =>
  data<Array<{ id: number }>>(await api('POST', '/permissions', permissions.map((p) => ({ policy, ...p }))));

beforeAll(async () => {
  await ok(
    await api('POST', '/collections', {
      collection: 'posts',
      schema: {},
      fields: [
        { field: 'title', type: 'string' },
        { field: 'body', type: 'text' },
        { field: 'status', type: 'string', schema: { default_value: 'draft' } },
        { field: 'author', type: 'uuid', meta: { special: ['user-created'] } },
        { field: 'note', type: 'string' },
      ],
    }),
  );

  // An Editor policy (with app access) whose permissions only reach the user's own posts.
  editorPolicy = (await data(await api('POST', '/policies', { name: 'Editor', app_access: true }))).id;
  const own = { author: { _eq: '$CURRENT_USER' } };
  await grant(editorPolicy, [
    { collection: 'posts', action: 'read', permissions: own, fields: ['*'] },
    {
      collection: 'posts',
      action: 'create',
      fields: ['title', 'body', 'status'],
      presets: { status: 'draft' },
      validation: { title: { _nempty: true } },
    },
    { collection: 'posts', action: 'update', permissions: own, fields: ['title', 'body', 'status'] },
    { collection: 'posts', action: 'delete', permissions: own },
  ]);
  // The role gets the policy through a nested write, as the SDK sends it.
  editorRole = (await data(await api('POST', '/roles', { name: 'Editor', policies: [{ policy: editorPolicy }] }))).id;

  for (const name of ['alice', 'bob']) {
    const id = await createUser({ email: `${name}@example.com`, password: PASSWORD, role: editorRole });
    const who = { id, token: (await login(`${name}@example.com`, PASSWORD)).access_token };
    if (name === 'alice') alice = who;
    else bob = who;
  }
  for (const [who, title] of [
    [alice, 'Alice 1'],
    [alice, 'Alice 2'],
    [bob, 'Bob 1'],
  ] as const) {
    await ok(await as(who)('POST', '/items/posts', { title, body: `${title} body` }));
  }
});

const postOf = async (title: string): Promise<Post> =>
  (await data<Post[]>(await api('GET', `/items/posts?filter[title][_eq]=${encodeURIComponent(title)}`)))[0]!;

describe('an Editor only sees their own posts', () => {
  it('lists, counts and reads only their own posts', async () => {
    const res = await ok<Post[]>(await as(alice)('GET', '/items/posts?meta=*'));
    expect(titles(res.data)).toEqual(['Alice 1', 'Alice 2']);
    expect(res.meta).toEqual({ total_count: 2, filter_count: 2 });
    expect(titles(await data(await as(bob)('GET', '/items/posts')))).toEqual(['Bob 1']);
    expect(titles(await data(await api('GET', '/items/posts')))).toEqual(['Alice 1', 'Alice 2', 'Bob 1']);

    const bobs = await postOf('Bob 1');
    expect(await errorOf(await as(alice)('GET', `/items/posts/${bobs.id}`))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await data(await as(alice)('SEARCH', '/items/posts', { keys: [bobs.id] }))).toEqual([]);
  });

  it('sets the author and the preset on create', async () => {
    const created = await data<Post>(await as(alice)('POST', '/items/posts', { title: 'Alice 3' }));
    expect(created).toMatchObject({ title: 'Alice 3', status: 'draft', author: alice.id });
    // The preset only fills in what the payload leaves out.
    expect(await data(await as(alice)('POST', '/items/posts?fields=status', { title: 'Alice 4', status: 'review' }))).toEqual({ status: 'review' });
  });

  it('may not write fields its permission does not grant', async () => {
    const res = await as(alice)('POST', '/items/posts', { title: 'x', note: 'secret' });
    expect(await errorOf(res)).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      reason: 'You don\'t have permission to access field "note" in collection "posts" or it does not exist.',
    });
    const both = await as(alice)('POST', '/items/posts', { title: 'x', note: 'n', author: bob.id });
    expect((await firstError(both)).extensions.reason).toBe(
      'You don\'t have permission to access fields "note", "author" in collection "posts" or they do not exist.',
    );
  });

  it('validates the payload', async () => {
    const res = await as(alice)('POST', '/items/posts', { title: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      errors: [
        {
          message: 'Validation failed for field "title". Value can\'t be empty.',
          extensions: { code: 'FAILED_VALIDATION', field: 'title', type: 'nempty', path: [] },
        },
      ],
    });
  });

  it('updates only their own posts; a request touching another post writes nothing', async () => {
    const [mine, bobs] = [await postOf('Alice 1'), await postOf('Bob 1')];
    expect(await data(await as(alice)('PATCH', `/items/posts/${mine.id}?fields=title`, { title: 'Alice 1' }))).toEqual({ title: 'Alice 1' });
    expect(await errorOf(await as(alice)('PATCH', `/items/posts/${bobs.id}`, { title: 'Hacked' }))).toEqual({ status: 403, code: 'FORBIDDEN' });

    const res = await as(alice)('PATCH', '/items/posts', { keys: [mine.id, bobs.id], data: { body: 'changed' } });
    expect(await errorOf(res)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect((await postOf('Alice 1')).body).toBe('Alice 1 body');
    expect((await postOf('Bob 1')).title).toBe('Bob 1');

    const batch = await as(alice)('PATCH', '/items/posts', [{ id: mine.id, body: 'x' }, { id: bobs.id, body: 'x' }]);
    expect(await errorOf(batch)).toMatchObject({ code: 'FORBIDDEN' });
    expect((await postOf('Alice 1')).body).toBe('Alice 1 body');

    // By query, the query only selects what the permission allows.
    const updated = await data<Post[]>(await as(alice)('PATCH', '/items/posts?fields=title,body', { query: { limit: -1 }, data: { body: 'mine' } }));
    expect(updated.every((p) => p.body === 'mine' && p.title.startsWith('Alice'))).toBe(true);
    expect((await postOf('Bob 1')).body).toBe('Bob 1 body');
  });

  it('deletes only their own posts', async () => {
    const bobs = await postOf('Bob 1');
    const mine = await data<Post>(await as(alice)('POST', '/items/posts', { title: 'To delete' }));
    expect(await errorOf(await as(alice)('DELETE', `/items/posts/${bobs.id}`))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await errorOf(await as(alice)('DELETE', '/items/posts', [mine.id, bobs.id]))).toMatchObject({ code: 'FORBIDDEN' });
    expect((await postOf('To delete')).id).toBe(mine.id);

    expect((await as(alice)('DELETE', '/items/posts', { query: { filter: { title: { _eq: 'To delete' } } } })).status).toBe(204);
    expect(await postOf('To delete')).toBeUndefined();
    // A query can't reach other users' posts.
    expect((await as(alice)('DELETE', '/items/posts', { query: { filter: { title: { _eq: 'Bob 1' } } } })).status).toBe(204);
    expect(await postOf('Bob 1')).toBeDefined();
  });

  it('answers 204 when the written item is not readable', async () => {
    const policy = (await data(await api('POST', '/policies', { name: 'Writer', permissions: [{ collection: 'posts', action: 'create', fields: ['title'] }] }))).id;
    await createUser({ email: 'writer@example.com', password: PASSWORD, policies: [{ policy }] });
    const { access_token } = await login('writer@example.com', PASSWORD);
    const res = await api('POST', '/items/posts', { title: 'Blind' }, access_token);
    expect(res.status).toBe(204);
    expect(await postOf('Blind')).toBeDefined();
  });
});

describe('several policies', () => {
  let reviewerAccess: string;

  beforeAll(async () => {
    // Reviewers also see published posts, but only their id, title and status.
    const reviewer = (await data(await api('POST', '/policies', { name: 'Reviewer' }))).id;
    await grant(reviewer, [{ collection: 'posts', action: 'read', permissions: { status: { _eq: 'published' } }, fields: ['id', 'title', 'status'] }]);
    reviewerAccess = (await data(await api('POST', '/access', { role: editorRole, policy: reviewer }))).id;
    await ok(await api('POST', '/items/posts', { title: 'Public news', body: 'secret body', status: 'published' }));
  });

  it('adds up rows; fields only show on the rows of a policy that grants them', async () => {
    const items = await data<Post[]>(await as(bob)('GET', '/items/posts?fields=title,body&sort=title'));
    expect(items).toEqual([
      { title: 'Bob 1', body: 'Bob 1 body' },
      { title: 'Public news', body: null },
    ]);
    // Hidden values can't be found through filters or search either.
    expect(await data(await as(bob)('GET', '/items/posts?fields=title&filter[body][_contains]=secret'))).toEqual([]);
    expect(await data(await as(bob)('GET', '/items/posts?fields=title&search=secret'))).toEqual([]);
  });

  it('stops applying when the access row is removed', async () => {
    expect((await api('DELETE', `/access/${reviewerAccess}`)).status).toBe(204);
    expect(titles(await data(await as(bob)('GET', '/items/posts')))).toEqual(['Bob 1']);
  });
});

describe('the public policy', () => {
  it('applies to requests without a user and to users without a role', async () => {
    expect(await errorOf(await call('/items/posts'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const [permission] = await grant(PUBLIC_POLICY, [{ collection: 'posts', action: 'read', permissions: { status: { _eq: 'published' } }, fields: ['title'] }]);
    expect(await data(await call('/items/posts'))).toEqual([{ title: 'Public news' }]);

    await createUser({ email: 'norole@example.com', password: PASSWORD });
    const { access_token } = await login('norole@example.com', PASSWORD);
    expect(await data(await api('GET', '/items/posts', undefined, access_token))).toEqual([{ title: 'Public news' }]);
    // Users with a role get their role's policies instead.
    expect(titles(await data(await as(bob)('GET', '/items/posts')))).toEqual(['Bob 1']);

    expect((await api('DELETE', `/permissions/${permission!.id}`)).status).toBe(204);
    expect(await errorOf(await call('/items/posts'))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('roles', () => {
  it('inherit the policies of their parent roles', async () => {
    const child = (await data(await api('POST', '/roles', { name: 'Junior editor', parent: editorRole }))).id;
    await createUser({ email: 'junior@example.com', password: PASSWORD, role: child });
    const { access_token } = await login('junior@example.com', PASSWORD);
    expect(await data(await api('GET', '/policies/me/globals', undefined, access_token))).toEqual({ app_access: true, admin_access: false, enforce_tfa: false });
    const mine = await data(await api('GET', '/roles/me?fields=id,name', undefined, access_token));
    expect(mine).toEqual(expect.arrayContaining([{ id: editorRole, name: 'Editor' }, { id: child, name: 'Junior editor' }]));
  });

  it('cannot be their own ancestors', async () => {
    const child = (await data(await api('POST', '/roles', { name: 'Child', parent: editorRole }))).id;
    expect(await errorOf(await api('PATCH', `/roles/${editorRole}`, { parent: child }))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
    expect(await errorOf(await api('PATCH', `/roles/${child}`, { parent: child }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('get their policies replaced, added and removed through nested writes', async () => {
    const [a, b] = [
      (await data(await api('POST', '/policies', { name: 'A' }))).id,
      (await data(await api('POST', '/policies', { name: 'B' }))).id,
    ];
    const role = (await data(await api('POST', '/roles', { name: 'Nested', policies: [{ policy: a }, { policy: b }] }))).id;
    const attached = async () => (await data<Array<{ policy: string }>>(await api('GET', `/access?filter[role][_eq]=${role}&fields=policy`))).map((x) => x.policy).sort();
    expect(await attached()).toEqual([a, b].sort());

    const rows = await data<Array<{ id: string; policy: string }>>(await api('GET', `/access?filter[role][_eq]=${role}`));
    const keepA = rows.find((r) => r.policy === a)!.id;
    // An array replaces the list: rows not in it are deleted.
    await ok(await api('PATCH', `/roles/${role}`, { policies: [keepA] }));
    expect(await attached()).toEqual([a]);
    await ok(await api('PATCH', `/roles/${role}`, { policies: { create: [{ policy: b }], update: [], delete: [keepA] } }));
    expect(await attached()).toEqual([b]);
  });
});

describe('the current user', () => {
  it('may read but not change their own record with app access', async () => {
    const me = await data(await as(alice)('GET', '/users/me?fields=id,email,role,password'));
    expect(me).toEqual({ id: alice.id, email: 'alice@example.com', role: editorRole, password: '**********' });
    expect(await errorOf(await as(alice)('PATCH', '/users/me', { first_name: 'Al' }))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await data(await as(alice)('GET', '/users'))).toEqual([expect.objectContaining({ id: alice.id })]);
  });

  it('may update themselves with a permission for it', async () => {
    const policy = (await data(await api('POST', '/policies', { name: 'Profile' }))).id;
    await grant(policy, [{ collection: 'directus_users', action: 'update', permissions: { id: { _eq: '$CURRENT_USER' } }, fields: ['first_name', 'password'] }]);
    await ok(await api('POST', '/access', { user: alice.id, policy }));
    expect(await data(await as(alice)('PATCH', '/users/me?fields=first_name', { first_name: 'Alice' }))).toEqual({ first_name: 'Alice' });
    expect(await errorOf(await as(alice)('PATCH', `/users/${bob.id}`, { first_name: 'Bobby' }))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await errorOf(await as(alice)('PATCH', '/users/me', { role: null }))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('permissions/me', () => {
  it('summarizes the access per collection and action', async () => {
    const { posts, directus_users } = await data(await as(alice)('GET', '/permissions/me'));
    expect(posts).toEqual({
      create: { access: 'full', fields: ['title', 'body', 'status'], presets: { status: 'draft' } },
      read: { access: 'partial', fields: ['*'], presets: null },
      update: { access: 'partial', fields: ['title', 'body', 'status'], presets: null },
      delete: { access: 'partial', fields: [], presets: null },
      share: { access: 'none' },
    });
    expect(directus_users.read).toEqual({ access: 'partial', fields: ['*'], presets: null });
    const admin = await data(await api('GET', '/permissions/me'));
    expect(admin.posts.read).toEqual({ access: 'full', fields: ['*'], presets: null });
  });

  it('tells whether an item may be updated and deleted', async () => {
    const [mine, bobs] = [await postOf('Alice 2'), await postOf('Bob 1')];
    expect(await data(await as(alice)('GET', `/permissions/me/posts/${mine.id}`))).toEqual({
      update: { access: true },
      delete: { access: true },
      share: { access: false },
    });
    expect(await data(await as(alice)('GET', `/permissions/me/posts/${bobs.id}`))).toEqual({
      update: { access: false },
      delete: { access: false },
      share: { access: false },
    });
  });
});

describe('collections and fields', () => {
  it('are listed when readable', async () => {
    const collections = await data<Array<{ collection: string }>>(await as(alice)('GET', '/collections'));
    expect(collections.map((c) => c.collection)).toEqual(['posts']);
    expect((await data<unknown[]>(await as(alice)('GET', '/fields/posts'))).length).toBe(6);
    expect(await data(await call('/collections'))).toEqual([]);
    expect(await errorOf(await call('/fields/posts'))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await errorOf(await as(alice)('POST', '/collections', { collection: 'nope', schema: {} }))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('policy limits', () => {
  it('ip_access limits a policy to networks', async () => {
    const policy = (await data(await api('POST', '/policies', { name: 'Office', ip_access: '10.0.0.0/8, 192.168.1.1' }))).id;
    expect((await data(await api('GET', `/policies/${policy}?fields=ip_access`))).ip_access).toEqual(['10.0.0.0/8', '192.168.1.1']);
    await grant(policy, [{ collection: 'posts', action: 'read', fields: ['title'] }]);
    await createUser({ email: 'office@example.com', password: PASSWORD, policies: [{ policy }] });
    const { access_token } = await login('office@example.com', PASSWORD);
    const from = (ip: string) => call('/items/posts', { headers: { Authorization: `Bearer ${access_token}`, 'CF-Connecting-IP': ip } });
    expect((await from('10.1.2.3')).status).toBe(200);
    expect((await from('8.8.8.8')).status).toBe(403);
    expect(await errorOf(await api('PATCH', `/policies/${policy}`, { ip_access: ['nope'] }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});

describe('dynamic variables', () => {
  it('reads fields of the current user', async () => {
    const policy = (await data(await api('POST', '/policies', { name: 'By title' }))).id;
    await grant(policy, [{ collection: 'posts', action: 'read', permissions: { status: { _eq: '$CURRENT_USER.title' } }, fields: ['title'] }]);
    await createUser({ email: 'pub@example.com', password: PASSWORD, title: 'published', policies: [{ policy }] });
    const { access_token } = await login('pub@example.com', PASSWORD);
    expect(await data(await api('GET', '/items/posts', undefined, access_token))).toEqual([{ title: 'Public news' }]);
  });
});

describe('field validation', () => {
  it('applies meta.validation to everyone', async () => {
    await ok(
      await api('POST', '/collections', {
        collection: 'codes',
        schema: {},
        fields: [{ field: 'code', type: 'string', meta: { validation: { _and: [{ code: { _regex: '^[A-Z]{3}$' } }] } } }],
      }),
    );
    expect(await errorOf(await api('POST', '/items/codes', { code: 'abc' }))).toMatchObject({ status: 400, code: 'FAILED_VALIDATION', field: 'code', type: 'regex' });
    await ok(await api('POST', '/items/codes', { code: 'ABC' }));
    // Fields the payload leaves out are not checked.
    await ok(await api('POST', '/items/codes', {}));
  });
});

describe('system collections', () => {
  it('check their payloads', async () => {
    const bad = (path: string, body: unknown) => api('POST', path, body).then(errorOf);
    expect(await bad('/permissions', { policy: editorPolicy, collection: 'posts', action: 'nope' })).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await bad('/permissions', { policy: editorPolicy, collection: 'posts', action: 'read', permissions: 'x' })).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await bad('/access', { role: editorRole, user: alice.id, policy: editorPolicy })).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await bad('/access', { role: editorRole, policy: '01a1857c-0000-7000-8000-000000000000' })).toMatchObject({ code: 'INVALID_FOREIGN_KEY' });
  });

  it('accept fields as a comma-separated string', async () => {
    const [p] = await grant(editorPolicy, [{ collection: 'codes', action: 'read', fields: 'id,code' }]);
    expect((await data(await api('GET', `/permissions/${p!.id}`))).fields).toEqual(['id', 'code']);
  });

  it('deleting a policy removes its permissions and access rows', async () => {
    const policy = (await data(await api('POST', '/policies', { name: 'Doomed', permissions: [{ collection: 'posts', action: 'read', fields: ['*'] }] }))).id;
    await ok(await api('POST', '/access', { role: editorRole, policy }));
    expect((await api('DELETE', `/policies/${policy}`)).status).toBe(204);
    const left = await env.DB.batch([
      env.DB.prepare('SELECT count(*) AS n FROM cirrus_permissions WHERE policy = ?').bind(policy),
      env.DB.prepare('SELECT count(*) AS n FROM cirrus_access WHERE policy = ?').bind(policy),
    ]);
    expect(left.map((r) => (r.results[0] as { n: number }).n)).toEqual([0, 0]);
  });

  it('are admin-only by default', async () => {
    for (const path of ['/roles', '/policies', '/access']) {
      expect(await errorOf(await as(alice)('POST', path, { name: 'x' }))).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await errorOf(await as(alice)('POST', '/permissions', { policy: editorPolicy, collection: 'posts', action: 'read' }))).toMatchObject({
      code: 'FORBIDDEN',
    });
    // Reading their own policies and permissions is part of app access.
    const mine = await data<Array<{ id: string }>>(await as(alice)('GET', '/policies?fields=id'));
    expect(mine.map((p) => p.id)).toContain(editorPolicy);
  });
});
