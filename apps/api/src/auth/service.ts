import { CirrusError, parseDuration, randomToken, sha256Hex, signJwt, verifySecret } from '@cirrus/shared';
import type { Bindings } from '../env.ts';
import { JWT_ISSUER } from '../middleware/auth.ts';
import { accountabilityFor } from '../request.ts';
import { getSchema } from '../schema/store.ts';

/**
 * Email/password login with short-lived access tokens (HS256 JWTs) and refresh tokens kept in
 * cirrus_sessions, so they can be revoked (spec §10). Refresh tokens rotate on every use and are
 * stored only as their SHA-256.
 */

export type Tokens = { accessToken: string; refreshToken: string; /** Access token lifetime in ms, as Directus reports it. */ expires: number };

export type ClientInfo = { ip: string | null; userAgent: string | null; origin: string | null };

export const accessTokenTtl = (env: Bindings) => parseDuration(env.ACCESS_TOKEN_TTL, 15 * 60_000);
export const refreshTokenTtl = (env: Bindings) => parseDuration(env.REFRESH_TOKEN_TTL, 7 * 86_400_000);

const invalidCredentials = () => new CirrusError('INVALID_CREDENTIALS', 'Invalid user credentials.');

/**
 * Checked when the email matches no user, so a wrong email costs as much as a wrong password and
 * doesn't reveal which emails exist. The hash of a random, discarded password.
 */
const DUMMY_HASH = '$pbkdf2-sha256$i=100000$xcBKtObpW/UKEGMJrfHuUQ$27wayMP6IWfDxVvUZIkZrai/+5fIdxxDw7R4aj+N/X8';

function secret(env: Bindings): string {
  if (!env.SECRET) throw new CirrusError('SERVICE_UNAVAILABLE', 'Logging in is not configured on this server.');
  return env.SECRET;
}

type UserRow = { id: string; password: string | null; role: string | null; status: string };

export async function login(env: Bindings, email: string, password: string, client: ClientInfo): Promise<Tokens> {
  const key = secret(env);
  // The email column is COLLATE NOCASE: emails match ignoring case.
  const user = await env.DB.prepare('SELECT id, password, role, status FROM cirrus_users WHERE email = ?1').bind(email).first<UserRow>();
  const verified = await verifySecret(password, user?.password ?? DUMMY_HASH);
  if (!user || !user.password || !verified) throw invalidCredentials();
  // Checked after the password, so the status of an account isn't revealed without it.
  if (user.status === 'suspended') throw new CirrusError('USER_SUSPENDED', 'User suspended.');
  if (user.status !== 'active') throw invalidCredentials();

  const now = new Date();
  const refreshToken = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO cirrus_sessions (token, user, expires, ip, user_agent, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(
      await sha256Hex(refreshToken),
      user.id,
      new Date(now.getTime() + refreshTokenTtl(env)).toISOString(),
      client.ip,
      client.userAgent,
      client.origin,
    ),
    env.DB.prepare('UPDATE cirrus_users SET last_access = ?2 WHERE id = ?1').bind(user.id, now.toISOString()),
    // Opportunistic cleanup of the user's expired sessions.
    env.DB.prepare('DELETE FROM cirrus_sessions WHERE user = ?1 AND expires <= ?2').bind(user.id, now.toISOString()),
  ]);
  return { accessToken: await accessToken(env, key, user.id, user.role), refreshToken, expires: accessTokenTtl(env) };
}

/**
 * A new token pair for a refresh token. The session's token is replaced in one statement, so a
 * refresh token works once; an expired one, or one whose user is no longer active, is removed.
 */
export async function refresh(env: Bindings, refreshToken: string): Promise<Tokens> {
  const key = secret(env);
  const [current, next] = [await sha256Hex(refreshToken), randomToken()];
  const nextHash = await sha256Hex(next);
  const now = new Date();
  const [, , rotated] = await env.DB.batch<{ id: string; role: string | null }>([
    env.DB.prepare(
      `UPDATE cirrus_sessions SET token = ?2, expires = ?3
       WHERE token = ?1 AND expires > ?4 AND user IN (SELECT id FROM cirrus_users WHERE status = 'active')`,
    ).bind(current, nextHash, new Date(now.getTime() + refreshTokenTtl(env)).toISOString(), now.toISOString()),
    // Still there only when it couldn't be rotated.
    env.DB.prepare('DELETE FROM cirrus_sessions WHERE token = ?1').bind(current),
    env.DB.prepare('SELECT u.id, u.role FROM cirrus_sessions s JOIN cirrus_users u ON u.id = s.user WHERE s.token = ?1').bind(nextHash),
  ]);
  const user = rotated!.results[0];
  if (!user) throw invalidCredentials();
  return { accessToken: await accessToken(env, key, user.id, user.role), refreshToken: next, expires: accessTokenTtl(env) };
}

/** End the session of a refresh token; unknown tokens are ignored, as in Directus. */
export async function logout(env: Bindings, refreshToken: string): Promise<void> {
  await env.DB.prepare('DELETE FROM cirrus_sessions WHERE token = ?1').bind(await sha256Hex(refreshToken)).run();
}

/** Directus access token claims. admin_access/app_access are informational: each request recomputes them. */
async function accessToken(env: Bindings, key: string, user: string, role: string | null): Promise<string> {
  const a = accountabilityFor((await getSchema(env.DB)).access, { kind: 'user', user, role }, null);
  return signJwt({ id: user, role, app_access: a.app, admin_access: a.admin }, key, {
    expiresIn: Math.max(1, Math.round(accessTokenTtl(env) / 1000)),
    issuer: JWT_ISSUER,
  });
}
