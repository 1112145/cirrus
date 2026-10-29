import {
  asBoolean,
  asNumber,
  asText,
  type DbValue,
  isIntegerString,
  isNumberString,
  isTemporal,
  isUuidLike,
  normalizeTemporal,
  quoteIdent,
  ValueMismatch,
} from '@cirrus/schema';
import { forbidden, invalidQuery, isPlainObject } from '@cirrus/shared';
import type { Access } from './access.ts';
import type { Filter, QueryCollection, QueryField, QueryRelation, Related, RowQuery } from './types.ts';

/**
 * The SQL building blocks shared by compile.ts (statements) and read.ts (nested reads): bind
 * parameters, compilation contexts, filters, sorts and search (spec §8.4). Identifiers only come
 * from the collections (and are quoted); every value is a bind parameter.
 *
 * Two D1 limits shape the SQL (spec §8.5):
 * - at most 100 bound parameters per statement: parameters are numbered and equal values share one,
 *   and lists (_in, keys, inserted rows) travel as a single JSON array read with json_each();
 * - LIKE/GLOB patterns of at most 50 bytes: string operators use instr()/substr() instead.
 *
 * Permissions (spec §10) come in through a Scope: its row filter is ANDed into every statement, the
 * request's own filter, sort, search and fields may only use the fields it grants, and a field
 * granted only on some rows reads as `CASE WHEN <condition> THEN "field" END` (also in filters and
 * sorts, so hidden values can't be probed).
 *
 * Relational paths (spec §9) are subqueries correlated with the row they start from:
 * - an M2O reads like a LEFT JOIN: each column of the related item is a scalar subquery, so a
 *   missing item (or one the request may not read) reads as null;
 * - an O2M is `EXISTS` (`_some`, the default) or `NOT EXISTS` (`_none`) over the related items.
 * The related collection's read access applies inside them, so a relational filter can't reveal
 * items or values the request couldn't read directly.
 */

export type Statement = { sql: string; params: DbValue[] };

/** D1 accepts at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100;

/** Numbered bind parameters (?1, ?2, …); equal values share a number. Also hands out table aliases. */
export class Params {
  readonly values: DbValue[] = [];
  readonly #numbers = new Map<string, number>();
  #aliases = 0;

  add(value: DbValue): string {
    const key = value === null ? 'null' : `${typeof value}:${value}`;
    let n = this.#numbers.get(key);
    if (n === undefined) {
      if (this.values.length >= MAX_PARAMS) throw invalidQuery(`The query needs more than ${MAX_PARAMS} distinct values`);
      n = this.values.push(value);
      this.#numbers.set(key, n);
    }
    return `?${n}`;
  }

  /** A table alias unique within the statement. Collection names start with a letter, so it never names a table. */
  alias(): string {
    return quoteIdent(`_r${++this.#aliases}`);
  }
}

export const TRUE = '1';
export const FALSE = '0';

export function and(parts: string[]): string {
  const ps = parts.filter((p) => p !== TRUE);
  if (ps.includes(FALSE)) return FALSE;
  if (ps.length <= 1) return ps[0] ?? TRUE;
  return `(${ps.join(' AND ')})`;
}

/** An empty group matches everything: Directus (knex) drops empty `_or` groups. */
export function or(parts: string[]): string {
  if (parts.length === 0) return TRUE;
  const ps = parts.filter((p) => p !== FALSE);
  if (ps.includes(TRUE)) return TRUE;
  if (ps.length <= 1) return ps[0] ?? FALSE;
  return `(${ps.join(' OR ')})`;
}

export const where = (condition: string) => (condition === TRUE ? '' : ` WHERE ${condition}`);

// Scope ------------------------------------------------------------------------------------------

/** What a statement may touch. Without `access`, everything (admins). */
export type Scope = {
  /** The request's permissions for this action. */
  access?: Access | null;
  /** Extra condition on rows, compiled without field checks: primary keys, a nested write's parent. */
  restrict?: Filter | null;
  /** The collections relational paths lead to; without it, paths into relations are FORBIDDEN. */
  related?: Related | null;
};

