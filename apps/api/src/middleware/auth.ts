import { CirrusError, decodeJwt, forbidden, JwtError, sha256Hex, verifyJwt } from '@cirrus/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings, Identity } from '../env.ts';
import { requestContext } from '../request.ts';

/** `iss` of Cirrus access tokens. Directus' value, so tokens look the same to clients. */
export const JWT_ISSUER = 'directus';

/**
 * Who is calling (spec §10): a token in `Authorization: Bearer <token>` or `?access_token=`, as in
 * Directus. A token is the ADMIN_TOKEN, an access token (a JWT issued by /auth/login), or a user's
 * static token. No token = public. A token that doesn't check out is rejected, never ignored.
 */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractToken(c.req.header('Authorization'), c.req.query('access_token'));
  c.set('identity', await identify(c.env, token));
  await next();
};

export async function identify(env: Bindings, token: string | null): Promise<Identity> {
  if (token === null) return { kind: 'public' };
  if (await matches(token, env.ADMIN_TOKEN)) return { kind: 'admin-token' };

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
    return { kind: 'user', user: claims.id, role: typeof claims.role === 'string' ? claims.role : null };
  }

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
