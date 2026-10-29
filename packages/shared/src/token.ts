import { base64UrlEncode } from './jwt.ts';

/** A random, URL-safe token: refresh tokens, generated static tokens. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * SHA-256 as hex. Refresh and static tokens are stored only as this digest: they are long random
 * values, so a fast hash is enough, and a leaked database doesn't leak working tokens.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_557_600_000,
};

/**
 * A duration such as "15m", "7d" or "900000" (milliseconds), as Directus reads ACCESS_TOKEN_TTL
 * and REFRESH_TOKEN_TTL. Returns milliseconds, or `fallback` when the value is missing or invalid.
 */
export function parseDuration(value: string | undefined, fallback: number): number {
  const m = value === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?\s*$/.exec(value);
  if (!m) return fallback;
  const ms = Number(m[1]) * UNITS[m[2] ?? 'ms']!;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : fallback;
}
