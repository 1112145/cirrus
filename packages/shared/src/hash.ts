/**
 * Password-style hashing with PBKDF2-SHA256 through WebCrypto, which Workers have built in.
 * Stored in PHC string format: $pbkdf2-sha256$i=<iterations>$<salt>$<hash> (unpadded base64).
 * Used for `hash` fields (M2) and user passwords (M3).
 */

/** The most PBKDF2 iterations Workers' WebCrypto accepts. */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PHC_RE = /^\$pbkdf2-sha256\$i=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(secret, salt, ITERATIONS, HASH_BYTES);
  return `$pbkdf2-sha256$i=${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const m = PHC_RE.exec(stored);
  if (!m) return false;
  const iterations = Number(m[1]);
  if (iterations < 1 || iterations > ITERATIONS) return false;
  const expected = fromBase64(m[3]!);
  const actual = await derive(secret, fromBase64(m[2]!), iterations, expected.length);
  return constantTimeEqual(actual, expected);
}

async function derive(secret: string, salt: Uint8Array<ArrayBuffer>, iterations: number, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, bytes * 8);
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
