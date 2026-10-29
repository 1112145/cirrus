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
import type { Filter, PrimaryKey, Query, QueryCollection, QueryField, RowQuery } from './types.ts';

/**
 * Sanitized query + collection → SQL with bind parameters (spec §8.4). Identifiers only come from
 * the collection (and are quoted); every value is a bind parameter.
 *
 * Two D1 limits shape the SQL (spec §8.5):
 * - at most 100 bound parameters per statement: parameters are numbered and equal values share one,
 *   and lists (_in, keys, inserted rows) travel as a single JSON array read with json_each();
 * - LIKE/GLOB patterns of at most 50 bytes: string operators use instr()/substr() instead.
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

// Fields -----------------------------------------------------------------------------------------

/** Directus' reason for fields that don't exist (or, from M3, aren't readable). */
const noField = (c: QueryCollection, path: string) =>
  forbidden(`You don't have permission to access field "${path}" in collection "${c.collection}" or it does not exist.`);

/** A field with a column: what filters and sorts can use. */
function column(c: QueryCollection, name: string, path = name): QueryField {
  const f = c.fields.find((x) => x.field === name);
  if (!f || f.type === 'alias') throw noField(c, path);
  return f;
}

/**
 * The columns `fields` asks for, in request order. `*` is every column; alias fields have no column
 * and are skipped, as in Directus. Paths into relations (`author.name`) arrive with M4.
 */
export function resolveFields(c: QueryCollection, requested: readonly string[]): QueryField[] {
  const out = new Map<string, QueryField>();
  for (const path of requested) {
    const [head, ...rest] = path.split('.');
    if (head === '*') {
      if (rest.some((s) => s !== '*')) throw noField(c, path);
      for (const f of c.fields) if (f.type !== 'alias') out.set(f.field, f);
      continue;
    }
    const f = c.fields.find((x) => x.field === head);
    if (!f || rest.length) throw noField(c, path);
    if (f.type !== 'alias') out.set(f.field, f);
  }
  return [...out.values()];
}

export type SortItem = { field: QueryField; desc: boolean };

/**
 * `-a,b` → a DESC, b ASC. Without a sort, Directus uses the collection's sort field, else the
 * primary key. The primary key is appended as a tiebreaker so pages never overlap.
 */
export function resolveSort(c: QueryCollection, sort: readonly string[] | null): SortItem[] {
  const fallback = c.sortField && c.fields.some((f) => f.field === c.sortField && f.type !== 'alias') ? c.sortField : c.primary;
  const items = (sort ?? [fallback]).map((s) => {
    const desc = s.startsWith('-');
    return { field: column(c, desc ? s.slice(1) : s), desc };
  });
  if (!items.some((i) => i.field.field === c.primary)) items.push({ field: column(c, c.primary), desc: false });
  return items;
}

// Filters ----------------------------------------------------------------------------------------

type Primitive = string | number | boolean | Date | null;

/** Directus validateFilterPrimitive. */
function primitive(op: string, v: unknown): Primitive {
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

function list(op: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw invalidQuery(`"${op}" has to be an array of values`);
  return v;
}

/** Directus validateBoolean: true/false; null and "" count as true. */
function flag(op: string, v: unknown): boolean {
  if (v === null || v === '' || v === true) return true;
  if (v === false) return false;
  throw invalidQuery(`"${op}" has to be a boolean`);
}

/** A comparison value in the column's storage form, so `=` and `<` compare like with like. */
function comparable(f: QueryField, v: Primitive): DbValue {
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

function compileOperator(f: QueryField, op: string, value: unknown, p: Params): string {
  const col = quoteIdent(f.field);
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

function compileField(c: QueryCollection, name: string, value: unknown, p: Params): string {
  const f = column(c, name);
  // Shorthand: { field: value } is { field: { _eq: value } }.
  if (!isPlainObject(value)) return compileOperator(f, '_eq', value, p);
  // Unlike Directus, which applies only the first, every operator in the object applies (AND).
  return and(
    Object.entries(value).map(([op, v]) => {
      // A nested key that isn't an operator is a path into a relation (M4).
      if (!op.startsWith('_')) throw noField(c, `${name}.${op}`);
      return compileOperator(f, op, v, p);
    }),
  );
}

function compileFilter(c: QueryCollection, filter: Filter, p: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(value)) throw invalidQuery(`"${key}" has to be an array of filters`);
      const subs = value.map((f, i) => {
        if (!isPlainObject(f)) throw invalidQuery(`"${key}[${i}]" has to be a filter object`);
        return compileFilter(c, f, p);
      });
      parts.push(key === '_and' ? and(subs) : or(subs));
    } else if (key.startsWith('_')) {
      throw invalidQuery(`"${key}" has to be used on a field`);
    } else {
      parts.push(compileField(c, key, value, p));
    }
  }
  return and(parts);
}

/**
 * Directus search: string and text fields contain the term (ignoring case); numeric fields equal
 * it when it is a number; UUID fields equal it when it is a UUID. Fields with meta.searchable
 * false are skipped. No matching field means no results.
 */
