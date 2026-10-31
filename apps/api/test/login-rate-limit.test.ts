import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, createUser, errorOf } from './helpers.ts';

/** Defaults (wrangler.example.jsonc): per 15 minutes, 10 failed logins per IP and email, 30 per IP, 100 per email. */

const PASSWORD = 'correct horse battery staple';

const attempt = (email: string, password: string, ip: string | null) =>
  call('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
    body: JSON.stringify({ email, password, mode: 'json' }),
  });

const fail = async (email: string, ip: string | null, times: number) => {
  for (let i = 0; i < times; i++) expect((await attempt(email, 'wrong', ip)).status).toBe(401);
};

describe('login rate limiting', () => {
  it('refuses an IP and email pair after 10 failed logins, even with the right password', async () => {
    await createUser({ email: 'limit-pair@example.com', password: PASSWORD });
    await fail('limit-pair@example.com', '198.51.100.1', 10);

    const res = await attempt('limit-pair@example.com', PASSWORD, '198.51.100.1');
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: 'REQUESTS_EXCEEDED', limit: 10 });
    expect(Date.parse((error as Record<string, unknown>).reset as string)).toBeGreaterThan(Date.now());

    // The same user, from elsewhere, is not locked out; nor is another email from the first IP.
    expect((await attempt('limit-pair@example.com', PASSWORD, '198.51.100.2')).status).toBe(200);
    await createUser({ email: 'limit-pair2@example.com', password: PASSWORD });
    expect((await attempt('limit-pair2@example.com', PASSWORD, '198.51.100.1')).status).toBe(200);
  });

  it('counts only failed logins: a successful one starts the pair over', async () => {
    await createUser({ email: 'limit-reset@example.com', password: PASSWORD });
    await fail('limit-reset@example.com', '198.51.100.3', 9);
    expect((await attempt('limit-reset@example.com', PASSWORD, '198.51.100.3')).status).toBe(200);
    await fail('limit-reset@example.com', '198.51.100.3', 9);
    expect((await attempt('limit-reset@example.com', PASSWORD, '198.51.100.3')).status).toBe(200);

    const rows = await env.DB.prepare("SELECT id, attempts FROM cirrus_login_attempts WHERE id LIKE '%198.51.100.3%' ORDER BY id").all();
    expect(rows.results).toEqual([{ id: 'ip:198.51.100.3', attempts: 18 }]);
  });

  it('refuses an IP after 30 failed logins, whatever the email', async () => {
    for (let i = 0; i < 3; i++) await fail(`limit-ip-${i}@example.com`, '198.51.100.4', 10);
    await createUser({ email: 'limit-ip@example.com', password: PASSWORD });
    expect(await errorOf(await attempt('limit-ip@example.com', PASSWORD, '198.51.100.4'))).toMatchObject({ status: 429, code: 'REQUESTS_EXCEEDED', limit: 30 });
  });

  it('refuses an email after 100 failed logins from anywhere, and requests without a client IP count there', async () => {
    await createUser({ email: 'limit-email@example.com', password: PASSWORD });
    await env.DB.prepare('INSERT INTO cirrus_login_attempts (id, attempts, reset_at) VALUES (?1, 99, ?2)')
      .bind('email:limit-email@example.com', Date.now() + 600_000)
      .run();
    // Emails count ignoring case.
    expect((await attempt('Limit-Email@example.com', 'wrong', null)).status).toBe(401);
    expect(await errorOf(await attempt('limit-email@example.com', PASSWORD, '198.51.100.5'))).toMatchObject({ status: 429, limit: 100 });
  });

  it('holds under concurrent guesses', async () => {
    const statuses = await Promise.all(Array.from({ length: 16 }, () => attempt('limit-race@example.com', 'wrong', '198.51.100.6').then((r) => r.status)));
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
  });

  it('counts IPv6 clients by their /64', async () => {
    for (let i = 0; i < 10; i++) expect((await attempt('limit-v6@example.com', 'wrong', `2001:db8:1:2::${i + 1}`)).status).toBe(401);
    expect(await errorOf(await attempt('limit-v6@example.com', 'wrong', '2001:db8:1:2:ffff::1'))).toMatchObject({ status: 429, limit: 10 });
    expect((await attempt('limit-v6@example.com', 'wrong', '2001:db8:1:3::1')).status).toBe(401);
  });

  it('starts over once the window has passed', async () => {
    await createUser({ email: 'limit-window@example.com', password: PASSWORD });
    await fail('limit-window@example.com', '198.51.100.7', 10);
    expect((await attempt('limit-window@example.com', PASSWORD, '198.51.100.7')).status).toBe(429);
    await env.DB.prepare("UPDATE cirrus_login_attempts SET reset_at = ?1 WHERE id LIKE '%198.51.100.7%'").bind(Date.now() - 1).run();
    expect((await attempt('limit-window@example.com', PASSWORD, '198.51.100.7')).status).toBe(200);
  });

  it('refuses before checking anything else', async () => {
    await fail('limit-unknown@example.com', '198.51.100.8', 10);
    // An unknown email gets the same answer as a known one.
    expect(await errorOf(await attempt('limit-unknown@example.com', 'wrong', '198.51.100.8'))).toMatchObject({ status: 429 });
  });
});
