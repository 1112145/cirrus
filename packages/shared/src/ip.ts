/**
 * IP addresses and networks for policies' `ip_access` (spec §10): single addresses and CIDR
 * ranges, IPv4 and IPv6. IPv4-mapped IPv6 addresses (::ffff:1.2.3.4) match IPv4 networks.
 */

type Address = { v6: boolean; value: bigint };

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255 || (p.length > 1 && p.startsWith('0'))) return null;
    value = (value << 8n) | BigInt(p);
  }
  return value;
}

function parseV6(s: string): bigint | null {
  let text = s;
  // An embedded IPv4 tail (::ffff:1.2.3.4) is the last 32 bits.
  let tail: bigint | null = null;
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    tail = parseV4(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  let value = 0n;
  for (const g of [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail !== null) value = (value & ~0xffffffffn) | tail;
  return value;
}

const MAPPED_PREFIX = 0xffffn << 32n;

function parseAddress(raw: string): Address | null {
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!s.includes(':')) {
    const v4 = parseV4(s);
    return v4 === null ? null : { v6: false, value: v4 };
  }
  const v6 = parseV6(s);
  if (v6 === null) return null;
  // ::ffff:a.b.c.d is an IPv4 address.
  if (v6 >> 32n === 0xffffn) return { v6: false, value: v6 ^ MAPPED_PREFIX };
  return { v6: true, value: v6 };
}

type Network = Address & { prefix: number };

function parseNetwork(raw: string): Network | null {
  const [addr, bits, ...extra] = raw.trim().split('/');
  if (extra.length || addr === undefined) return null;
  const a = parseAddress(addr);
  if (!a) return null;
  const max = a.v6 ? 128 : 32;
  if (bits === undefined) return { ...a, prefix: max };
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return { ...a, prefix: Number(bits) };
}

/** An IP address or a CIDR range, as accepted in `ip_access`. */
export const isIpNetwork = (s: string) => parseNetwork(s) !== null;

/** Whether `ip` is in one of the networks. Invalid addresses and networks never match. */
export function ipInNetworks(ip: string, networks: readonly string[]): boolean {
  const a = parseAddress(ip);
  if (!a) return false;
  return networks.some((raw) => {
    const n = parseNetwork(raw);
    if (!n || n.v6 !== a.v6) return false;
    const shift = BigInt((n.v6 ? 128 : 32) - n.prefix);
    return a.value >> shift === n.value >> shift;
  });
}

/**
 * The address to count a client by: IPv4 addresses as they are (IPv4-mapped ones included), IPv6
 * ones as their /64, which a single client usually holds whole. null for anything else.
 */
export function clientNetwork(ip: string): string | null {
  const a = parseAddress(ip);
  if (!a) return null;
  if (!a.v6) return [24n, 16n, 8n, 0n].map((s) => String((a.value >> s) & 0xffn)).join('.');
  const groups = [112n, 96n, 80n, 64n].map((s) => ((a.value >> s) & 0xffffn).toString(16));
  return `${groups.join(':')}::/64`;
}
