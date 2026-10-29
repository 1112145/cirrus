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
import type { Filter, PrimaryKey, Query, QueryCollection, QueryField, RowQuery } from './types.ts';

/**
 * Sanitized query + collection → SQL with bind parameters (spec §8.4). Identifiers only come from
 * the collection (and are quoted); every value is a bind parameter.
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
 */

export type Statement = { sql: string; params: DbValue[] };

/** D1 accepts at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100;

/** Numbered bind parameters (?1, ?2, …); equal values share a number. */
export class Params {
  readonly values: DbValue[] = [];
  readonly #numbers = new Map<string, number>();

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
}

const TRUE = '1';
const FALSE = '0';

function and(parts: string[]): string {
  const ps = parts.filter((p) => p !== TRUE);
  if (ps.includes(FALSE)) return FALSE;
  if (ps.length <= 1) return ps[0] ?? TRUE;
  return `(${ps.join(' AND ')})`;
}

/** An empty group matches everything: Directus (knex) drops empty `_or` groups. */
function or(parts: string[]): string {
  if (parts.length === 0) return TRUE;
  const ps = parts.filter((p) => p !== FALSE);
  if (ps.includes(TRUE)) return TRUE;
  if (ps.length <= 1) return ps[0] ?? FALSE;
  return `(${ps.join(' OR ')})`;
}

// Scope ------------------------------------------------------------------------------------------

/** What a statement may touch. Without `access`, everything (admins). */
export type Scope = {
  /** The request's permissions for this action. */
  access?: Access | null;
  /** Extra condition on rows, compiled without field checks: primary keys, a nested write's parent. */
  restrict?: Filter | null;
};

/** Compilation state: the collection, the statement's parameters, and the access its request filter is checked against. */
type Ctx = {
  c: QueryCollection;
  p: Params;
  /** null: no field checks (admins, and conditions coming from permissions themselves). */
  access: Access | null;
  /** The request's own filter, sort and search (false for conditions from permissions and `restrict`). */
  request: boolean;
  /** Compiled CASE expressions per field, shared by every reference in the statement. */
  cases: Map<string, string>;
};

const context = (c: QueryCollection, p: Params, scope: Scope): Ctx => ({ c, p, access: scope.access ?? null, request: true, cases: new Map() });
const unchecked = (x: Ctx): Ctx => (x.request ? { ...x, access: null, request: false } : x);

/** Requests may only test concealed fields for null. */
const CONCEALED_OPERATORS = new Set(['_null', '_nnull']);
const concealed = (c: QueryCollection, name: string) =>
  invalidQuery(`Field "${name}" in collection "${c.collection}" is concealed: it can only be filtered with "_null" or "_nnull"`);

const tableOf = (c: QueryCollection) => quoteIdent(c.table ?? c.collection);

// Fields -----------------------------------------------------------------------------------------

/** Directus' reason for fields that don't exist or aren't readable. */
const noField = (c: QueryCollection, path: string) =>
  forbidden(`You don't have permission to access field "${path}" in collection "${c.collection}" or it does not exist.`);

/** A field with a column: what filters and sorts can use. */
function column(c: QueryCollection, name: string, path = name): QueryField {
  const f = c.fields.find((x) => x.field === name);
  if (!f || f.type === 'alias') throw noField(c, path);
  return f;
}

/**
 * A column as the request may see it: the column itself, or `CASE WHEN <condition> THEN col END`
 * when its access grants the field only on some rows. Fields the access doesn't grant are FORBIDDEN.
 */
function ref(x: Ctx, name: string, path = name): { field: QueryField; sql: string } {
  const field = column(x.c, name, path);
  const col = quoteIdent(name);
  if (!x.access) return { field, sql: col };
  if (!x.access.fields.has(name)) throw noField(x.c, path);
  const condition = x.access.fields.get(name);
  if (!condition) return { field, sql: col };
  let sql = x.cases.get(name);
  if (sql === undefined) {
    sql = `(CASE WHEN ${compileFilter(unchecked(x), condition)} THEN ${col} END)`;
    x.cases.set(name, sql);
  }
  return { field, sql };
}

