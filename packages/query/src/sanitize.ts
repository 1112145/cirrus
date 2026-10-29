import { invalidQuery, isPlainObject } from '@cirrus/shared';
import type { Deep, DeepQuery, Filter, MetaKey, Query } from './types.ts';

/**
 * Raw Directus query parameters (from the query string or a SEARCH body) → a validated Query.
 * Mirrors Directus' sanitizeQuery/validateQuery; checks that need the schema happen in compile.ts.
 */

export type FilterVariables = {
  /** `$NOW`; one value per request. */
  now: Date;
  /** `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_ROLES`, `$CURRENT_POLICIES`; null / [] without a user. */
  user?: string | null;
  role?: string | null;
  roles?: readonly string[];
  policies?: readonly string[];
  /**
   * Field values for `$CURRENT_USER.<path>` and `$CURRENT_ROLE.<path>`, related items nested as in
   * a read (`{ role: { name } }`); missing fields resolve to null.
   */
  userRecord?: Readonly<Record<string, unknown>> | null;
  roleRecord?: Readonly<Record<string, unknown>> | null;
};

export type SanitizeOptions = {
  /** Rows returned when the request sets no limit (Directus QUERY_LIMIT_DEFAULT). */
  limitDefault: number;
  /** Largest allowed limit, -1 for none (Directus QUERY_LIMIT_MAX). With a maximum, limit=-1 means the maximum. */
  limitMax: number;
  /**
   * Most segments a path into relations may have, in `fields`, `sort`, `filter` and `deep`
   * (Directus MAX_RELATIONAL_DEPTH; at least 2). Default 10, as in Directus.
   */
  maxRelationalDepth?: number;
  variables: FilterVariables;
};

/** Directus MAX_RELATIONAL_DEPTH default. */
export const DEFAULT_RELATIONAL_DEPTH = 10;

/** Parameters that would change the response shape; refusing them beats silently ignoring them. */
const UNSUPPORTED = ['aggregate', 'groupBy', 'alias'];

export function sanitizeQuery(raw: Record<string, unknown>, opts: SanitizeOptions): Query {
  for (const key of UNSUPPORTED) {
    if (raw[key] !== undefined) throw invalidQuery(`"${key}" is not supported yet`);
  }
  const limit = sanitizeLimit(raw.limit, opts);
  const offset = sanitizeInteger(raw.offset, 'offset', 0) ?? 0;
  const page = sanitizeInteger(raw.page, 'page', 0);
  const q: Query = {
    fields: sanitizeList(raw.fields, 'fields') ?? ['*'],
    filter: sanitizeFilter(raw.filter, opts.variables),
    search: sanitizeSearch(raw.search),
    sort: sanitizeList(raw.sort, 'sort'),
    limit,
    // As in Directus, page wins over offset.
    offset: pageOffset(limit, page, offset),
    meta: sanitizeMeta(raw.meta),
    deep: sanitizeDeep(raw.deep, opts),
  };
  checkDepth(q, Math.max(2, opts.maxRelationalDepth ?? DEFAULT_RELATIONAL_DEPTH));
  return q;
}

const pageOffset = (limit: number, page: number | null, offset: number) => (page !== null && page > 1 && limit !== -1 ? limit * (page - 1) : offset);

/** "a,b" or ["a", "b,c"] → ["a", "b", "c"]; null when absent or empty. */
function sanitizeList(v: unknown, name: string): string[] | null {
  if (v === undefined || v === null) return null;
  const items = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(items) || !items.every((x) => typeof x === 'string')) {
    throw invalidQuery(`"${name}" must be a string or an array of strings`);
  }
  const list = items.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

function toInteger(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw invalidQuery(`"${name}" must be an integer`);
  return n;
}

function sanitizeInteger(v: unknown, name: string, min: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = toInteger(v, name);
  if (n < min) throw invalidQuery(`"${name}" must be greater than or equal to ${min}`);
  return n;
}

