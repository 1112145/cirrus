import { CirrusError, invalidPayload, isPlainObject, JwtError, verifyJwt } from '@cirrus/shared';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { type ClientInfo, login, logout, refresh, refreshSession, refreshTokenTtl, sessionTtl, type Tokens } from '../auth/service.ts';
import type { AppEnv, Bindings } from '../env.ts';
import { JWT_ISSUER, SESSION_COOKIE } from '../middleware/auth.ts';
import { readJson, readOptionalJson } from '../middleware/body.ts';

/**
 * SDK: login, refresh, logout (and the authentication() composable), readProviders. Modes follow
 * Directus: `json` returns the refresh token in the body; `cookie` sets it as an httpOnly cookie;
 * `session` (the admin app's) sets the access token itself as an httpOnly cookie, which then
 * authenticates requests (ADR-027).
 */
export const auth = new Hono<AppEnv>();

/** Directus' cookie name, so clients written for Directus find it. */
export const REFRESH_COOKIE = 'directus_refresh_token';

type Mode = 'json' | 'cookie' | 'session';

function parseMode(v: unknown, fallback: Mode): Mode {
  if (v === undefined || v === null) return fallback;
  if (v === 'json' || v === 'cookie' || v === 'session') return v;
  throw invalidPayload('"mode" must be one of "json", "cookie", "session"');
}

/** The attributes of a cookie, from Directus' REFRESH_TOKEN_COOKIE_* or SESSION_COOKIE_* variables. */
function cookieOptions(env: Bindings, kind: 'refresh' | 'session'): CookieOptions {
  const [sameSiteVar, secure, domain, ttl] =
    kind === 'refresh'
      ? [env.REFRESH_TOKEN_COOKIE_SAME_SITE, env.REFRESH_TOKEN_COOKIE_SECURE, env.REFRESH_TOKEN_COOKIE_DOMAIN, refreshTokenTtl(env)]
      : [env.SESSION_COOKIE_SAME_SITE, env.SESSION_COOKIE_SECURE, env.SESSION_COOKIE_DOMAIN, sessionTtl(env)];
  const sameSite = (sameSiteVar ?? 'lax').toLowerCase();
  return {
    httpOnly: true,
    path: '/',
    maxAge: Math.floor(ttl / 1000),
    secure: secure === 'true',
    sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax',
    ...(domain ? { domain } : {}),
  };
}

/** Directus' login/refresh response for a mode. */
function respond(c: Context<AppEnv>, mode: Mode, t: Tokens) {
  if (mode === 'session') {
    setCookie(c, SESSION_COOKIE, t.accessToken, cookieOptions(c.env, 'session'));
    return c.json({ data: { expires: t.expires } });
  }
  if (mode === 'cookie') {
    setCookie(c, REFRESH_COOKIE, t.refreshToken, cookieOptions(c.env, 'refresh'));
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
  return respond(c, mode, await login(c.env, body.email, body.password, client(c), { session: mode === 'session' }));
});

const missingToken = () => invalidPayload('The refresh token is required in either the payload or cookie');

/** The refresh token from the body (json mode) or the cookie. */
function refreshTokenOf(c: Context<AppEnv>, body: Record<string, unknown>): string {
  const token = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : getCookie(c, REFRESH_COOKIE);
  if (!token) throw missingToken();
  return token;
}

/**
 * The session a session cookie names (Directus: its `session` claim). Refreshing needs an unexpired
 * token, as in Directus; logging out accepts an expired one, so the session still ends.
 */
async function sessionOf(c: Context<AppEnv>, opts: { expired?: boolean } = {}): Promise<string> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) throw missingToken();
  let claims;
  try {
    if (!c.env.SECRET) throw new JwtError('invalid');
    claims = await verifyJwt(cookie, c.env.SECRET, { issuer: JWT_ISSUER, ignoreExpiration: opts.expired === true });
  } catch (e) {
    if (e instanceof JwtError && e.reason === 'expired') throw new CirrusError('TOKEN_EXPIRED', 'Token expired.');
    throw new CirrusError('INVALID_TOKEN', 'Invalid token.');
  }
  if (typeof claims.session !== 'string') throw new CirrusError('INVALID_TOKEN', 'Invalid token.');
  return claims.session;
}

async function optionalObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = (await readOptionalJson(c)) ?? {};
  if (!isPlainObject(body)) throw invalidPayload('Payload must be an object');
  return body;
}

/** Directus getCurrentMode: the one asked for, else json with a refresh token in the body, else cookie. */
const modeOf = (body: Record<string, unknown>) => parseMode(body.mode, typeof body.refresh_token === 'string' ? 'json' : 'cookie');

auth.post('/refresh', async (c) => {
  const body = await optionalObject(c);
  const mode = modeOf(body);
  if (mode === 'session') return respond(c, mode, await refreshSession(c.env, await sessionOf(c)));
  return respond(c, mode, await refresh(c.env, refreshTokenOf(c, body)));
});

auth.post('/logout', async (c) => {
  const body = await optionalObject(c);
  const mode = modeOf(body);
  await logout(c.env, mode === 'session' ? await sessionOf(c, { expired: true }) : refreshTokenOf(c, body));
  for (const [name, kind] of [
    [REFRESH_COOKIE, 'refresh'],
    [SESSION_COOKIE, 'session'],
  ] as const) {
    if (getCookie(c, name) === undefined) continue;
    const { domain, secure, sameSite } = cookieOptions(c.env, kind);
    deleteCookie(c, name, { path: '/', secure, sameSite, ...(domain ? { domain } : {}) });
  }
  return c.body(null, 204);
});

// SDK: readProviders() — only the built-in email/password login for now.
auth.get('/', (c) => c.json({ data: [], disableDefault: false }));
