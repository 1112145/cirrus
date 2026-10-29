/**
 * HS256 JSON Web Tokens through WebCrypto, used for access tokens (spec §10). Only HS256 is
 * accepted, so a token can't pick a weaker algorithm (or "none") for itself.
 */

export type JwtPayload = Record<string, unknown> & { iat?: number; exp?: number; iss?: string };

/** Why a token was rejected: Directus answers INVALID_TOKEN or TOKEN_EXPIRED. */
export class JwtError extends Error {
  constructor(readonly reason: 'invalid' | 'expired') {
    super(reason === 'expired' ? 'Token expired.' : 'Invalid token.');
    this.name = 'JwtError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

/** The HMAC key for a secret; the secret rarely changes, so the last one is kept. */
function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new JwtError('invalid');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const HEADER = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export type SignOptions = { expiresIn: number; issuer: string; now?: number };

/** Sign `payload`, adding `iat`, `exp` (seconds since the epoch) and `iss`. `expiresIn` is in seconds. */
export async function signJwt(payload: Record<string, unknown>, secret: string, opts: SignOptions): Promise<string> {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const body = base64UrlEncode(encoder.encode(JSON.stringify({ ...payload, iat, exp: iat + opts.expiresIn, iss: opts.issuer })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${HEADER}.${body}`));
  return `${HEADER}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function decodePart(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(base64UrlDecode(part)));
  } catch {
    throw new JwtError('invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JwtError('invalid');
  return value as Record<string, unknown>;
}

/** The payload of a well-formed JWT, without checking its signature; null when it isn't one. */
export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return decodePart(parts[1]!);
  } catch {
    return null;
  }
}

/**
 * Check the signature (HS256 only), the issuer and the expiry (unless `ignoreExpiration`), then
 * return the payload. Throws JwtError.
 */
export async function verifyJwt(
  token: string,
  secret: string,
  opts: { issuer: string; now?: number; ignoreExpiration?: boolean },
): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('invalid');
  const [header, body, signature] = parts as [string, string, string];

  const h = decodePart(header);
  if (h.alg !== 'HS256') throw new JwtError('invalid');
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), base64UrlDecode(signature), encoder.encode(`${header}.${body}`));
  if (!valid) throw new JwtError('invalid');

  const payload: JwtPayload = decodePart(body);
  if (payload.iss !== opts.issuer) throw new JwtError('invalid');
  if (typeof payload.exp !== 'number') throw new JwtError('invalid');
  if (!opts.ignoreExpiration && payload.exp * 1000 <= (opts.now ?? Date.now())) throw new JwtError('expired');
  return payload;
}
