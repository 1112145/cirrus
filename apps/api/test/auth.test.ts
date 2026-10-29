import { sha256Hex, signJwt, verifyJwt, verifySecret } from '@cirrus/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLE, api, call, createUser, errorOf, login, ok } from './helpers.ts';

/** Every test in this file shares one D1 database, so each uses its own users. */

const PASSWORD = 'correct horse battery staple';

const me = (token: string | null, query = '') => api('GET', `/users/me${query}`, undefined, token);

/** The refresh token cookie a response sets: its value and attributes. */
function refreshCookie(res: Response) {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('directus_refresh_token='));
  if (!header) return null;
  const [pair, ...attrs] = header.split(';').map((s) => s.trim());
  return { value: decodeURIComponent(pair!.slice('directus_refresh_token='.length)), attrs };
}

describe('users', () => {
  it('stores passwords as PBKDF2 hashes and conceals them', async () => {
    const id = await createUser({ email: 'hash@example.com', password: PASSWORD, first_name: 'Hash' });
    const row = await env.DB.prepare('SELECT password FROM cirrus_users WHERE id = ?').bind(id).first<{ password: string }>();
    expect(row!.password).toMatch(/^\$pbkdf2-sha256\$/);
    expect(await verifySecret(PASSWORD, row!.password)).toBe(true);

    const { data } = await ok(await api('GET', `/users/${id}`));
    expect(data).toMatchObject({ id, email: 'hash@example.com', first_name: 'Hash', password: '**********', status: 'active', role: null, provider: 'default', email_notifications: true, token: null });
  });

  it('checks emails and statuses', async () => {
    expect(await errorOf(await api('POST', '/users', { email: 'not-an-email', password: 'x' }))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
    expect(await errorOf(await api('POST', '/users', { email: 'st@example.com', status: 'sleeping' }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await errorOf(await api('POST', '/users', { password: 'x' }))).toMatchObject({ code: 'NOT_NULL_VIOLATION', collection: 'directus_users', field: 'email' });
    await createUser({ email: 'Dup@Example.com' });
    expect(await errorOf(await api('POST', '/users', { email: 'dup@example.com' }))).toEqual({
      status: 400,
      code: 'RECORD_NOT_UNIQUE',
      collection: 'directus_users',
      field: 'email',
    });
  });

  it('rejects roles that do not exist', async () => {
    const res = await api('POST', '/users', { email: 'norole@example.com', role: '01a1857c-0000-7000-8000-000000000000' });
    expect(await errorOf(res)).toMatchObject({ status: 400, code: 'INVALID_FOREIGN_KEY' });
  });

  it('cannot be found by their password hash or token', async () => {
    await createUser({ email: 'probe@example.com', password: PASSWORD });
    expect(await errorOf(await api('GET', '/users?filter[password][_starts_with]=$pbkdf2'))).toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(await errorOf(await api('GET', '/users?sort=token'))).toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    const { data } = await ok(await api('GET', '/users?filter[email][_eq]=probe@example.com&filter[password][_nnull]=true&fields=email'));
    expect(data).toEqual([{ email: 'probe@example.com' }]);
  });

  it('is not reachable through /items', async () => {
    expect(await errorOf(await api('GET', '/items/directus_users'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('login', () => {
  it('returns an access token, a refresh token and the access token lifetime', async () => {
    const id = await createUser({ email: 'login@example.com', password: PASSWORD });
    const before = Date.now();
    const { access_token, refresh_token, expires } = await login('login@example.com', PASSWORD);
    expect(expires).toBe(15 * 60 * 1000);
    expect(refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const claims = await verifyJwt(access_token, 'test-secret', { issuer: 'directus' });
    expect(claims).toMatchObject({ id, role: null, app_access: false, admin_access: false, iss: 'directus' });
    expect(claims.exp! - claims.iat!).toBe(900);

    // Only the refresh token's digest is stored.
    const session = await env.DB.prepare('SELECT * FROM cirrus_sessions WHERE user = ?').bind(id).first<Record<string, string>>();
    expect(session!.token).toBe(await sha256Hex(refresh_token));
    expect(Date.parse(session!.expires!) - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);

    const user = await env.DB.prepare('SELECT last_access FROM cirrus_users WHERE id = ?').bind(id).first<{ last_access: string }>();
    expect(Date.parse(user!.last_access)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('identifies the user on later requests', async () => {
    const id = await createUser({ email: 'whoami@example.com', password: PASSWORD });
    const { access_token } = await login('whoami@example.com', PASSWORD);
    // Without permission to read themselves, Directus answers with the id only.
    expect(await ok(await me(access_token))).toEqual({ data: { id } });
    expect(await ok(await call(`/users/me?access_token=${access_token}`))).toEqual({ data: { id } });
  });

  it('matches emails ignoring case', async () => {
    await createUser({ email: 'Case@Example.com', password: PASSWORD });
    expect((await login('case@EXAMPLE.com', PASSWORD)).access_token).toBeTruthy();
  });

  it('rejects wrong credentials the same way for unknown emails', async () => {
    await createUser({ email: 'wrong@example.com', password: PASSWORD });
    await createUser({ email: 'nopassword@example.com' });
    const expected = { status: 401, code: 'INVALID_CREDENTIALS' };
    for (const [email, password] of [
      ['wrong@example.com', 'nope'],
      ['nobody@example.com', PASSWORD],
      ['nopassword@example.com', PASSWORD],
    ]) {
      const res = await api('POST', '/auth/login', { email, password, mode: 'json' }, null);
      expect(await errorOf(res)).toEqual(expected);
    }
  });

  it('refuses users that are not active, telling suspended users once the password is right', async () => {
    await createUser({ email: 'suspended@example.com', password: PASSWORD, status: 'suspended' });
    await createUser({ email: 'invited@example.com', password: PASSWORD, status: 'invited' });
    const attempt = (email: string, password: string) => api('POST', '/auth/login', { email, password }, null);
    expect(await errorOf(await attempt('suspended@example.com', PASSWORD))).toEqual({ status: 401, code: 'USER_SUSPENDED' });
    expect(await errorOf(await attempt('suspended@example.com', 'nope'))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(await errorOf(await attempt('invited@example.com', PASSWORD))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('validates the payload', async () => {
    const attempt = (body: unknown) => api('POST', '/auth/login', body, null);
    expect(await errorOf(await attempt({ password: 'x' }))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD', reason: '"email" is required' });
    expect(await errorOf(await attempt({ email: 'x', password: 'x' }))).toMatchObject({ code: 'INVALID_PAYLOAD', reason: '"email" must be a valid email' });
    expect(await errorOf(await attempt({ email: 'a@b.c' }))).toMatchObject({ code: 'INVALID_PAYLOAD', reason: '"password" is required' });
    expect(await errorOf(await attempt({ email: 'a@b.c', password: 'x', mode: 'nope' }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});

describe('refresh and logout (json mode)', () => {
  it('rotates the refresh token: each one works once', async () => {
    const id = await createUser({ email: 'rotate@example.com', password: PASSWORD });
    const first = await login('rotate@example.com', PASSWORD);
    const { data: second } = await ok(await api('POST', '/auth/refresh', { refresh_token: first.refresh_token, mode: 'json' }, null));
    expect(second).toEqual({ access_token: expect.any(String), refresh_token: expect.any(String), expires: 900_000 });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await ok(await me(second.access_token))).toEqual({ data: { id } });

    const reuse = await api('POST', '/auth/refresh', { refresh_token: first.refresh_token, mode: 'json' }, null);
    expect(await errorOf(reuse)).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
    // The mode defaults to json when the token is in the body.
    const { data: third } = await ok(await api('POST', '/auth/refresh', { refresh_token: second.refresh_token }, null));
    expect(third.refresh_token).toBeTruthy();
  });

  it('logout ends the session', async () => {
    await createUser({ email: 'logout@example.com', password: PASSWORD });
    const { refresh_token } = await login('logout@example.com', PASSWORD);
    const res = await api('POST', '/auth/logout', { refresh_token, mode: 'json' }, null);
    expect(res.status).toBe(204);
    expect(await errorOf(await api('POST', '/auth/refresh', { refresh_token, mode: 'json' }, null))).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // Unknown tokens are ignored; a missing one is an error.
    expect((await api('POST', '/auth/logout', { refresh_token: 'nope', mode: 'json' }, null)).status).toBe(204);
    expect(await errorOf(await api('POST', '/auth/logout', { mode: 'json' }, null))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
  });

  it('refuses expired sessions and users that are no longer active, and removes them', async () => {
    const id = await createUser({ email: 'expire@example.com', password: PASSWORD });
    const a = await login('expire@example.com', PASSWORD);
    const b = await login('expire@example.com', PASSWORD);
    await env.DB.prepare("UPDATE cirrus_sessions SET expires = '2000-01-01T00:00:00.000Z' WHERE token = ?").bind(await sha256Hex(a.refresh_token)).run();
    expect(await errorOf(await api('POST', '/auth/refresh', { refresh_token: a.refresh_token }, null))).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    await ok(await api('PATCH', `/users/${id}`, { status: 'suspended' }));
    expect(await errorOf(await api('POST', '/auth/refresh', { refresh_token: b.refresh_token }, null))).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const left = await env.DB.prepare('SELECT count(*) AS n FROM cirrus_sessions WHERE user = ?').bind(id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('deleting a user deletes their sessions', async () => {
    const id = await createUser({ email: 'gone@example.com', password: PASSWORD });
    const { refresh_token } = await login('gone@example.com', PASSWORD);
    expect((await api('DELETE', `/users/${id}`)).status).toBe(204);
    expect(await errorOf(await api('POST', '/auth/refresh', { refresh_token }, null))).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('cookie mode', () => {
  it('keeps the refresh token in an httpOnly cookie', async () => {
    const id = await createUser({ email: 'cookie@example.com', password: PASSWORD });
    const res = await api('POST', '/auth/login', { email: 'cookie@example.com', password: PASSWORD, mode: 'cookie' }, null);
    const body = await ok(res);
    expect(body.data).toEqual({ access_token: expect.any(String), expires: 900_000 });
    const cookie = refreshCookie(res)!;
    expect(cookie.attrs).toEqual(expect.arrayContaining(['Max-Age=604800', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']));

    const refreshed = await call('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `directus_refresh_token=${cookie.value}` },
      body: JSON.stringify({ mode: 'cookie' }),
    });
    const { data } = await ok(refreshed);
    expect(await ok(await me(data.access_token))).toEqual({ data: { id } });
    const next = refreshCookie(refreshed)!;
    expect(next.value).not.toBe(cookie.value);

    // An empty body works too: the mode defaults to cookie.
    const again = await call('/auth/refresh', { method: 'POST', headers: { Cookie: `directus_refresh_token=${next.value}` } });
    const last = refreshCookie(again)!;
    expect(again.status).toBe(200);

    const out = await call('/auth/logout', { method: 'POST', headers: { Cookie: `directus_refresh_token=${last.value}` } });
    expect(out.status).toBe(204);
    expect(refreshCookie(out)).toMatchObject({ value: '', attrs: expect.arrayContaining(['Max-Age=0']) });
    const after = await call('/auth/refresh', { method: 'POST', headers: { Cookie: `directus_refresh_token=${last.value}` } });
    expect(await errorOf(after)).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

/** A cookie a response sets: its value and attributes. */
function setCookie(res: Response, name: string) {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  const [pair, ...attrs] = header.split(';').map((s) => s.trim());
  return { value: decodeURIComponent(pair!.slice(name.length + 1)), attrs };
}

const SESSION = 'directus_session_token';
const withSession = (value: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), Cookie: `${SESSION}=${value}` } });

describe('session mode', () => {
  const sessionLogin = async (email: string) => {
    const res = await api('POST', '/auth/login', { email, password: PASSWORD, mode: 'session' }, null);
    expect(await ok(res)).toEqual({ data: { expires: 86_400_000 } });
    return setCookie(res, SESSION)!;
  };

  it('keeps the access token in an httpOnly cookie that authenticates requests', async () => {
    const id = await createUser({ email: 'session@example.com', password: PASSWORD });
    const cookie = await sessionLogin('session@example.com');
    expect(cookie.attrs).toEqual(expect.arrayContaining(['Max-Age=86400', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']));
    const claims = await verifyJwt(cookie.value, 'test-secret', { issuer: 'directus' });
    expect(claims).toMatchObject({ id, session: expect.any(String) });
    expect(claims.exp! - claims.iat!).toBe(86_400);
    // Only the session token's digest is stored; the session lasts as long as the cookie.
    const session = await env.DB.prepare('SELECT expires FROM cirrus_sessions WHERE token = ?').bind(await sha256Hex(claims.session as string)).first<{ expires: string }>();
    expect(Date.parse(session!.expires) - Date.now()).toBeGreaterThan(86_000_000);

    expect(await ok(await call('/users/me', withSession(cookie.value)))).toEqual({ data: { id } });
    // A token the client sends wins over the cookie.
    expect(await errorOf(await call('/users/me', withSession(cookie.value, { headers: { Authorization: 'Bearer test-admin-token' } })))).toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('refreshes by extending the session, so every tab keeps working', async () => {
    const id = await createUser({ email: 'session-refresh@example.com', password: PASSWORD });
    const cookie = await sessionLogin('session-refresh@example.com');
    const res = await call('/auth/refresh', withSession(cookie.value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) }));
    expect(await ok(res)).toEqual({ data: { expires: 86_400_000 } });
    const next = setCookie(res, SESSION)!;
    const [before, after] = await Promise.all([verifyJwt(cookie.value, 'test-secret', { issuer: 'directus' }), verifyJwt(next.value, 'test-secret', { issuer: 'directus' })]);
    expect(after.session).toBe(before.session);
    expect(await ok(await call('/users/me', withSession(cookie.value)))).toEqual({ data: { id } });
    expect(await ok(await call('/users/me', withSession(next.value)))).toEqual({ data: { id } });
    // Session mode needs the cookie.
    const missing = await call('/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) });
    expect(await errorOf(missing)).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('logs out: the session ends and the cookie is cleared', async () => {
    await createUser({ email: 'session-out@example.com', password: PASSWORD });
    const cookie = await sessionLogin('session-out@example.com');
    const out = await call('/auth/logout', withSession(cookie.value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) }));
    expect(out.status).toBe(204);
    expect(setCookie(out, SESSION)).toMatchObject({ value: '', attrs: expect.arrayContaining(['Max-Age=0']) });
    // The old cookie no longer authenticates: the request is public.
    expect(await errorOf(await call('/users/me', withSession(cookie.value)))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
    const refresh = await call('/auth/refresh', withSession(cookie.value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) }));
    expect(await errorOf(refresh)).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // The same cookie sent as a token is refused outright.
    expect(await errorOf(await me(cookie.value))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('ignores session cookies that are expired, forged or for suspended users, so logging in still works', async () => {
    const id = await createUser({ email: 'session-stale@example.com', password: PASSWORD });
    const expired = await signJwt({ id, session: 'x' }, 'test-secret', { expiresIn: 60, issuer: 'directus', now: Date.now() - 120_000 });
    const foreign = await signJwt({ id, session: 'x' }, 'old-secret', { expiresIn: 60, issuer: 'directus' });
    for (const stale of [expired, foreign, 'garbage', 'test-admin-token']) {
      expect(await errorOf(await call('/users/me', withSession(stale)))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
      const res = await call(
        '/auth/login',
        withSession(stale, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'session-stale@example.com', password: PASSWORD, mode: 'session' }) }),
      );
      expect(res.status).toBe(200);
    }
    const refresh = await call('/auth/refresh', withSession(expired, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) }));
    expect(await errorOf(refresh)).toMatchObject({ code: 'TOKEN_EXPIRED' });

    const cookie = await sessionLogin('session-stale@example.com');
    await ok(await api('PATCH', `/users/${id}`, { status: 'suspended' }));
    const suspended = await call('/auth/refresh', withSession(cookie.value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) }));
    expect(await errorOf(suspended)).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await errorOf(await call('/users/me', withSession(cookie.value)))).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it("doesn't authenticate writes from another site's pages", async () => {
    await createUser({ email: 'session-csrf@example.com', password: PASSWORD, role: ADMIN_ROLE });
    const cookie = await sessionLogin('session-csrf@example.com');
    const write = (origin: string | null) =>
      call(
        '/collections',
        withSession(cookie.value, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
          body: JSON.stringify({ collection: `csrf_${origin ? origin.length : 0}`, schema: {}, fields: [] }),
        }),
      );
    expect(await errorOf(await write('https://evil.example'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await write('http://cirrus.test')).status).toBe(200);
    expect((await write(null)).status).toBe(200);
  });
});

describe('access tokens', () => {
  it('rejects tampered, foreign and expired tokens', async () => {
    const id = await createUser({ email: 'jwt@example.com', password: PASSWORD });
    const { access_token } = await login('jwt@example.com', PASSWORD);
    const [header, , signature] = access_token.split('.');
    const forgedBody = btoa(JSON.stringify({ id, role: ADMIN_ROLE, iss: 'directus', exp: 9e9 })).replace(/=+$/, '');
    expect(await errorOf(await me(`${header}.${forgedBody}.${signature}`))).toEqual({ status: 401, code: 'INVALID_TOKEN' });

    const foreign = await signJwt({ id }, 'another-secret', { expiresIn: 60, issuer: 'directus' });
    expect(await errorOf(await me(foreign))).toEqual({ status: 401, code: 'INVALID_TOKEN' });

    const expired = await signJwt({ id }, 'test-secret', { expiresIn: 60, issuer: 'directus', now: Date.now() - 120_000 });
    expect(await errorOf(await me(expired))).toEqual({ status: 401, code: 'TOKEN_EXPIRED' });
  });

  it('takes the role from the token, the policies from the current snapshot', async () => {
    const id = await createUser({ email: 'admin-jwt@example.com', password: PASSWORD, role: ADMIN_ROLE });
    const { access_token } = await login('admin-jwt@example.com', PASSWORD);
    expect((await verifyJwt(access_token, 'test-secret', { issuer: 'directus' })).admin_access).toBe(true);
    const { data } = await ok(await me(access_token, '?fields=id,email,role'));
    expect(data).toEqual({ id, email: 'admin-jwt@example.com', role: ADMIN_ROLE });
    // Admins may change the schema.
    const res = await api('POST', '/collections', { collection: 'jwt_made', schema: {}, fields: [] }, access_token);
    expect(res.status).toBe(200);
  });
});

describe('static tokens', () => {
  it('authenticate as the user; only their digest is stored', async () => {
    const id = await createUser({ email: 'static@example.com', token: 'my-static-token-1234567890' });
    const row = await env.DB.prepare('SELECT token FROM cirrus_users WHERE id = ?').bind(id).first<{ token: string }>();
    expect(row!.token).toBe(await sha256Hex('my-static-token-1234567890'));
    expect(await ok(await me('my-static-token-1234567890'))).toEqual({ data: { id } });
    expect((await ok(await api('GET', `/users/${id}?fields=token`))).data).toEqual({ token: '**********' });

    expect(await errorOf(await me('not-a-known-token'))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
    await ok(await api('PATCH', `/users/${id}`, { status: 'suspended' }));
    expect(await errorOf(await me('my-static-token-1234567890'))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('ADMIN_TOKEN has no user', async () => {
    expect(await errorOf(await me('test-admin-token'))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('public requests have no user either', async () => {
    expect(await errorOf(await me(null))).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });
  });
});

describe('providers', () => {
  it('lists none besides email and password', async () => {
    expect(await (await call('/auth')).json()).toEqual({ data: [], disableDefault: false });
  });
});
