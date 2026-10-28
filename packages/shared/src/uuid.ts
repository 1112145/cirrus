/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + version/variant + 74 random bits.
 * Time-ordered, so inserts stay compact in SQLite's B-tree (ADR-007).
 * Monotonic within the same millisecond: a 12-bit counter (rand_a) preserves ordering.
 */
let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  if (now === lastMs) {
    counter = (counter + 1) & 0x0fff;
    if (counter === 0) now = lastMs + 1; // counter overflow → borrow the next ms
  } else {
    counter = ((bytes[6] ?? 0) & 0x07) << 8 | (bytes[7] ?? 0); // random start, leaving headroom to increment
  }
  lastMs = now;

  // 48-bit timestamp, big-endian
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }

  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10xx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Extract the timestamp (ms) from a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