/** Compilation state: one row of one collection, as some part of a statement sees it. */
export type Ctx = {
  c: QueryCollection;
  p: Params;
  /** null: no field checks (admins, and conditions coming from permissions themselves). */
  access: Access | null;
  /** The request's own filter, sort and search (false for conditions from permissions and `restrict`). */
  request: boolean;
  related: Related | null;
  /** A column of the row, as stored. Qualified, so subqueries can refer to it. */
  column: (name: string) => string;
  /**
   * Turns an expression over the row into one the enclosing SQL can use: the expression itself,
   * or, for the item an M2O points at, a scalar subquery reading it from that item.
   */
  wrap: (sql: string) => string;
  /** Path from the statement's collection to this row ('' or 'author.'), for errors. */
  prefix: string;
  /** Compiled CASE expressions per field, shared by every reference in the statement. */
  cases: Map<string, string>;
};

const identity = (sql: string) => sql;

export const tableOf = (c: QueryCollection) => quoteIdent(c.table ?? c.collection);

/** The context of a statement's own table. */
export function context(c: QueryCollection, p: Params, scope: Scope = {}): Ctx {
  const table = tableOf(c);
  return {
    c,
    p,
    access: scope.access ?? null,
    request: true,
    related: scope.related ?? null,
    column: (name) => `${table}.${quoteIdent(name)}`,
    wrap: identity,
    prefix: '',
    cases: new Map(),
  };
}

/** Another collection's row under an alias, inside a subquery of `x`. */
function aliased(x: Ctx, c: QueryCollection, alias: string, access: Access | null, prefix: string): Ctx {
  return { c, p: x.p, access, request: x.request, related: x.related, column: (n) => `${alias}.${quoteIdent(n)}`, wrap: identity, prefix, cases: new Map() };
}

/** Conditions from permissions and `restrict`: every field may be used, whatever the access grants. */
export const unchecked = (x: Ctx): Ctx => (x.request || x.access ? { ...x, access: null, request: false } : x);

/** Requests may only test concealed fields for null. */
const CONCEALED_OPERATORS = new Set(['_null', '_nnull']);
const concealed = (x: Ctx, name: string) =>
  invalidQuery(`Field "${x.prefix}${name}" in collection "${x.c.collection}" is concealed: it can only be filtered with "_null" or "_nnull"`);

// Fields -----------------------------------------------------------------------------------------

/** Directus' reason for fields that don't exist or aren't readable. */
export const noField = (c: QueryCollection, path: string) =>
  forbidden(`You don't have permission to access field "${path}" in collection "${c.collection}" or it does not exist.`);

export const fieldOf = (c: QueryCollection, name: string) => c.fields.find((f) => f.field === name);

/** A field with a column: what filters and sorts can use. */
export function column(c: QueryCollection, name: string, path = name): QueryField {
  const f = fieldOf(c, name);
  if (!f || f.type === 'alias') throw noField(c, path);
  return f;
}

/**
 * A column as the request may see it: the column itself, or `CASE WHEN <condition> THEN col END`
 * when its access grants the field only on some rows. Fields the access doesn't grant are FORBIDDEN.
 */
export function ref(x: Ctx, name: string): { field: QueryField; sql: string } {
  const field = column(x.c, name, x.prefix + name);
  const col = x.column(name);
  if (!x.access) return { field, sql: x.wrap(col) };
  if (!x.access.fields.has(name)) throw noField(x.c, x.prefix + name);
  const condition = x.access.fields.get(name);
  if (!condition) return { field, sql: x.wrap(col) };
  let sql = x.cases.get(name);
  if (sql === undefined) {
    sql = x.wrap(`(CASE WHEN ${compileFilter(unchecked({ ...x, wrap: identity }), condition)} THEN ${col} END)`);
    x.cases.set(name, sql);
  }
  return { field, sql };
}

/** The primary key of the row, as stored: to correlate subqueries, never shown. */
export const rawKey = (x: Ctx) => x.wrap(x.column(x.c.primary));

