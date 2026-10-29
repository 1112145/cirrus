import { invalidPayload, isPlainObject } from '@cirrus/shared';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { type ClientInfo, login, logout, refresh, refreshTokenTtl, type Tokens } from '../auth/service.ts';
import type { AppEnv, Bindings } from '../env.ts';
import { readJson, readOptionalJson } from '../middleware/body.ts';

/**
 * SDK: login, refresh, logout (and the authentication() composable), readProviders. Modes follow
 * Directus: `json` returns the refresh token in the body; `cookie` sets it as an httpOnly cookie.
 * `session` mode (the access token in a cookie) comes with the admin app (M6).
 */
export const auth = new Hono<AppEnv>();

/** Directus' cookie name, so clients written for Directus find it. */
export const REFRESH_COOKIE = 'directus_refresh_token';

type Mode = 'json' | 'cookie';

function parseMode(v: unknown, fallback: Mode): Mode {
  if (v === undefined || v === null) return fallback;
  if (v === 'json' || v === 'cookie') return v;
  if (v === 'session') throw invalidPayload('"mode" "session" is not supported yet; use "json" or "cookie"');
  throw invalidPayload('"mode" must be one of "json", "cookie"');
}

function cookieOptions(env: Bindings): CookieOptions {
  const sameSite = (env.REFRESH_TOKEN_COOKIE_SAME_SITE ?? 'lax').toLowerCase();
  return {
    httpOnly: true,
    path: '/',
    maxAge: Math.floor(refreshTokenTtl(env) / 1000),
    secure: env.REFRESH_TOKEN_COOKIE_SECURE === 'true',
    sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax',
    ...(env.REFRESH_TOKEN_COOKIE_DOMAIN ? { domain: env.REFRESH_TOKEN_COOKIE_DOMAIN } : {}),
  };
}

/** Directus' login/refresh response for a mode. */
function respond(c: Context<AppEnv>, mode: Mode, t: Tokens) {
  if (mode === 'cookie') {
    setCookie(c, REFRESH_COOKIE, t.refreshToken, cookieOptions(c.env));
    return c.json({ data: { access_token: t.accessToken, expires: t.expires } });
  }
  return c.json({ data: { access_token: t.accessToken, refresh_token: t.refreshToken, expires: t.expires } });
}

const client = (c: Context<AppEnv>): ClientInfo => ({
  ip: c.req.header('CF-Connecting-IP') ?? null,
  userAgent: c.req.header('User-Agent') ?? null,
  origin: c.req.header('Origin') ?? null,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

auth.post('/login', async (c) => {
  const body = await readJson(c);
  if (!isPlainObject(body)) throw invalidPayload('Payload must be an object');
  if (body.email === undefined) throw invalidPayload('"email" is required');
  if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email)) throw invalidPayload('"email" must be a valid email');
  if (body.password === undefined) throw invalidPayload('"password" is required');
  if (typeof body.password !== 'string' || body.password === '') throw invalidPayload('"password" must be a non-empty string');
  // Directus defaults to json; the SDK always says which mode it wants. 2FA (`otp`) comes later.
  const mode = parseMode(body.mode, 'json');
  return respond(c, mode, await login(c.env, body.email, body.password, client(c)));
});

/** The refresh token from the body (json mode) or the cookie. */
function refreshTokenOf(c: Context<AppEnv>, body: Record<string, unknown>): string {
  const token = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : getCookie(c, REFRESH_COOKIE);
  if (!token) throw invalidPayload('The refresh token is required in either the payload or cookie');
  return token;
}

async function optionalObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = (await readOptionalJson(c)) ?? {};
  if (!isPlainObject(body)) throw invalidPayload('Payload must be an object');
  return body;
}

auth.post('/refresh', async (c) => {
  const body = await optionalObject(c);
  const token = refreshTokenOf(c, body);
  const mode = parseMode(body.mode, typeof body.refresh_token === 'string' ? 'json' : 'cookie');
  return respond(c, mode, await refresh(c.env, token));
});

auth.post('/logout', async (c) => {
  const body = await optionalObject(c);
  await logout(c.env, refreshTokenOf(c, body));
  if (getCookie(c, REFRESH_COOKIE) !== undefined) {
    const { domain, secure, sameSite } = cookieOptions(c.env);
    deleteCookie(c, REFRESH_COOKIE, { path: '/', secure, sameSite, ...(domain ? { domain } : {}) });
  }
  return c.body(null, 204);
});

// SDK: readProviders() — only the built-in email/password login for now.
auth.get('/', (c) => c.json({ data: [], disableDefault: false }));
