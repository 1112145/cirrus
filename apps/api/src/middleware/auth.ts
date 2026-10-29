import { CirrusError, forbidden } from '@cirrus/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';

/**
 * Until M3, the only credential is the ADMIN_TOKEN secret, sent like a Directus static token:
 * `Authorization: Bearer <token>` or `?access_token=<token>`. No token = public. A wrong token is
 * rejected, as Directus does.
 */
export const accountability: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractToken(c.req.header('Authorization'), c.req.query('access_token'));
  const admin = token !== null && (await matches(token, c.env.ADMIN_TOKEN));
  if (token !== null && !admin) throw new CirrusError('INVALID_CREDENTIALS', 'Invalid user credentials.');
  c.set('accountability', { admin });
  await next();
};

export const isAdmin = (c: Context<AppEnv>) => c.get('accountability').admin;

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(c)) throw forbidden();
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