/** Whether a field (an O2M alias, say) is visible on the row: null when everywhere, else a condition. */
export function visibility(x: Ctx, name: string): string | null {
  const condition = x.access?.fields.get(name);
  return condition ? x.wrap(compileFilter(unchecked({ ...x, wrap: identity }), condition)) : null;
}

type M2O = Extract<QueryRelation, { type: 'm2o' }>;
type O2M = Extract<QueryRelation, { type: 'o2m' }>;

/** The related collection and the request's read access to it (none for conditions from permissions). */
function relatedOf(x: Ctx, rel: QueryRelation, path: string): { c: QueryCollection; access: Access | null } {
  if (!x.related) throw noField(x.c, path);
  const c = x.related.collection(rel.collection);
  return { c, access: x.request ? x.related.readAccess(c.collection) : null };
}

/**
 * The item an M2O field points at, as a context whose columns read as scalar subqueries: no item,
 * or one outside the request's read access, reads as null (like Directus' LEFT JOIN).
 */
export function lookup(x: Ctx, f: QueryField, rel: M2O): Ctx {
  const fk = ref(x, f.field).sql;
  const { c, access } = relatedOf(x, rel, `${x.prefix}${f.field}`);
  const alias = x.p.alias();
  const inner = aliased(x, c, alias, access, `${x.prefix}${f.field}.`);
  const condition = and([`${inner.column(c.primary)} = ${fk}`, access?.filter ? compileFilter(unchecked(inner), access.filter) : TRUE]);
  const from = `${tableOf(c)} AS ${alias}`;
  return { ...inner, wrap: (sql) => `(SELECT ${sql} FROM ${from}${where(condition)})` };
}

/**
 * A path through M2O fields to a column (`author.company.name`), for sorts. Paths through O2M
 * fields would repeat rows, so they can't be sorted on.
 */
export function pathRef(x: Ctx, path: string): { ctx: Ctx; field: QueryField; sql: string } {
  const parts = path.split('.');
  let ctx = x;
  for (const [i, name] of parts.slice(0, -1).entries()) {
    const f = fieldOf(ctx.c, name);
    const rel = f?.relation;
    if (f && rel?.type === 'm2o') {
      ctx = lookup(ctx, f, rel);
    } else if (f && rel?.type === 'o2m') {
      throw invalidQuery(`Can't sort on "${path}": "${parts.slice(0, i + 1).join('.')}" is a one-to-many field`);
    } else {
      throw noField(ctx.c, ctx.prefix + parts.slice(i).join('.'));
    }
  }
  const { field, sql } = ref(ctx, parts[parts.length - 1]!);
  return { ctx, field, sql };
}

/**
 * `-a,b` → a DESC, b ASC; paths through M2O fields sort on the related item's value. Without a
 * sort, Directus uses `fallback` (the collection's sort field, else the primary key). The primary
 * key is appended as a tiebreaker so pages never overlap. Requested sort fields need access; the
 * default sort and the tiebreaker only order rows, so they don't.
 */
export function orderBy(x: Ctx, sort: readonly string[] | null): string {
  const { c } = x;
  const items: Array<{ sql: string; desc: boolean; key: boolean }> = [];
  if (sort) {
    for (const s of sort) {
      const desc = s.startsWith('-');
      const { ctx, field, sql } = pathRef(x, desc ? s.slice(1) : s);
      if (field.concealed) throw concealed(ctx, field.field);
      items.push({ sql, desc, key: ctx === x && sql === x.column(c.primary) });
    }
  } else {
    const fallback = c.sortField && c.fields.some((f) => f.field === c.sortField && f.type !== 'alias') ? c.sortField : c.primary;
    items.push({ sql: x.column(fallback), desc: false, key: fallback === c.primary });
  }
  if (!items.some((i) => i.key)) items.push({ sql: x.column(column(c, c.primary).field), desc: false, key: true });
  return items.map((i) => `${i.sql} ${i.desc ? 'DESC' : 'ASC'}`).join(', ');
}

