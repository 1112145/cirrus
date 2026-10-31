/**
 * Differences between two JSON values in the format of the `deep-diff` package, which Directus
 * uses for schema diffs (`POST /schema/diff`): `N` new, `D` deleted, `E` edited, and `A` a change
 * to an array element (`index` and the element's own change in `item`). `path` leads to the
 * changed value and is left out for a change to the whole value.
 */

export type DiffEntry =
  | { kind: 'N'; path?: PathKey[]; rhs: unknown }
  | { kind: 'D'; path?: PathKey[]; lhs: unknown }
  | { kind: 'E'; path?: PathKey[]; lhs: unknown; rhs: unknown }
  | { kind: 'A'; path?: PathKey[]; index: number; item: DiffEntry };

type PathKey = string | number;

type Kind = 'array' | 'object' | 'null' | 'other';

const kindOf = (v: unknown): Kind => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : 'other');

const at = (path: PathKey[]) => (path.length ? { path } : {});

/** The changes that turn `lhs` into `rhs`; empty when they are equal. Element by element for arrays, as deep-diff reports them. */
export function deepDiff(lhs: unknown, rhs: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(lhs, rhs, [], out);
  return out;
}

function walk(lhs: unknown, rhs: unknown, path: PathKey[], out: DiffEntry[]) {
  if (lhs === undefined && rhs === undefined) return;
  if (lhs === undefined) return void out.push({ kind: 'N', ...at(path), rhs });
  if (rhs === undefined) return void out.push({ kind: 'D', ...at(path), lhs });
  const [l, r] = [kindOf(lhs), kindOf(rhs)];
  if (l !== r || l === 'null' || l === 'other') {
    if (l !== r || lhs !== rhs) out.push({ kind: 'E', ...at(path), lhs, rhs });
    return;
  }
  if (l === 'array') {
    const [a, b] = [lhs as unknown[], rhs as unknown[]];
    for (let i = 0; i < a.length; i++) {
      if (i >= b.length) out.push({ kind: 'A', ...at(path), index: i, item: { kind: 'D', lhs: a[i] } });
      else walk(a[i], b[i], [...path, i], out);
    }
    for (let i = a.length; i < b.length; i++) out.push({ kind: 'A', ...at(path), index: i, item: { kind: 'N', rhs: b[i] } });
    return;
  }
  const [a, b] = [lhs as Record<string, unknown>, rhs as Record<string, unknown>];
  for (const k of Object.keys(a)) {
    if (k in b) walk(a[k], b[k], [...path, k], out);
    else if (a[k] !== undefined) out.push({ kind: 'D', path: [...path, k], lhs: a[k] });
  }
  for (const k of Object.keys(b)) if (!(k in a) && b[k] !== undefined) out.push({ kind: 'N', path: [...path, k], rhs: b[k] });
}

const isContainer = (v: unknown): v is Record<PathKey, unknown> => typeof v === 'object' && v !== null;

/**
 * Apply one change inside `target` (an object or array), as deep-diff's applyChange; a change
 * without a path can't be applied in place, so callers handle those. Deleted array elements are
 * always the trailing ones (deepDiff only reports those), so they truncate the array, whichever
 * order they come in. Returns false when the path doesn't lead anywhere.
 */
export function applyDiffEntry(target: unknown, change: DiffEntry): boolean {
  const path = change.path ?? [];
  if (change.kind !== 'A' && path.length === 0) return false;
  let parent: unknown = target;
  const steps = change.kind === 'A' ? path : path.slice(0, -1);
  for (const key of steps) {
    if (!isContainer(parent)) return false;
    // Directus' deep-diff creates missing containers on the way.
    if (parent[key] === undefined) parent[key] = typeof key === 'number' ? [] : {};
    parent = parent[key];
  }
  if (!isContainer(parent)) return false;

  if (change.kind === 'A') {
    if (!Array.isArray(parent) || !Number.isInteger(change.index) || change.index < 0) return false;
    const { item } = change;
    if (item.kind === 'D') {
      if (parent.length > change.index) parent.length = change.index;
      return true;
    }
    if (item.kind === 'N' || item.kind === 'E') {
      parent[change.index] = item.rhs;
      return true;
    }
    return applyDiffEntry(parent, { ...item, path: [change.index, ...(item.path ?? [])] } as DiffEntry);
  }
  const key = path[path.length - 1]!;
  if (change.kind === 'D') {
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else delete parent[key];
  } else parent[key] = change.rhs;
  return true;
}

/** Whether `v` has the shape of a diff entry (checked before applying a diff from a request). */
export function isDiffEntry(v: unknown): v is DiffEntry {
  if (!isContainer(v) || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (e.path !== undefined && !(Array.isArray(e.path) && e.path.every((k) => typeof k === 'string' || Number.isInteger(k)))) return false;
  switch (e.kind) {
    case 'N':
      return 'rhs' in e;
    case 'D':
      return 'lhs' in e;
    case 'E':
      return 'lhs' in e && 'rhs' in e;
    case 'A':
      return Number.isInteger(e.index) && isDiffEntry(e.item);
    default:
      return false;
  }
}

/** A copy of a JSON value with object keys in alphabetical order, as Directus sorts snapshots (sortDeep). */
export function sortKeysDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeysDeep) as T;
  if (!isContainer(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeysDeep((v as Record<string, unknown>)[k])]),
  ) as T;
}
