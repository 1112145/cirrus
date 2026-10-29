import { invalidQuery } from '@cirrus/shared';

/**
 * Query-string entries → nested values, the way Express' default parser (qs) reads them for Directus:
 *   filter[status][_eq]=x   → { filter: { status: { _eq: 'x' } } }
 *   fields[]=a&fields[]=b   → { fields: ['a', 'b'] }
 *   filter[_or][0][a]=1     → { filter: { _or: [{ a: '1' }] } }
 *   fields=a&fields=b       → { fields: ['a', 'b'] }
 * Objects have no prototype, so keys such as "__proto__" are plain data.
 */

type Node = Record<string, unknown> | unknown[];

const MAX_DEPTH = 32;
const MAX_INDEX = 1000;

export function parseQueryString(entries: Iterable<[string, string]>): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) {
    const path = splitKey(key);
    if (path.length > MAX_DEPTH) throw invalidQuery(`Query parameter "${key}" is nested too deeply`);
    assign(root, path, value, key);
  }
  return compact(root) as Record<string, unknown>;
}

/** "a[b][]" → ["a", "b", ""]. Keys that aren't well-formed bracket paths are taken literally. */
function splitKey(key: string): string[] {
  const open = key.indexOf('[');
  if (open <= 0 || !key.endsWith(']')) return [key];
  const path = [key.slice(0, open)];
  for (let i = open; i < key.length; ) {
    const close = key.indexOf(']', i);
    const segment = key.slice(i + 1, close);
    if (key[i] !== '[' || close < 0 || segment.includes('[')) return [key];
    path.push(segment);
    i = close + 1;
  }
  return path;
}

const isIndex = (segment: string) => segment === '' || /^\d+$/.test(segment);
const container = (next: string): Node => (isIndex(next) ? [] : Object.create(null));

function assign(root: Record<string, unknown>, path: string[], value: string, key: string) {
  const conflict = () => invalidQuery(`Query parameter "${key}" conflicts with another parameter`);
  let node: Node = root;

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    const last = i === path.length - 1;

    if (Array.isArray(node)) {
      if (!isIndex(segment) || Number(segment) > MAX_INDEX) throw conflict();
      const index = segment === '' ? node.length : Number(segment);
      if (last) {
        if (node[index] !== undefined) throw conflict();
        node[index] = value;
      } else {
        node[index] ??= container(path[i + 1]!);
        if (typeof node[index] !== 'object') throw conflict();
        node = node[index] as Node;
      }
      continue;
    }

    if (segment === '') throw conflict();
    const existing = node[segment];
    if (last) {
      if (existing === undefined) node[segment] = value;
      else if (typeof existing === 'string') node[segment] = [existing, value];
      else if (Array.isArray(existing)) existing.push(value);
      else throw conflict();
    } else {
      if (existing === undefined) node[segment] = container(path[i + 1]!);
      else if (typeof existing !== 'object' || (Array.isArray(existing) && !isIndex(path[i + 1]!))) throw conflict();
      node = node[segment] as Node;
    }
  }
}

/** Drop the holes that indexed keys (a[0], a[5]) leave in arrays. */
function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(compact);
  if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = compact((v as Record<string, unknown>)[k]);
  }
  return v;
}