// Filters ----------------------------------------------------------------------------------------

export type Primitive = string | number | boolean | Date | null;

/** Directus validateFilterPrimitive. */
export function primitive(op: string, v: unknown): Primitive {
  if (v === null || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) throw invalidQuery(`The filter value for "${op}" is not a valid number`);
    return v;
  }
  if (typeof v === 'string') {
    if (v.length === 0) throw invalidQuery(`You can't filter for an empty string in "${op}". Use "_empty" or "_nempty" instead`);
    return v;
  }
  throw invalidQuery(`The filter value for "${op}" has to be a string, number, or boolean`);
}

export function list(op: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw invalidQuery(`"${op}" has to be an array of values`);
  return v;
}

/** Directus validateBoolean: true/false; null and "" count as true. */
export function flag(op: string, v: unknown): boolean {
  if (v === null || v === '' || v === true) return true;
  if (v === false) return false;
  throw invalidQuery(`"${op}" has to be a boolean`);
}

/** A comparison value in the column's storage form, so `=` and `<` compare like with like. */
export function comparable(f: QueryField, v: Primitive): DbValue {
  if (v === null) return null;
  try {
    if (isTemporal(f.type)) return normalizeTemporal(f.type, v);
    switch (f.type) {
      case 'boolean':
        return asBoolean(v);
      case 'integer':
      case 'bigInteger':
      case 'float':
      case 'decimal':
        return asNumber(v);
      case 'uuid':
        return asText(v).toLowerCase();
      default:
        return asText(v);
    }
  } catch (e) {
    if (e instanceof ValueMismatch) throw invalidQuery(`The filter value for "${f.field}" must be ${e.expected}`);
    throw e;
  }
}

const text = (op: string, v: unknown) => asText(primitive(op, v) ?? 'null');

/** Characters as SQLite's length()/substr() count them (code points). */
const charLength = (s: string) => [...s].length;

/** `col` is the column as the request sees it (see ref()). */
function compileOperator(f: QueryField, col: string, op: string, value: unknown, p: Params): string {
  const cmp = (v: unknown) => p.add(comparable(f, primitive(op, v)));
  switch (op) {
    case '_eq':
      return value === null ? `${col} IS NULL` : `${col} = ${cmp(value)}`;
    case '_neq':
      return value === null ? `${col} IS NOT NULL` : `${col} != ${cmp(value)}`;
    case '_lt':
      return `${col} < ${cmp(value)}`;
    case '_lte':
      return `${col} <= ${cmp(value)}`;
    case '_gt':
      return `${col} > ${cmp(value)}`;
    case '_gte':
      return `${col} >= ${cmp(value)}`;
    case '_in':
    case '_nin': {
      const values = list(op, value).map((v) => comparable(f, primitive(op, v)));
      if (values.length === 0) return op === '_in' ? FALSE : TRUE;
      return `${col} ${op === '_in' ? 'IN' : 'NOT IN'} (SELECT value FROM json_each(${p.add(JSON.stringify(values))}))`;
    }
    case '_between':
    case '_nbetween': {
      const values = list(op, value);
      if (values.length !== 2) throw invalidQuery(`"${op}" has to be an array of two values`);
      return `${col} ${op === '_between' ? 'BETWEEN' : 'NOT BETWEEN'} ${cmp(values[0])} AND ${cmp(values[1])}`;
    }
    case '_null':
    case '_nnull':
      return (op === '_null') === flag(op, value) ? `${col} IS NULL` : `${col} IS NOT NULL`;
    case '_empty':
    case '_nempty':
      return (op === '_empty') === flag(op, value) ? `(${col} IS NULL OR ${col} = '')` : `(${col} IS NOT NULL AND ${col} != '')`;
    // Case-sensitive like Directus on Postgres; SQLite's LIKE would ignore case.
    case '_contains':
      return `instr(${col}, ${p.add(text(op, value))}) > 0`;
    case '_ncontains':
      return `instr(${col}, ${p.add(text(op, value))}) = 0`;
    case '_starts_with':
      return `instr(${col}, ${p.add(text(op, value))}) = 1`;
    case '_nstarts_with':
      return `instr(${col}, ${p.add(text(op, value))}) != 1`;
    case '_ends_with':
    case '_nends_with': {
      const s = text(op, value);
      return `substr(${col}, ${p.add(-charLength(s))}) ${op === '_ends_with' ? '=' : '!='} ${p.add(s)}`;
    }
    // Case-insensitive: SQLite's lower() folds ASCII only, like its LIKE.
    case '_icontains':
      return `instr(lower(${col}), lower(${p.add(text(op, value))})) > 0`;
    case '_nicontains':
      return `instr(lower(${col}), lower(${p.add(text(op, value))})) = 0`;
    case '_istarts_with':
      return `instr(lower(${col}), lower(${p.add(text(op, value))})) = 1`;
    case '_nistarts_with':
      return `instr(lower(${col}), lower(${p.add(text(op, value))})) != 1`;
    case '_iends_with':
    case '_niends_with': {
      const s = text(op, value);
      return `lower(substr(${col}, ${p.add(-charLength(s))})) ${op === '_iends_with' ? '=' : '!='} lower(${p.add(s)})`;
    }
    case '_regex':
    case '_intersects':
    case '_nintersects':
    case '_intersects_bbox':
    case '_nintersects_bbox':
      throw invalidQuery(`"${op}" is not supported`);
    case '_some':
    case '_none':
      throw invalidQuery(`"${op}" can only be used on one-to-many fields`);
    default:
      throw invalidQuery(`"${op}" is not a valid filter operator`);
  }
}

