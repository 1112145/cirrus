import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  CirrusError,
  CirrusErrors,
  decodeJwt,
  ipInNetworks,
  isIpNetwork,
  JwtError,
  parseDuration,
  randomToken,
  sha256Hex,
  signJwt,
  verifyJwt,
} from '../src/index.ts';

const SECRET = 'test-secret';
const ISS = 'directus';

const reason = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(JwtError);
  return (e as JwtError).reason;
};

describe('JWT', () => {
  it('signs and verifies HS256 tokens with iat, exp and iss', async () => {
    const now = Date.UTC(2026, 0, 1);
    const token = await signJwt({ id: 'u1', role: null }, SECRET, { expiresIn: 900, issuer: ISS, now });
    expect(token.split('.')).toHaveLength(3);
    const payload = await verifyJwt(token, SECRET, { issuer: ISS, now: now + 1000 });
    expect(payload).toEqual({ id: 'u1', role: null, iat: now / 1000, exp: now / 1000 + 900, iss: ISS });
    expect(decodeJwt(token)).toEqual(payload);
  });

  it('rejects expired tokens, other secrets, issuers and algorithms', async () => {
    const now = Date.UTC(2026, 0, 1);
    const token = await signJwt({ id: 'u1' }, SECRET, { expiresIn: 60, issuer: ISS, now });
    expect(await reason(verifyJwt(token, SECRET, { issuer: ISS, now: now + 60_000 }))).toBe('expired');
    expect(await reason(verifyJwt(token, 'other', { issuer: ISS, now }))).toBe('invalid');
    expect(await reason(verifyJwt(token, SECRET, { issuer: 'other', now }))).toBe('invalid');

    const [, body, signature] = token.split('.');
    const none = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })));
    expect(await reason(verifyJwt(`${none}.${body}.`, SECRET, { issuer: ISS, now }))).toBe('invalid');
    expect(await reason(verifyJwt(`${none}.${body}.${signature}`, SECRET, { issuer: ISS, now }))).toBe('invalid');

    // A changed payload doesn't match the signature.
    const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ id: 'admin', exp: 9e9, iss: ISS })));
    const [header] = token.split('.');
    expect(await reason(verifyJwt(`${header}.${forged}.${signature}`, SECRET, { issuer: ISS, now }))).toBe('invalid');
  });

  it('rejects malformed tokens', async () => {
    for (const t of ['', 'a.b', 'a.b.c.d', '!!.??.**', 'e30.e30.']) {
      expect(await reason(verifyJwt(t, SECRET, { issuer: ISS }))).toBe('invalid');
    }
    expect(decodeJwt('not a jwt')).toBeNull();
    expect(decodeJwt('a.b.c')).toBeNull();
  });

  it('base64url round-trips bytes', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const s = base64UrlEncode(bytes);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlDecode(s)).toEqual(bytes);
  });
});

describe('tokens', () => {
  it('randomToken is URL-safe and unique', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it('sha256Hex', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each([
    ['15m', 900_000],
    ['7d', 604_800_000],
    ['1h', 3_600_000],
    ['30s', 30_000],
    ['250ms', 250],
    ['900000', 900_000],
    [' 2 w ', 1_209_600_000],
  ])('parseDuration(%j) = %d', (v, ms) => {
    expect(parseDuration(v, 1)).toBe(ms);
  });

  it('parseDuration falls back on missing or invalid values', () => {
    for (const v of [undefined, '', 'soon', '-5m', '0', '1x']) expect(parseDuration(v, 42)).toBe(42);
  });
});

describe('IP networks', () => {
  it.each([
    ['127.0.0.1', ['127.0.0.1'], true],
    ['127.0.0.2', ['127.0.0.1'], false],
    ['10.1.2.3', ['10.0.0.0/8'], true],
    ['11.1.2.3', ['10.0.0.0/8'], false],
    ['192.168.1.200', ['192.168.1.128/25'], true],
    ['192.168.1.100', ['192.168.1.128/25'], false],
    ['1.2.3.4', ['0.0.0.0/0'], true],
    ['::1', ['::1'], true],
    ['2001:db8::1', ['2001:db8::/32'], true],
    ['2001:db9::1', ['2001:db8::/32'], false],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', ['2001:db8::1'], true],
    ['::ffff:10.0.0.1', ['10.0.0.0/8'], true],
    ['10.0.0.1', ['::ffff:10.0.0.0/104'], false],
    ['10.0.0.1', ['::/0'], false],
    ['fe80::1%eth0', ['fe80::/10'], true],
    ['not an ip', ['0.0.0.0/0'], false],
    ['1.2.3.4', ['garbage', '1.2.3.4/33'], false],
  ])('%s in %j → %s', (ip, networks, expected) => {
    expect(ipInNetworks(ip, networks)).toBe(expected);
  });

  it('validates networks', () => {
    for (const ok of ['1.2.3.4', '10.0.0.0/8', '::', '::1/128', '2001:db8::/32', '::ffff:1.2.3.4']) expect(isIpNetwork(ok)).toBe(true);
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.4/33', '::1/129', '1::2::3', 'g::1', '1.2.3.4/']) {
      expect(isIpNetwork(bad)).toBe(false);
    }
  });
});

describe('CirrusErrors', () => {
  it('serializes every error', () => {
    const e = new CirrusErrors([
      new CirrusError('FAILED_VALIDATION', 'a', { field: 'x' }),
      new CirrusError('FAILED_VALIDATION', 'b', { field: 'y' }),
    ]);
    expect(e.status).toBe(400);
    expect(e.toBody()).toEqual({
      errors: [
        { message: 'a', extensions: { field: 'x', code: 'FAILED_VALIDATION' } },
        { message: 'b', extensions: { field: 'y', code: 'FAILED_VALIDATION' } },
      ],
    });
  });
});