function sanitizeLimit(v: unknown, { limitDefault, limitMax }: SanitizeOptions): number {
  const max = limitMax < 0 ? Infinity : limitMax;
  const n = sanitizeInteger(v, 'limit', -1);
  if (n === null) return Math.min(limitDefault, max);
  if (n === -1) return Number.isFinite(max) ? max : -1;
  if (n > max) throw invalidQuery(`"limit" must be less than or equal to ${max}`);
  return n;
}

function sanitizeSearch(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw invalidQuery('"search" must be a string');
  return v;
}

function sanitizeMeta(v: unknown): MetaKey[] {
  const list = sanitizeList(v, 'meta') ?? [];
  const out = new Set<MetaKey>();
  for (const item of list) {
    if (item === '*') {
      out.add('total_count').add('filter_count');
    } else if (item === 'total_count' || item === 'filter_count') {
      out.add(item);
    } else {
      throw invalidQuery('"meta" must be "total_count", "filter_count" or "*"');
    }
  }
  return [...out];
}

// Deep -------------------------------------------------------------------------------------------

/** Query parameters a deep query may set, as in Directus (`_filter`, `_sort`, …). */
const DEEP_PARAMS = new Set(['_filter', '_search', '_sort', '_limit', '_offset', '_page']);

/**
 * Directus `deep`: `{ comments: { _limit: 5, _sort: '-date', author: { _filter: {…} } } }`, as JSON
 * or in bracket syntax. Keys starting with `_` are the query of the related items; the others are
 * their relational fields. Fields that aren't relational are ignored when the query is read.
 */
function sanitizeDeep(v: unknown, opts: SanitizeOptions): Deep | null {
  if (v === undefined || v === null || v === '') return null;
  let deep = v;
  if (typeof deep === 'string') {
    try {
      deep = JSON.parse(deep);
    } catch {
      throw invalidQuery('Invalid JSON for deep object');
    }
  }
  if (!isPlainObject(deep)) throw invalidQuery('"deep" has to be an object');
  return parseDeep(deep, opts, 'deep', 0);
}

function parseDeep(v: Record<string, unknown>, opts: SanitizeOptions, path: string, depth: number): Deep {
  if (depth > MAX_FILTER_DEPTH) throw invalidQuery('"deep" is nested too deeply');
  const out: Deep = Object.create(null);
  for (const [field, value] of Object.entries(v)) {
    if (field.startsWith('_')) throw invalidQuery(`"${path}.${field}" has to be nested in a relational field`);
    if (!isPlainObject(value)) throw invalidQuery(`"${path}.${field}" has to be an object`);
    out[field] = parseDeepQuery(value, opts, `${path}.${field}`, depth);
  }
  return out;
}

function parseDeepQuery(v: Record<string, unknown>, opts: SanitizeOptions, path: string, depth: number): DeepQuery {
  const params: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!key.startsWith('_')) nested[key] = value;
    else if (DEEP_PARAMS.has(key)) params[key.slice(1)] = value;
    else throw invalidQuery(`"${path}.${key}" is not supported`);
  }
  const limit = params.limit === undefined || params.limit === null || params.limit === '' ? null : sanitizeLimit(params.limit, opts);
  const offset = sanitizeInteger(params.offset, 'offset', 0) ?? 0;
  const page = sanitizeInteger(params.page, 'page', 0);
  return {
    filter: sanitizeFilter(params.filter, opts.variables),
    search: sanitizeSearch(params.search),
    sort: sanitizeList(params.sort, 'sort'),
    limit,
    offset: pageOffset(limit ?? opts.limitDefault, page, offset),
    deep: Object.keys(nested).length ? parseDeep(nested, opts, path, depth + 1) : null,
  };
}

// Relational depth -------------------------------------------------------------------------------

const tooDeep = () => invalidQuery('Max relational depth exceeded');