/**
 * The fields `fields` asks for, in request order. `*` is every column the access grants; alias
 * fields have no column and are skipped, as in Directus. Paths into relations (`author.name`)
 * arrive with M4.
 */
export function resolveFields(c: QueryCollection, requested: readonly string[], access: Access | null = null): QueryField[] {
  const granted = (f: QueryField) => !access || access.fields.has(f.field);
  const out = new Map<string, QueryField>();
  for (const path of requested) {
    const [head, ...rest] = path.split('.');
    if (head === '*') {
      if (rest.some((s) => s !== '*')) throw noField(c, path);
      for (const f of c.fields) if (f.type !== 'alias' && granted(f)) out.set(f.field, f);
      continue;
    }
    const f = c.fields.find((x) => x.field === head);
    if (!f || rest.length || !granted(f)) throw noField(c, path);
    if (f.type !== 'alias') out.set(f.field, f);
  }
  return [...out.values()];
}

/**
 * `-a,b` → a DESC, b ASC. Without a sort, Directus uses the collection's sort field, else the
 * primary key. The primary key is appended as a tiebreaker so pages never overlap. Requested sort
 * fields need access; the default sort and the tiebreaker only order rows, so they don't.
 */
function orderBy(x: Ctx, sort: readonly string[] | null): string {
  const { c } = x;
  const items: Array<{ field: string; sql: string; desc: boolean }> = [];
  if (sort) {
    for (const s of sort) {
      const desc = s.startsWith('-');
      const { field, sql } = ref(x, desc ? s.slice(1) : s);
      if (field.concealed) throw concealed(c, field.field);
      items.push({ field: field.field, sql, desc });
    }
  } else {
    const fallback = c.sortField && c.fields.some((f) => f.field === c.sortField && f.type !== 'alias') ? c.sortField : c.primary;
    items.push({ field: fallback, sql: quoteIdent(fallback), desc: false });
  }
  if (!items.some((i) => i.field === c.primary && i.sql === quoteIdent(c.primary))) {
    items.push({ field: column(c, c.primary).field, sql: quoteIdent(c.primary), desc: false });
  }
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
      throw invalidQuery(`"${op}" can only be used on relational fields`);
    default:
      throw invalidQuery(`"${op}" is not a valid filter operator`);
  }
}

function compileField(x: Ctx, name: string, value: unknown): string {
  const { field: f, sql } = ref(x, name);
  if (x.request && f.concealed && !(isPlainObject(value) && Object.keys(value).every((op) => CONCEALED_OPERATORS.has(op)))) {
    throw concealed(x.c, name);
  }
  // Shorthand: { field: value } is { field: { _eq: value } }.
  if (!isPlainObject(value)) return compileOperator(f, sql, '_eq', value, x.p);
  // Unlike Directus, which applies only the first, every operator in the object applies (AND).
  return and(
    Object.entries(value).map(([op, v]) => {
      // A nested key that isn't an operator is a path into a relation (M4).
      if (!op.startsWith('_')) throw noField(x.c, `${name}.${op}`);
      return compileOperator(f, sql, op, v, x.p);
    }),
  );
}

