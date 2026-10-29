import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call } from './helpers.ts';

describe('/server', () => {
  it('GET /server/ping → pong', async () => {
    const res = await call('/server/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('GET /server/info → project info wrapped in data', async () => {
    const res = await call('/server/info');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { project: { project_name: string } } }>();
    expect(body.data.project.project_name).toBe('Cirrus');
  });

  it('GET /server/health → ok when D1 is reachable', async () => {
    const res = await call('/server/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/health+json');
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('error format', () => {
  it('unknown route → Directus-style ROUTE_NOT_FOUND', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      errors: [{ message: "Route /nope doesn't exist.", extensions: { code: 'ROUTE_NOT_FOUND', path: '/nope' } }],
    });
  });
});

describe('system tables', () => {
  const expected = [
    'cirrus_access',
    'cirrus_batch_keys',
    'cirrus_collections',
    'cirrus_fields',
    'cirrus_files',
    'cirrus_folders',
    'cirrus_guard',
    'cirrus_permissions',
    'cirrus_policies',
    'cirrus_relations',
    'cirrus_roles',
    'cirrus_sessions',
    'cirrus_settings',
    'cirrus_users',
  ];

  it('migration creates every table', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cirrus_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(expected);
  });

  it('seed schema_version', async () => {
    const row = await env.DB.prepare("SELECT value FROM cirrus_settings WHERE key = 'schema_version'").first<{ value: string }>();
    expect(row?.value).toBe('1');
  });

  it('rejects collections using the cirrus_ prefix', async () => {
    await expect(env.DB.prepare("INSERT INTO cirrus_collections (collection) VALUES ('cirrus_hack')").run()).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await env.DB.prepare("INSERT INTO cirrus_collections (collection) VALUES ('posts')").run();
  });

  it('access cannot target both a role and a user', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cirrus_roles (id, name) VALUES ('r1', 'Editor')"),
      env.DB.prepare("INSERT INTO cirrus_users (id, email) VALUES ('u1', 'a@b.c')"),
      env.DB.prepare("INSERT INTO cirrus_policies (id, name) VALUES ('p1', 'Content')"),
    ]);
    await expect(
      env.DB.prepare("INSERT INTO cirrus_access (id, role, user, policy) VALUES ('a1', 'r1', 'u1', 'p1')").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    // public policy: both NULL
    await env.DB.prepare("INSERT INTO cirrus_access (id, policy) VALUES ('a2', 'p1')").run();
  });

  it('user emails are case-insensitive', async () => {
    await env.DB.prepare("INSERT INTO cirrus_users (id, email) VALUES ('u2', 'Khoa@Example.com')").run();
    await expect(env.DB.prepare("INSERT INTO cirrus_users (id, email) VALUES ('u3', 'khoa@example.com')").run()).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });
});