function compileSearch(c: QueryCollection, search: string, p: Params): string {
  const parts: string[] = [];
  for (const f of c.fields) {
    if (!f.searchable) continue;
    const col = quoteIdent(f.field);
    if (f.type === 'string' || f.type === 'text') {
      parts.push(`instr(lower(${col}), lower(${p.add(search)})) > 0`);
    } else if ((f.type === 'integer' || f.type === 'bigInteger') && isIntegerString(search)) {
      parts.push(`${col} = ${p.add(Number(search))}`);
    } else if ((f.type === 'float' || f.type === 'decimal') && isNumberString(search)) {
      parts.push(`${col} = ${p.add(Number(search))}`);
    } else if (f.type === 'uuid' && isUuidLike(search)) {
      parts.push(`${col} = ${p.add(search.toLowerCase())}`);
    }
  }
  return parts.length ? or(parts) : FALSE;
}

/** WHERE condition for a filter and a search term; null when neither restricts anything. */
export function compileWhere(c: QueryCollection, filter: Filter | null, search: string | null, p: Params): string | null {
  const where = and([filter ? compileFilter(c, filter, p) : TRUE, search ? compileSearch(c, search, p) : TRUE]);
  return where === TRUE ? null : where;
}

// Statements -------------------------------------------------------------------------------------

const where = (condition: string | null) => (condition === null ? '' : ` WHERE ${condition}`);

function orderAndPage(c: QueryCollection, q: RowQuery, p: Params): string {
  const order = resolveSort(c, q.sort)
    .map((s) => `${quoteIdent(s.field.field)} ${s.desc ? 'DESC' : 'ASC'}`)
    .join(', ');
  // SQLite needs a LIMIT before OFFSET; LIMIT -1 means none.
  const page = q.limit === -1 && q.offset === 0 ? '' : ` LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`;
  return ` ORDER BY ${order}${page}`;
}

/** SELECT the requested columns of the rows the query matches. `fields` are what to put in each item. */
export function selectItems(c: QueryCollection, q: Pick<Query, 'fields'> & RowQuery): Statement & { fields: QueryField[] } {
  const p = new Params();
  const fields = resolveFields(c, q.fields);
  // Only alias fields requested: still one column, so each row becomes an (empty) item.
  const cols = (fields.length ? fields.map((f) => f.field) : [c.primary]).map(quoteIdent).join(', ');
  const condition = compileWhere(c, q.filter, q.search, p);
  const sql = `SELECT ${cols} FROM ${quoteIdent(c.collection)}${where(condition)}${orderAndPage(c, q, p)}`;
  return { sql, params: p.values, fields };
}

/** Rows matching a filter and a search; both null counts every row. Read as `count`. */
export function countItems(c: QueryCollection, filter: Filter | null, search: string | null): Statement {
  const p = new Params();
  const sql = `SELECT count(*) AS "count" FROM ${quoteIdent(c.collection)}${where(compileWhere(c, filter, search, p))}`;
  return { sql, params: p.values };
}

/** Which rows a write applies to: one key, a list of keys, or what a query selects. */
export type Target = { key: PrimaryKey } | { keys: readonly PrimaryKey[] } | { query: RowQuery };

function targetCondition(c: QueryCollection, target: Target, p: Params): string {
  const pk = quoteIdent(c.primary);
  if ('key' in target) return `${pk} = ${p.add(target.key)}`;
  if ('keys' in target) return `${pk} IN (SELECT value FROM json_each(${p.add(JSON.stringify(target.keys))}))`;
  const q = target.query;
  // Directus updates/deletes by query select the keys first, honoring sort, limit and offset.
  const sub = `SELECT ${pk} FROM ${quoteIdent(c.collection)}${where(compileWhere(c, q.filter, q.search, p))}${orderAndPage(c, q, p)}`;
  return `${pk} IN (${sub})`;
}

const returning = (c: QueryCollection) => ` RETURNING ${quoteIdent(c.primary)}`;

/** Primary keys of the target rows that exist. */
export function selectKeys(c: QueryCollection, target: Target): Statement {
  const p = new Params();
  const sql = `SELECT ${quoteIdent(c.primary)} FROM ${quoteIdent(c.collection)} WHERE ${targetCondition(c, target, p)}`;
  return { sql, params: p.values };
}

/** Column values for a write, in column order. Names must be columns of the collection. */
export type Row = Record<string, DbValue>;

function assertColumns(c: QueryCollection, row: Row) {
  for (const name of Object.keys(row)) column(c, name);
}

/** UPDATE the target rows, returning the keys of the rows changed. `values` must not be empty. */
export function updateItems(c: QueryCollection, values: Row, target: Target): Statement {
  assertColumns(c, values);
  const p = new Params();
  const set = Object.entries(values)
    .map(([name, v]) => `${quoteIdent(name)} = ${p.add(v)}`)
    .join(', ');
  const sql = `UPDATE ${quoteIdent(c.collection)} SET ${set} WHERE ${targetCondition(c, target, p)}${returning(c)}`;
  return { sql, params: p.values };
}

/** DELETE the target rows, returning their keys. */
export function deleteItems(c: QueryCollection, target: Target): Statement {
  const p = new Params();
  const sql = `DELETE FROM ${quoteIdent(c.collection)} WHERE ${targetCondition(c, target, p)}${returning(c)}`;
  return { sql, params: p.values };
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
  const table = quoteIdent(c.collection);
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