function compileFilter(x: Ctx, filter: Filter): string {
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
function scopeCondition(x: Ctx, scope: Scope): string {
  const raw = unchecked(x);
  return and([
    scope.restrict ? compileFilter(raw, scope.restrict) : TRUE,
    scope.access?.filter ? compileFilter(raw, scope.access.filter) : TRUE,
  ]);
}

/** Every condition on the rows a query selects: the scope's, then the request's filter and search. */
function queryCondition(x: Ctx, q: Pick<RowQuery, 'filter' | 'search'>, scope: Scope): string {
  return and([scopeCondition(x, scope), q.filter ? compileFilter(x, q.filter) : TRUE, q.search ? compileSearch(x, q.search) : TRUE]);
}

/** WHERE condition for a filter and a search term; null when nothing restricts the rows. */
export function compileWhere(c: QueryCollection, filter: Filter | null, search: string | null, p: Params, scope: Scope = {}): string | null {
  const condition = queryCondition(context(c, p, scope), { filter, search }, scope);
  return condition === TRUE ? null : condition;
}

// Statements -------------------------------------------------------------------------------------

const where = (condition: string) => (condition === TRUE ? '' : ` WHERE ${condition}`);

function orderAndPage(x: Ctx, q: RowQuery): string {
  // SQLite needs a LIMIT before OFFSET; LIMIT -1 means none.
  const page = q.limit === -1 && q.offset === 0 ? '' : ` LIMIT ${x.p.add(q.limit)} OFFSET ${x.p.add(q.offset)}`;
  return ` ORDER BY ${orderBy(x, q.sort)}${page}`;
}

/** SELECT the requested columns of the rows the query matches. `fields` are what to put in each item. */
export function selectItems(
  c: QueryCollection,
  q: Pick<Query, 'fields'> & RowQuery,
  scope: Scope = {},
): Statement & { fields: QueryField[] } {
  const x = context(c, new Params(), scope);
  const fields = resolveFields(c, q.fields, x.access);
  const columns = fields.map((f) => {
    const { sql } = ref(x, f.field);
    return sql === quoteIdent(f.field) ? sql : `${sql} AS ${quoteIdent(f.field)}`;
  });
  // Only alias fields requested: still one column, so each row becomes an (empty) item.
  const cols = columns.length ? columns.join(', ') : quoteIdent(c.primary);
  const sql = `SELECT ${cols} FROM ${tableOf(c)}${where(queryCondition(x, q, scope))}${orderAndPage(x, q)}`;
  return { sql, params: x.p.values, fields };
}

/** Rows matching a filter and a search within the scope; both null counts every row of the scope. Read as `count`. */
export function countItems(c: QueryCollection, filter: Filter | null, search: string | null, scope: Scope = {}): Statement {
  const x = context(c, new Params(), scope);
  const sql = `SELECT count(*) AS "count" FROM ${tableOf(c)}${where(queryCondition(x, { filter, search }, scope))}`;
  return { sql, params: x.p.values };
}

/** Which rows a write applies to: one key, a list of keys, or what a query selects. */
export type Target = { key: PrimaryKey } | { keys: readonly PrimaryKey[] } | { query: RowQuery };

/** The target rows within the scope. A query's own filter is checked against the scope's access. */
function targetCondition(x: Ctx, target: Target, scope: Scope): string {
  const { c, p } = x;
  const pk = quoteIdent(c.primary);
  if ('query' in target) {
    // Directus updates/deletes by query select the keys first, honoring sort, limit and offset.
    const q = target.query;
    return `${pk} IN (SELECT ${pk} FROM ${tableOf(c)}${where(queryCondition(x, q, scope))}${orderAndPage(x, q)})`;
  }
  const keys = 'key' in target ? `${pk} = ${p.add(target.key)}` : `${pk} IN (SELECT value FROM json_each(${p.add(JSON.stringify(target.keys))}))`;
  return and([keys, scopeCondition(x, scope)]);
}

const returning = (c: QueryCollection) => ` RETURNING ${quoteIdent(c.primary)}`;

/** Primary keys of the target rows that exist (within the scope). */
export function selectKeys(c: QueryCollection, target: Target, scope: Scope = {}): Statement {
  const x = context(c, new Params(), scope);
  const sql = `SELECT ${quoteIdent(c.primary)} FROM ${tableOf(c)} WHERE ${targetCondition(x, target, scope)}`;
  return { sql, params: x.p.values };
}

/** Column values for a write, in column order. Names must be columns of the collection. */
export type Row = Record<string, DbValue>;

function assertColumns(c: QueryCollection, row: Row) {
  for (const name of Object.keys(row)) column(c, name);
}

/** UPDATE the target rows, returning the keys of the rows changed. `values` must not be empty. */
export function updateItems(c: QueryCollection, values: Row, target: Target, scope: Scope = {}): Statement {
  assertColumns(c, values);
  const x = context(c, new Params(), scope);
  const set = Object.entries(values)
    .map(([name, v]) => `${quoteIdent(name)} = ${x.p.add(v)}`)
    .join(', ');
  const sql = `UPDATE ${tableOf(c)} SET ${set} WHERE ${targetCondition(x, target, scope)}${returning(c)}`;
  return { sql, params: x.p.values };
}

/** DELETE the target rows, returning their keys. */
export function deleteItems(c: QueryCollection, target: Target, scope: Scope = {}): Statement {
  const x = context(c, new Params(), scope);
  const sql = `DELETE FROM ${tableOf(c)} WHERE ${targetCondition(x, target, scope)}${returning(c)}`;
  return { sql, params: x.p.values };
}

/** Table with a CHECK that always fails; guard statements insert into it to abort their batch. */
export const GUARD_TABLE = 'cirrus_guard';

/**
 * A statement that fails its batch unless every target row exists and meets `condition` (spec
 * §10). With keys, a key that is missing or whose row doesn't meet it fails; with a query, any
 * selected row that doesn't meet it fails. The failure is the CHECK constraint `cirrus_guard`.
 * D1 has no interactive transactions: put the guard before the writes it protects, in the same
 * batch, and they roll back with it. Returns null when there is nothing to check.
 */
export function guardItems(c: QueryCollection, target: Target, condition: Filter | null, scope: Scope = {}): Statement | null {
  const x = context(c, new Params(), scope);
  const met = condition ? compileFilter(unchecked(x), condition) : TRUE;
  let violation: string;
  if ('query' in target) {
    if (met === TRUE) return null;
    violation = `EXISTS (SELECT 1 FROM ${tableOf(c)} WHERE ${targetCondition(x, target, scope)} AND (${met}) IS NOT 1)`;
  } else {
    const keys = 'key' in target ? [target.key] : target.keys;
    if (keys.length === 0) return null;
    const distinct = new Set(keys.map((k) => `${typeof k}:${k}`)).size;
    violation = `(SELECT count(*) FROM ${tableOf(c)} WHERE ${and([targetCondition(x, target, scope), met])}) != ${x.p.add(distinct)}`;
  }
  return { sql: `INSERT INTO ${quoteIdent(GUARD_TABLE)} ("ok") SELECT 0 WHERE ${violation}`, params: x.p.values };
}

/** Bound strings are capped at 2 MB by D1; keep each JSON batch of rows well below that. */
const MAX_JSON_CHARS = 512 * 1024;

/**
 * INSERT rows, returning their keys. Rows travel as one JSON array per statement and are read
 * back with json_each(), so any number of rows and columns stays within D1's parameter limit.
 * Consecutive rows that set the same columns share a statement; columns a row leaves out get
 * their defaults.
 */
export function insertItems(c: QueryCollection, rows: readonly Row[]): Statement[] {
  const table = tableOf(c);
  const statements: Statement[] = [];
  let group: { names: string[]; values: DbValue[][]; chars: number } | null = null;

  const flush = () => {
    if (!group) return;
    const cols = group.names.map(quoteIdent).join(', ');
    const extract = group.names.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ');
    statements.push({
      sql: `INSERT INTO ${table} (${cols}) SELECT ${extract} FROM json_each(?1)${returning(c)}`,
      params: [JSON.stringify(group.values)],
    });
    group = null;
  };

  for (const row of rows) {
    assertColumns(c, row);
    const names = Object.keys(row);
    if (names.length === 0) {
      flush();
      statements.push({ sql: `INSERT INTO ${table} DEFAULT VALUES${returning(c)}`, params: [] });
      continue;
    }
    const values = Object.values(row);
    // +1 for the comma that joins it to the previous row
    const chars = JSON.stringify(values).length + 1;
    const g = group as { names: string[]; values: DbValue[][]; chars: number } | null;
    if (g && (g.names.join() !== names.join() || g.chars + chars > MAX_JSON_CHARS)) flush();
    // 1 for the brackets around the array, less the first row's comma
    group ??= { names, values: [], chars: 1 };
    group.values.push(values);
    group.chars += chars;
  }
  flush();
  return statements;
}
