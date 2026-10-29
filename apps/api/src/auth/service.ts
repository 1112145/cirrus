import { CirrusError, parseDuration, randomToken, sha256Hex, signJwt, verifySecret } from '@cirrus/shared';
import type { Bindings } from '../env.ts';
import { JWT_ISSUER } from '../middleware/auth.ts';
import { accountabilityFor } from '../request.ts';
import { getSchema } from '../schema/store.ts';

/**
 * Email/password login with short-lived access tokens (HS256 JWTs) and refresh tokens kept in
 * cirrus_sessions, so they can be revoked (spec §10). Refresh tokens rotate on every use and are
 * stored only as their SHA-256. In `session` mode (the admin app), the access token lives in an
 * httpOnly cookie for SESSION_COOKIE_TTL and names its session, which every request checks; a
 * refresh extends the session instead of rotating it (ADR-027).
 */

export type Tokens = { accessToken: string; refreshToken: string; /** Access token lifetime in ms, as Directus reports it. */ expires: number };

export type ClientInfo = { ip: string | null; userAgent: string | null; origin: string | null };

export const accessTokenTtl = (env: Bindings) => parseDuration(env.ACCESS_TOKEN_TTL, 15 * 60_000);
export const refreshTokenTtl = (env: Bindings) => parseDuration(env.REFRESH_TOKEN_TTL, 7 * 86_400_000);
export const sessionTtl = (env: Bindings) => parseDuration(env.SESSION_COOKIE_TTL, 86_400_000);

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

/**
 * Log in. With `session`, the session lasts SESSION_COOKIE_TTL and the access token (as long) names
 * it, for the session cookie; otherwise the refresh token lasts REFRESH_TOKEN_TTL.
 */
export async function login(env: Bindings, email: string, password: string, client: ClientInfo, opts: { session?: boolean } = {}): Promise<Tokens> {
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
      new Date(now.getTime() + (opts.session ? sessionTtl(env) : refreshTokenTtl(env))).toISOString(),
      client.ip,
      client.userAgent,
      client.origin,
    ),
    env.DB.prepare('UPDATE cirrus_users SET last_access = ?2 WHERE id = ?1').bind(user.id, now.toISOString()),
    // Opportunistic cleanup of the user's expired sessions.
    env.DB.prepare('DELETE FROM cirrus_sessions WHERE user = ?1 AND expires <= ?2').bind(user.id, now.toISOString()),
  ]);
  if (opts.session) return { accessToken: await sessionToken(env, key, user.id, user.role, refreshToken), refreshToken, expires: sessionTtl(env) };
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

/**
 * Extend a `session` mode session by SESSION_COOKIE_TTL and sign a new session token for it. The
 * session keeps its token: it never leaves the httpOnly cookie, and keeping it lets several tabs
 * refresh at once (ADR-027). An expired session, or one whose user is no longer active, is removed.
 */
export async function refreshSession(env: Bindings, token: string): Promise<Tokens> {
  const key = secret(env);
  const hash = await sha256Hex(token);
  const now = new Date();
  const [extended] = await env.DB.batch<{ id: string; role: string | null }>([
    env.DB.prepare(
      `UPDATE cirrus_sessions SET expires = ?2
       WHERE token = ?1 AND expires > ?3 AND user IN (SELECT id FROM cirrus_users WHERE status = 'active')
       RETURNING (SELECT id FROM cirrus_users WHERE id = user) AS id, (SELECT role FROM cirrus_users WHERE id = user) AS role`,
    ).bind(hash, new Date(now.getTime() + sessionTtl(env)).toISOString(), now.toISOString()),
  ]);
  const user = extended!.results[0];
  if (!user) {
    await env.DB.prepare('DELETE FROM cirrus_sessions WHERE token = ?1').bind(hash).run();
    throw invalidCredentials();
  }
  return { accessToken: await sessionToken(env, key, user.id, user.role, token), refreshToken: token, expires: sessionTtl(env) };
}

/** Whether a session token's session is still open for this user (session tokens are checked on every request). */
export async function sessionIsOpen(env: Bindings, token: string, user: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS ok FROM cirrus_sessions WHERE token = ?1 AND user = ?2 AND expires > ?3')
    .bind(await sha256Hex(token), user, new Date().toISOString())
    .first();
  return row !== null;
}

/** End the session of a refresh token; unknown tokens are ignored, as in Directus. */
export async function logout(env: Bindings, refreshToken: string): Promise<void> {
  await env.DB.prepare('DELETE FROM cirrus_sessions WHERE token = ?1').bind(await sha256Hex(refreshToken)).run();
}

/** Directus access token claims. admin_access/app_access are informational: each request recomputes them. */
async function claims(env: Bindings, user: string, role: string | null) {
  const a = accountabilityFor((await getSchema(env.DB)).access, { kind: 'user', user, role }, null);
  return { id: user, role, app_access: a.app, admin_access: a.admin };
}

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

async function accessToken(env: Bindings, key: string, user: string, role: string | null): Promise<string> {
  return signJwt(await claims(env, user, role), key, { expiresIn: seconds(accessTokenTtl(env)), issuer: JWT_ISSUER });
}

/** The session cookie's token: an access token naming its session (Directus' `session` claim), lasting as long. */
async function sessionToken(env: Bindings, key: string, user: string, role: string | null, session: string): Promise<string> {
  return signJwt({ ...(await claims(env, user, role)), session }, key, { expiresIn: seconds(sessionTtl(env)), issuer: JWT_ISSUER });
}