function compileField(x: Ctx, name: string, value: unknown): string {
  const f = fieldOf(x.c, name);
  const rel = f?.relation;
  if (f && rel?.type === 'o2m') return compileO2M(x, f, rel, value);
  // { author: { name: … } }: a filter on the item the M2O points at; operators still apply to the key.
  if (f && rel?.type === 'm2o' && isPlainObject(value) && Object.keys(value).some((k) => !k.startsWith('_'))) {
    const entries = Object.entries(value);
    const ops = entries.filter(([k]) => k.startsWith('_'));
    const nested = Object.fromEntries(entries.filter(([k]) => !k.startsWith('_')));
    return and([ops.length ? compileField(x, name, Object.fromEntries(ops)) : TRUE, compileFilter(lookup(x, f, rel), nested)]);
  }

  const { field, sql } = ref(x, name);
  if (x.request && field.concealed && !(isPlainObject(value) && Object.keys(value).every((op) => CONCEALED_OPERATORS.has(op)))) {
    throw concealed(x, name);
  }
  // Shorthand: { field: value } is { field: { _eq: value } }.
  if (!isPlainObject(value)) return compileOperator(field, sql, '_eq', value, x.p);
  // Unlike Directus, which applies only the first, every operator in the object applies (AND).
  return and(
    Object.entries(value).map(([op, v]) => {
      // A nested key that isn't an operator is a path into a relation, which this field isn't.
      if (!op.startsWith('_')) throw noField(x.c, `${x.prefix}${name}.${op}`);
      return compileOperator(field, sql, op, v, x.p);
    }),
  );
}

/**
 * `{ comments: { _some: {…} } }`, `{ comments: { _none: {…} } }`, and `{ comments: {…} }` for
 * `_some`: whether some (or none) of the related items the request may read match.
 */