/** How many fields deep a filter goes: `{ author: { name: { _eq } } }` is 2. Operators and groups don't count. */
function filterDepth(v: unknown): number {
  if (Array.isArray(v)) return Math.max(0, ...v.map(filterDepth));
  if (!isPlainObject(v)) return 0;
  let depth = 0;
  for (const [key, x] of Object.entries(v)) depth = Math.max(depth, (key.startsWith('_') ? 0 : 1) + filterDepth(x));
  return depth;
}

/** Directus validateRelationalDepth: paths in fields, sort, filter and deep have at most `max` segments. */
function checkDepth(q: Query, max: number) {
  const segments = (path: string) => path.split('.').length;
  if ([...q.fields, ...(q.sort ?? [])].some((f) => segments(f) > max)) throw tooDeep();
  if (filterDepth(q.filter) > max) throw tooDeep();
  const walk = (deep: Deep | null, depth: number) => {
    for (const d of Object.values(deep ?? {})) {
      // `depth` fields lead to these related items, so their own fields are one more.
      if (depth >= max || depth + filterDepth(d.filter) > max) throw tooDeep();
      if ((d.sort ?? []).some((s) => depth + segments(s) > max)) throw tooDeep();
      walk(d.deep, depth + 1);
    }
  };
  walk(q.deep ?? null, 1);
}

// Filters (sanitize) -----------------------------------------------------------------------------

function sanitizeFilter(v: unknown, vars: FilterVariables): Filter | null {
  if (v === undefined || v === null || v === '') return null;
  let filter = v;
  if (typeof filter === 'string') {
    try {
      filter = JSON.parse(filter);
    } catch {
      throw invalidQuery('Invalid JSON for filter object');
    }
  }
  if (!isPlainObject(filter)) throw invalidQuery('Invalid filter object');
  return parseFilter(filter, vars);
}

// Filters ----------------------------------------------------------------------------------------

const LIST_OPERATORS = new Set(['_in', '_nin', '_between', '_nbetween']);
/** Deeper filters are refused rather than risking the call stack. */
const MAX_FILTER_DEPTH = 32;

/**
 * Directus parseFilter: resolve dynamic variables, read "true"/"false"/"null" from the query string
 * as values, and split comma-separated lists. Structure and types are checked in compile.ts.
 */
export function parseFilter(filter: Record<string, unknown>, vars: FilterVariables, depth = 0): Filter {
  if (depth > MAX_FILTER_DEPTH) throw invalidQuery('The filter is nested too deeply');
  const out: Filter = Object.create(null);
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(value)) throw invalidQuery(`"${key}" has to be an array of filters`);
      out[key] = value.map((f, i) => {
        if (!isPlainObject(f)) throw invalidQuery(`"${key}[${i}]" has to be a filter object`);
        return parseFilter(f, vars, depth + 1);
      });
    } else if (LIST_OPERATORS.has(key)) {
      const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [value];
      if (list.length === 0) throw invalidQuery(`"${key}" has to be an array of values`);
      out[key] = list.flatMap((x) => parseValue(x, vars));
    } else if (key.startsWith('_') || !isPlainObject(value)) {
      out[key] = parseValue(value, vars);
    } else {
      out[key] = parseFilter(value, vars, depth + 1);
    }
  }
  return out;
}

function parseValue(v: unknown, vars: FilterVariables): unknown {
  if (typeof v !== 'string') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === 'NULL') return null;
  return resolveVariable(v, vars);
}

/** Field paths of `$CURRENT_USER.<path>` / `$CURRENT_ROLE.<path>`; paths may go through relations (`role.name`). */
const RECORD_VARIABLE = /^\$CURRENT_(USER|ROLE)\.(.+)$/;

