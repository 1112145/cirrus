import { CirrusError, clientNetwork, parseDuration } from '@cirrus/shared';
import type { Bindings } from '../env.ts';

/**
 * Login rate limiting (ADR-029). Each login counts against up to three counters in
 * cirrus_login_attempts: the client IP and email together, the IP alone, and the email alone, each
 * with its own limit per LOGIN_RATE_LIMIT_DURATION. A login takes one attempt from each counter
 * before its password is checked, in one batch (D1 runs batches one at a time), so concurrent
 * guesses can't slip past the limit; a successful login gives them back. The counts are thus failed
 * logins, and a request over any limit is refused with REQUESTS_EXCEEDED before any hashing.
 *
 * The pair's limit is the low one: it stops guessing a password from one place without locking the
 * user out everywhere else. The IP's catches one client trying many emails, and the email's (high,
 * since anyone can spend it) many clients guessing one password.
 */

type Counter = { id: string; limit: number };

const limitOf = (v: string | undefined, fallback: number) => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const loginRateLimitDuration = (env: Bindings) => parseDuration(env.LOGIN_RATE_LIMIT_DURATION, 15 * 60_000);

/**
 * The counters a login counts against; a limit of 0 turns one off. IPv6 clients count by their /64.
 * Requests without a (valid) client IP only count against the email.
 */
function counters(env: Bindings, email: string, clientIp: string | null): Counter[] {
  const e = email.toLowerCase();
  const ip = clientIp ? clientNetwork(clientIp) : null;
  const all: Counter[] = [{ id: `email:${e}`, limit: limitOf(env.LOGIN_RATE_LIMIT_EMAIL, 100) }];
  if (ip) {
    all.unshift(
      { id: `ip-email:${ip} ${e}`, limit: limitOf(env.LOGIN_RATE_LIMIT_IP_EMAIL, 10) },
      { id: `ip:${ip}`, limit: limitOf(env.LOGIN_RATE_LIMIT_IP, 30) },
    );
  }
  return all.filter((c) => c.limit > 0);
}

/** Directus' HitRateLimitError: "Too many requests, retry after <duration>." with `limit` and `reset`. */
export class RequestsExceededError extends CirrusError {
  readonly retryAfter: number;

  constructor(limit: number, reset: number, now: number) {
    const seconds = Math.max(1, Math.ceil((reset - now) / 1000));
    super('REQUESTS_EXCEEDED', `Too many requests, retry after ${seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`}.`, {
      limit,
      reset: new Date(reset).toISOString(),
    });
    this.retryAfter = seconds;
  }
}

/** A login's reserved attempts, to give back once it succeeds. */
export type LoginAttempt = { release(db: D1Database): D1PreparedStatement[] };

/** Take one attempt from each of a login's counters, or refuse it when any is past its limit. */
export async function reserveLoginAttempt(env: Bindings, email: string, ip: string | null): Promise<LoginAttempt> {
  const list = counters(env, email, ip);
  if (list.length === 0) return { release: () => [] };
  const now = Date.now();
  const reset = now + loginRateLimitDuration(env);
  const results = await env.DB.batch<{ attempts: number; reset_at: number }>([
    // Windows that are over start again; this also keeps the table small.
    env.DB.prepare('DELETE FROM cirrus_login_attempts WHERE reset_at <= ?1').bind(now),
    ...list.map((c) =>
      env.DB.prepare(
        `INSERT INTO cirrus_login_attempts (id, attempts, reset_at) VALUES (?1, 1, ?2)
         ON CONFLICT (id) DO UPDATE SET attempts = attempts + 1
         RETURNING attempts, reset_at`,
      ).bind(c.id, reset),
    ),
  ]);
  // Over a limit: the attempt stays counted (it doesn't move the window); wait for the latest reset among them.
  let exceeded: { limit: number; reset: number } | null = null;
  for (const [i, c] of list.entries()) {
    const row = results[i + 1]!.results[0]!;
    if (row.attempts > c.limit && (!exceeded || row.reset_at > exceeded.reset)) exceeded = { limit: c.limit, reset: row.reset_at };
  }
  if (exceeded) throw new RequestsExceededError(exceeded.limit, exceeded.reset, now);
  return {
    // The IP and email pair starts over; the others get their attempt back.
    release: (db) =>
      list.map((c) =>
        c.id.startsWith('ip-email:')
          ? db.prepare('DELETE FROM cirrus_login_attempts WHERE id = ?1').bind(c.id)
          : db.prepare('UPDATE cirrus_login_attempts SET attempts = attempts - 1 WHERE id = ?1 AND attempts > 0').bind(c.id),
      ),
  };
}