function compileO2M(x: Ctx, f: QueryField, rel: O2M, value: unknown): string {
  const path = `${x.prefix}${f.field}`;
  if (x.access && !x.access.fields.has(f.field)) throw noField(x.c, path);
  if (!isPlainObject(value)) throw invalidQuery(`"${path}" is a one-to-many field: filter its items with "_some" or "_none"`);
  const { c, access } = relatedOf(x, rel, path);
  const alias = x.p.alias();
  const inner = aliased(x, c, alias, access, `${path}.`);
  const link = and([`${inner.column(rel.field)} = ${rawKey(x)}`, access?.filter ? compileFilter(unchecked(inner), access.filter) : TRUE]);
  const exists = (filter: unknown, op: string) => {
    if (!isPlainObject(filter)) throw invalidQuery(`"${op}" has to be a filter object`);
    return `EXISTS (SELECT 1 FROM ${tableOf(c)} AS ${alias}${where(and([link, compileFilter(inner, filter)]))})`;
  };

  const parts: string[] = [];
  const implicit: Filter = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === '_some') parts.push(exists(v, key));
    else if (key === '_none') parts.push(`NOT ${exists(v, key)}`);
    else if (key.startsWith('_')) throw invalidQuery(`"${key}" can't be used on one-to-many field "${path}"`);
    else implicit[key] = v;
  }
  if (Object.keys(implicit).length) parts.push(exists(implicit, '_some'));
  // Where the request may not see the field, it has no related items to match.
  const visible = visibility(x, f.field);
  return and(visible ? [visible, ...parts] : parts);
}

export function compileFilter(x: Ctx, filter: Filter): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(value)) throw invalidQuery(`"${key}" has to be an array of filters`);
      const subs = value.map((f, i) => {
        if (!isPlainObject(f)) throw invalidQuery(`"${key}[${i}]" has to be a filter object`);
        return compileFilter(x, f);
      });
      parts.push(key === '_and' ? and(subs) : or(subs));
    } else if (key.startsWith('_')) {
      throw invalidQuery(`"${key}" has to be used on a field`);
    } else {
      parts.push(compileField(x, key, value));
    }
  }
  return and(parts);
}

/**
 * Directus search: string and text fields contain the term (ignoring case); numeric fields equal
 * it when it is a number; UUID fields equal it when it is a UUID. Fields with meta.searchable
 * false, and fields the access doesn't grant, are skipped. No matching field means no results.
 */
function compileSearch(x: Ctx, search: string): string {
  const { p } = x;
  const parts: string[] = [];
  for (const f of x.c.fields) {
    if (!f.searchable || f.concealed || f.type === 'alias' || (x.access && !x.access.fields.has(f.field))) continue;
    const col = () => ref(x, f.field).sql;
    if (f.type === 'string' || f.type === 'text') {
      parts.push(`instr(lower(${col()}), lower(${p.add(search)})) > 0`);
    } else if ((f.type === 'integer' || f.type === 'bigInteger') && isIntegerString(search)) {
      parts.push(`${col()} = ${p.add(Number(search))}`);
    } else if ((f.type === 'float' || f.type === 'decimal') && isNumberString(search)) {
      parts.push(`${col()} = ${p.add(Number(search))}`);
    } else if (f.type === 'uuid' && isUuidLike(search)) {
      parts.push(`${col()} = ${p.add(search.toLowerCase())}`);
    }
  }
  return parts.length ? or(parts) : FALSE;
}

/** The scope's own conditions: `restrict` and the access row filter, both without field checks. */
export function scopeCondition(x: Ctx, scope: Scope): string {
  const raw = unchecked(x);
  return and([
    scope.restrict ? compileFilter(raw, scope.restrict) : TRUE,
    scope.access?.filter ? compileFilter(raw, scope.access.filter) : TRUE,
  ]);
}

/** Every condition on the rows a query selects: the scope's, then the request's filter and search. */
export function queryCondition(x: Ctx, q: Pick<RowQuery, 'filter' | 'search'>, scope: Scope): string {
  return and([scopeCondition(x, scope), q.filter ? compileFilter(x, q.filter) : TRUE, q.search ? compileSearch(x, q.search) : TRUE]);
}

export function orderAndPage(x: Ctx, q: Pick<RowQuery, 'sort' | 'limit' | 'offset'>): string {
  // SQLite needs a LIMIT before OFFSET; LIMIT -1 means none.
  const page = q.limit === -1 && q.offset === 0 ? '' : ` LIMIT ${x.p.add(q.limit)} OFFSET ${x.p.add(q.offset)}`;
  return ` ORDER BY ${orderBy(x, q.sort)}${page}`;
}
