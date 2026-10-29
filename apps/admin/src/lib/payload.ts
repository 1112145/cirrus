/** Item edits: what a form changed, so updates send only that (as the Directus app does). */

export type Item = Record<string, unknown>;

/** Deep equality for JSON values. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => same(v, (b as unknown[])[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as Item)[k], (b as Item)[k]));
}

/** The edits that differ from the item as loaded. */
export function changes(original: Item, edits: Item): Item {
  return Object.fromEntries(Object.entries(edits).filter(([k, v]) => !same(original[k], v)));
}

/** The key of a related value: the key itself, or the `key` field of a loaded item. */
export function keyOf(value: unknown, key: string): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const k = (value as Item)[key];
    return typeof k === 'string' || typeof k === 'number' ? k : null;
  }
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** A value that counts as not filled in for a required field. */
export const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/**
 * The required fields (meta.required) a form leaves empty, as the Directus app checks them before
 * saving: the API only enforces non-nullable columns. When updating, fields the item was read
 * without (not readable) aren't checked.
 */
export function missingRequired(fields: ReadonlyArray<{ field: string; meta: { required: boolean } | null }>, values: Item, creating: boolean): string[] {
  return fields.filter((f) => f.meta?.required && (creating || Object.hasOwn(values, f.field)) && isEmpty(values[f.field])).map((f) => f.field);
}
