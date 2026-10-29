import { CirrusError, decodeJwt, forbidden, JwtError, sha256Hex, verifyJwt } from '@cirrus/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { sessionIsOpen } from '../auth/service.ts';
import type { AppEnv, Bindings, Identity } from '../env.ts';
import { requestContext } from '../request.ts';

/** `iss` of Cirrus access tokens. Directus' value, so tokens look the same to clients. */
export const JWT_ISSUER = 'directus';

/** The cookie holding the access token of a `session` mode login (Directus SESSION_COOKIE_NAME). */
export const SESSION_COOKIE = 'directus_session_token';

/**
 * Who is calling (spec §10): a token in `Authorization: Bearer <token>` or `?access_token=`, as in
 * Directus. A token is the ADMIN_TOKEN, an access token (a JWT issued by /auth/login), or a user's
 * static token. No token = public. A token that doesn't check out is rejected, never ignored.
 *
 * Without one, the session cookie of a `session` mode login is used, as in Directus. A cookie the
 * browser sends on its own is treated more carefully than a token the client chose to send: one
 * that doesn't check out (expired, logged out, signed with an old secret) is ignored rather than
 * failing every request, logins included; and it only counts for requests that can't come from
 * another site's page (no cross-origin Origin on writes), against CSRF beyond what SameSite stops.
 */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractToken(c.req.header('Authorization'), c.req.query('access_token'));
  if (token !== null) {
    c.set('identity', await identify(c.env, token));
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    let identity: Identity = { kind: 'public' };
    if (cookie && sameOrigin(c)) {
      try {
        identity = await identify(c.env, cookie, { jwtOnly: true });
      } catch {
        // An unusable session cookie: the request is public.
      }
    }
    c.set('identity', identity);
  }
  await next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A write whose Origin is another site's isn't authenticated by the session cookie. */
function sameOrigin(c: Context<AppEnv>): boolean {
  if (SAFE_METHODS.has(c.req.method)) return true;
  const origin = c.req.header('Origin');
  return !origin || origin === new URL(c.req.url).origin;
}

/** The identity a token stands for; `jwtOnly` (session cookies) refuses anything but an access token. */
export async function identify(env: Bindings, token: string | null, opts: { jwtOnly?: boolean } = {}): Promise<Identity> {
  if (token === null) return { kind: 'public' };
  if (!opts.jwtOnly && (await matches(token, env.ADMIN_TOKEN))) return { kind: 'admin-token' };

  if (decodeJwt(token)?.iss === JWT_ISSUER) {
    let claims;
    try {
      if (!env.SECRET) throw new JwtError('invalid');
      claims = await verifyJwt(token, env.SECRET, { issuer: JWT_ISSUER });
    } catch (e) {
      if (e instanceof JwtError && e.reason === 'expired') throw new CirrusError('TOKEN_EXPIRED', 'Token expired.');
      throw new CirrusError('INVALID_TOKEN', 'Invalid token.');
    }
    if (typeof claims.id !== 'string') throw new CirrusError('INVALID_TOKEN', 'Invalid token.');
    // A session token (Directus' `session` claim) is only good while its session is open.
    if (claims.session !== undefined && (typeof claims.session !== 'string' || !(await sessionIsOpen(env, claims.session, claims.id)))) {
      throw new CirrusError('INVALID_CREDENTIALS', 'Invalid user credentials.');
    }
    return { kind: 'user', user: claims.id, role: typeof claims.role === 'string' ? claims.role : null };
  }
  if (opts.jwtOnly) throw new CirrusError('INVALID_TOKEN', 'Invalid token.');

  // A static token: stored as its SHA-256, and only active users may use theirs.
  const user = await env.DB.prepare("SELECT id, role FROM cirrus_users WHERE token = ?1 AND status = 'active'")
    .bind(await sha256Hex(token))
    .first<{ id: string; role: string | null }>();
  if (!user) throw new CirrusError('INVALID_CREDENTIALS', 'Invalid user credentials.');
  return { kind: 'user', user: user.id, role: user.role };
}

export const isAdmin = async (c: Context<AppEnv>) => (await requestContext(c)).accountability.admin;

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await isAdmin(c))) throw forbidden();
  await next();
};

function extractToken(header: string | undefined, query: string | undefined): string | null {
  const bearer = header && /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
  return bearer || query || null;
}

/** Constant-time comparison; hashing first makes the lengths equal. */
async function matches(token: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(token), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