/** A dynamic variable's value; any other string is returned as is. */
export function resolveVariable(v: string, vars: FilterVariables): unknown {
  if (v.startsWith('$NOW')) return parseNow(v, vars.now);
  switch (v) {
    case '$CURRENT_USER':
      return vars.user ?? null;
    case '$CURRENT_ROLE':
      return vars.role ?? null;
    case '$CURRENT_ROLES':
      return [...(vars.roles ?? [])];
    case '$CURRENT_POLICIES':
      return [...(vars.policies ?? [])];
  }
  const m = RECORD_VARIABLE.exec(v);
  if (m) return pathValue(m[1] === 'USER' ? vars.userRecord : vars.roleRecord, m[2]!.split('.'));
  return v;
}

/**
 * A record's value at a path; missing fields are null. Through an O2M (a list of related items),
 * the values of every item, as one list: `$CURRENT_USER.policies.policy`.
 */
function pathValue(v: unknown, path: string[]): unknown {
  if (path.length === 0) return v ?? null;
  if (Array.isArray(v)) return v.flatMap((x) => pathValue(x, path));
  if (!isPlainObject(v) || !Object.hasOwn(v, path[0]!)) return null;
  return pathValue(v[path[0]!], path.slice(1));
}

/**
 * Which record fields `$CURRENT_USER.<field>` and `$CURRENT_ROLE.<field>` refer to anywhere in a
 * value (filters, presets), so the caller can load only what is needed.
 */
export function recordVariables(value: unknown, out = { user: new Set<string>(), role: new Set<string>() }) {
  if (typeof value === 'string') {
    const m = RECORD_VARIABLE.exec(value);
    if (m) out[m[1] === 'USER' ? 'user' : 'role'].add(m[2]!);
  } else if (Array.isArray(value)) {
    for (const v of value) recordVariables(v, out);
  } else if (isPlainObject(value)) {
    for (const v of Object.values(value)) recordVariables(v, out);
  }
  return out;
}

/** Permission presets with their dynamic variables resolved (Directus parsePreset); other values stay as they are. */
export function parsePresets(presets: Record<string, unknown>, vars: FilterVariables): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return resolveVariable(v, vars);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(presets) as Record<string, unknown>;
}

/** `$NOW` or `$NOW(<adjustment>)`, e.g. `$NOW(-1 year)`. */
function parseNow(v: string, now: Date): unknown {
  const m = /^\$NOW(?:\((.*)\))?$/.exec(v);
  if (!m) return v;
  const adjustment = m[1]?.trim();
  if (!adjustment) return new Date(now);
  const date = adjustDate(now, adjustment);
  if (!date) throw invalidQuery(`Invalid date adjustment "${adjustment}" in "${v}"`);
  return date;
}

const UNITS: Record<string, 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds'> = {
  years: 'years', year: 'years', y: 'years',
  months: 'months', month: 'months', M: 'months',
  weeks: 'weeks', week: 'weeks', w: 'weeks',
  days: 'days', day: 'days', d: 'days',
  hours: 'hours', hour: 'hours', h: 'hours',
  minutes: 'minutes', minute: 'minutes', mins: 'minutes', min: 'minutes', m: 'minutes',
  seconds: 'seconds', second: 'seconds', secs: 'seconds', sec: 'seconds', s: 'seconds',
};

const MS = { weeks: 604_800_000, days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000 };

/** Directus adjustDate: "+2 days", "-1 year", "3 hours". Months and years keep the day within the month. */
export function adjustDate(date: Date, adjustment: string): Date | null {
  const m = /^([+-])?\s*(\d+)\s*([a-zA-Z]+)$/.exec(adjustment.trim());
  const unit = m && UNITS[m[3]!];
  if (!m || !unit) return null;
  const amount = Number(m[2]) * (m[1] === '-' ? -1 : 1);

  if (unit === 'months' || unit === 'years') {
    const months = unit === 'years' ? amount * 12 : amount;
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    return d;
  }
  return new Date(date.getTime() + amount * MS[unit]);
}
