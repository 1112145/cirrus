import type { Filter, QueryCollection } from './types.ts';

/**
 * Permissions → what one action may do on one collection (spec §10). Policies are additive: a
 * request may use the rows any of its permissions allows, and a field's value is visible on the
 * rows of the permissions that grant that field (Directus 11 compiles this to CASE WHEN; so does
 * compile.ts).
 */

/** One permission, as access checks need it. Filters and presets have their dynamic variables resolved. */
export type PermissionRule = {
  /** Fields it grants; '*' is all of them. null grants none, as in Directus. */
  fields: readonly string[] | null;
  /** Row-level filter (Directus `permissions`); null or {} is every row. */
  permissions: Filter | null;
  /** Filter a payload must satisfy; null or {} is none. */
  validation: Filter | null;
  /** Values for fields the payload leaves out. */
  presets: Record<string, unknown> | null;
};

/** What a request may do with one action on one collection. Admins have no Access: they may do everything. */
export type Access = {
  /** Rows it may use: the permissions' filters ORed; null is every row. Compiled without field checks. */
  filter: Filter | null;
  /**
   * Fields it may use, each with the condition under which its value is visible: null means on
   * every row of `filter`, otherwise only on rows that also match the condition.
   */
  fields: ReadonlyMap<string, Filter | null>;
  /** Some permission grants '*', so payload keys that aren't fields are allowed (and ignored, as in Directus). */
  allFields: boolean;
  /** Presets merged in permission order; later ones win. */
  presets: Record<string, unknown>;
  /** A payload must satisfy this: the permissions' validations ORed; null when one of them has none. */
  validation: Filter | null;
};

export const isEmptyFilter = (f: Filter | null | undefined): boolean => f == null || Object.keys(f).length === 0;

/** The OR of filters (never an empty `_or`, which matches everything). */
const anyOf = (filters: Filter[]): Filter => (filters.length === 1 ? filters[0]! : { _or: filters });

const grants = (rule: PermissionRule, field: string) => rule.fields?.includes('*') || rule.fields?.includes(field) || false;

/** Combine the permissions of one action on one collection. `rules` must not be empty. */
export function buildAccess(c: QueryCollection, rules: readonly PermissionRule[]): Access {
  if (rules.length === 0) throw new Error('buildAccess needs at least one permission');
  const unrestricted = (r: PermissionRule) => isEmptyFilter(r.permissions);

  const fields = new Map<string, Filter | null>();
  for (const f of c.fields) {
    const granting = rules.filter((r) => grants(r, f.field));
    if (granting.length === 0) continue;
    // Granted by every permission (so on every row the request sees), or by one without a row filter.
    const visibleEverywhere = granting.length === rules.length || granting.some(unrestricted);
    fields.set(f.field, visibleEverywhere ? null : anyOf(granting.map((r) => r.permissions!)));
  }

  return {
    filter: rules.some(unrestricted) ? null : anyOf(rules.map((r) => r.permissions!)),
    fields,
    allFields: rules.some((r) => r.fields?.includes('*')),
    presets: Object.assign({}, ...rules.map((r) => r.presets ?? {})),
    validation: rules.some((r) => isEmptyFilter(r.validation)) ? null : anyOf(rules.map((r) => r.validation!)),
  };
}

/**
 * The condition a row must meet for a write to these fields: the row filter, and for each field
 * the condition under which it is granted. null when nothing restricts the rows.
 */
export function writeCondition(access: Access, fields: Iterable<string>): Filter | null {
  const parts = new Map<string, Filter>();
  for (const f of [access.filter, ...[...fields].map((name) => access.fields.get(name) ?? null)]) {
    if (!isEmptyFilter(f)) parts.set(JSON.stringify(f), f!);
  }
  const list = [...parts.values()];
  return list.length === 0 ? null : list.length === 1 ? list[0]! : { _and: list };
}
