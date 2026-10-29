import { type DbValue, quoteIdent } from '@cirrus/schema';
import type { Access } from './access.ts';
import {
  and,
  column,
  context,
  type Ctx,
  noField,
  orderAndPage,
  Params,
  queryCondition,
  ref,
  type Scope,
  scopeCondition,
  type Statement,
  TRUE,
  tableOf,
  unchecked,
  where,
  compileFilter,
} from './sql.ts';
import { type Filter, isKeyRef, type KeyRef, type PrimaryKey, type Query, type QueryCollection, type QueryField, type Row, type RowQuery } from './types.ts';

/**
 * Sanitized query + collection → SQL statements with bind parameters (spec §8.4); the building
 * blocks (parameters, filters, sorts, permissions) are in sql.ts, nested reads in read.ts.
 */

export { comparable, flag, list, MAX_PARAMS, Params, primitive, type Primitive, type Scope, type Statement } from './sql.ts';

/** Table with CHECKs that always fail; guard statements insert into it to abort their batch (ADR-018). */
export const GUARD_TABLE = 'cirrus_guard';
/** The CHECK a guard fails for rows a request may not write (or that don't exist): FORBIDDEN. */
export const GUARD_CONSTRAINT = 'cirrus_guard';
/** The CHECK a guard fails for keys that don't reference an item, or items still referenced: INVALID_FOREIGN_KEY. */
export const FOREIGN_KEY_CONSTRAINT = 'cirrus_foreign_key';
/** Scratch table for keys a statement passes to later ones in the same batch (see stashKeys). */
export const KEYS_TABLE = 'cirrus_batch_keys';

// Reads ------------------------------------------------------------------------------------------

/**
 * The fields `fields` asks for, in request order. `*` is every column the access grants; alias
 * fields have no column and are skipped, as in Directus. Relational paths need read.ts (planRead).
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

/** WHERE condition for a filter and a search term; null when nothing restricts the rows. */
export function compileWhere(c: QueryCollection, filter: Filter | null, search: string | null, p: Params, scope: Scope = {}): string | null {
  const condition = queryCondition(context(c, p, scope), { filter, search }, scope);
  return condition === TRUE ? null : condition;
}

/** SELECT the requested columns of the rows the query matches (no relational fields). `fields` are what to put in each item. */
export function selectItems(
  c: QueryCollection,
  q: Pick<Query, 'fields'> & RowQuery,
  scope: Scope = {},
): Statement & { fields: QueryField[] } {
  const x = context(c, new Params(), scope);
  const fields = resolveFields(c, q.fields, x.access);
  const columns = fields.map((f) => `${ref(x, f.field).sql} AS ${quoteIdent(f.field)}`);
  // Only alias fields requested: still one column, so each row becomes an (empty) item.
  const cols = columns.length ? columns.join(', ') : x.column(c.primary);
  const sql = `SELECT ${cols} FROM ${tableOf(c)}${where(queryCondition(x, q, scope))}${orderAndPage(x, q)}`;
  return { sql, params: x.p.values, fields };
}

/** Rows matching a filter and a search within the scope; both null counts every row of the scope. Read as `count`. */
export function countItems(c: QueryCollection, filter: Filter | null, search: string | null, scope: Scope = {}): Statement {
  const x = context(c, new Params(), scope);
  const sql = `SELECT count(*) AS "count" FROM ${tableOf(c)}${where(queryCondition(x, { filter, search }, scope))}`;
  return { sql, params: x.p.values };
}

// Targets ----------------------------------------------------------------------------------------

/**
 * Which rows a write applies to: one key, a list of keys, what a query selects, the keys stashed
 * under a slot earlier in the batch (stashKeys), or the rows whose `field` holds one of those.
 */
export type Target =
  | { key: PrimaryKey }
  | { keys: readonly PrimaryKey[] }
  | { query: RowQuery }
  | { slot: number }
  | { refs: { field: string; slot: number } };

/** The keys stashed under a slot, as a subquery. */
const slotKeys = (p: Params, slot: number) => `(SELECT "value" FROM ${quoteIdent(KEYS_TABLE)} WHERE "slot" = ${p.add(slot)})`;

/** The target rows within the scope. A query's own filter is checked against the scope's access. */
function targetCondition(x: Ctx, target: Target, scope: Scope): string {
  const { c, p } = x;
  const pk = x.column(c.primary);
  if ('query' in target) {
    // Directus updates/deletes by query select the keys first, honoring sort, limit and offset.
    const q = target.query;
    return `${pk} IN (SELECT ${pk} FROM ${tableOf(c)}${where(queryCondition(x, q, scope))}${orderAndPage(x, q)})`;
  }
  let rows: string;
  if ('key' in target) rows = `${pk} = ${p.add(target.key)}`;
  else if ('keys' in target) rows = `${pk} IN (SELECT value FROM json_each(${p.add(JSON.stringify(target.keys))}))`;
  else if ('slot' in target) rows = `${pk} IN ${slotKeys(p, target.slot)}`;
  else rows = `${x.column(column(c, target.refs.field).field)} IN ${slotKeys(p, target.refs.slot)}`;
  return and([rows, scopeCondition(x, scope)]);
}

const returning = (c: QueryCollection) => ` RETURNING ${quoteIdent(c.primary)}`;

/** Primary keys of the target rows that exist (within the scope). */
export function selectKeys(c: QueryCollection, target: Target, scope: Scope = {}): Statement {
  const x = context(c, new Params(), scope);
  const sql = `SELECT ${x.column(c.primary)} AS ${quoteIdent(c.primary)} FROM ${tableOf(c)} WHERE ${targetCondition(x, target, scope)}`;
  return { sql, params: x.p.values };
}

// Writes -----------------------------------------------------------------------------------------

function assertColumns(c: QueryCollection, row: Row) {
  for (const name of Object.keys(row)) column(c, name);
}

/** A value to write: a bind parameter, or the key a slot holds. */
const valueSql = (p: Params, v: DbValue | KeyRef) => (isKeyRef(v) ? slotKeys(p, v.slot) : p.add(v));

/** UPDATE the target rows, returning the keys of the rows changed. `values` must not be empty. */
export function updateItems(c: QueryCollection, values: Row, target: Target, scope: Scope = {}): Statement {
  assertColumns(c, values);
  const x = context(c, new Params(), scope);
  const set = Object.entries(values)
    .map(([name, v]) => `${quoteIdent(name)} = ${valueSql(x.p, v)}`)
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

/** Bound strings are capped at 2 MB by D1; keep each JSON batch of rows well below that. */
const MAX_JSON_CHARS = 512 * 1024;

/**
 * INSERT rows, returning their keys. Rows travel as one JSON array per statement and are read
 * back with json_each(), so any number of rows and columns stays within D1's parameter limit.
 * Consecutive rows that set the same columns share a statement; columns a row leaves out get
 * their defaults. A row holding stashed keys (KeyRef) gets a statement of its own.
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
    if (Object.values(row).some(isKeyRef)) {
      flush();
      statements.push(insertWithKeys(c, row));
      continue;
    }
    const values = Object.values(row) as DbValue[];
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

/** One row whose stashed keys are read from the keys table; its other values still travel as JSON. */
function insertWithKeys(c: QueryCollection, row: Row): Statement {
  const p = new Params();
  const values = Object.values(row);
  const json = p.add(JSON.stringify([values.filter((v) => !isKeyRef(v))]));
  let i = 0;
  const exprs = values.map((v) => (isKeyRef(v) ? slotKeys(p, v.slot) : `json_extract(value, '$[${i++}]')`));
  const cols = Object.keys(row).map(quoteIdent).join(', ');
  return { sql: `INSERT INTO ${tableOf(c)} (${cols}) SELECT ${exprs.join(', ')} FROM json_each(${json})${returning(c)}`, params: p.values };
}

// Guards -----------------------------------------------------------------------------------------

const guard = (constraint: 'ok' | 'fk', violation: string, p: Params): Statement => ({
  sql: `INSERT INTO ${quoteIdent(GUARD_TABLE)} ("${constraint}") SELECT 0 WHERE ${violation}`,
  params: p.values,
});

/**
 * A statement that fails its batch unless every target row exists and meets `condition` (spec
 * §10). With keys, a key that is missing or whose row doesn't meet it fails; with other targets,
 * any selected row that doesn't meet it fails. The failure is the CHECK constraint `cirrus_guard`.
 * D1 has no interactive transactions: put the guard before the writes it protects, in the same
 * batch, and they roll back with it. Returns null when there is nothing to check.
 */
export function guardItems(c: QueryCollection, target: Target, condition: Filter | null, scope: Scope = {}): Statement | null {
  const x = context(c, new Params(), scope);
  const met = condition ? compileFilter(unchecked(x), condition) : TRUE;
  let violation: string;
  if ('key' in target || 'keys' in target) {
    const keys = 'key' in target ? [target.key] : target.keys;
    if (keys.length === 0) return null;
    const distinct = new Set(keys.map((k) => `${typeof k}:${k}`)).size;
    violation = `(SELECT count(*) FROM ${tableOf(c)} WHERE ${and([targetCondition(x, target, scope), met])}) != ${x.p.add(distinct)}`;
  } else {
    if (met === TRUE) return null;
    violation = `EXISTS (SELECT 1 FROM ${tableOf(c)} WHERE ${targetCondition(x, target, scope)} AND (${met}) IS NOT 1)`;
  }
  return guard('ok', violation, x.p);
}

/**
 * Keys an M2O sets must reference items of the related collection `c` (spec §9). Returns the
 * guard, which fails its batch with the CHECK `cirrus_foreign_key` when one doesn't, and a probe
 * returning a row in the same case, to tell after a failed batch which field it was.
 */
export function foreignKeyGuard(c: QueryCollection, keys: readonly PrimaryKey[]): { guard: Statement; probe: Statement } | null {
  if (keys.length === 0) return null;
  const p = new Params();
  const pk = context(c, p).column(c.primary);
  const distinct = new Set(keys.map((k) => `${typeof k}:${k}`)).size;
  const violation = `(SELECT count(*) FROM ${tableOf(c)} WHERE ${pk} IN (SELECT value FROM json_each(${p.add(JSON.stringify(keys))}))) != ${p.add(distinct)}`;
  return { guard: guard('fk', violation, p), probe: { sql: `SELECT 1 AS "missing" WHERE ${violation}`, params: p.values } };
}

/**
 * Fails its batch (CHECK `cirrus_foreign_key`) when rows of `c` still reference, through `field`,
 * one of the keys stashed under `slot`: on_delete RESTRICT and NO ACTION. With `others`, rows whose
 * own keys are in the slot don't count (a self-referencing collection deleting a whole subtree).
 */
export function referenceGuard(c: QueryCollection, field: string, slot: number, others = false): Statement {
  const x = context(c, new Params());
  const rows = and([
    `${x.column(column(c, field).field)} IN ${slotKeys(x.p, slot)}`,
    others ? `${x.column(c.primary)} NOT IN ${slotKeys(x.p, slot)}` : TRUE,
  ]);
  return guard('fk', `EXISTS (SELECT 1 FROM ${tableOf(c)} WHERE ${rows})`, x.p);
}

// Batch keys -------------------------------------------------------------------------------------

/**
 * Stash the keys of the target rows under `slot` (in KEYS_TABLE), so later statements in the
 * batch see the same rows whatever earlier ones change: a delete's on_delete actions, then the
 * delete itself. A batch that stashes keys must end with clearKeys().
 */
export function stashKeys(c: QueryCollection, target: Target, scope: Scope, slot: number): Statement {
  const x = context(c, new Params(), scope);
  const s = x.p.add(slot);
  const sql = `INSERT OR IGNORE INTO ${quoteIdent(KEYS_TABLE)} ("slot", "value") SELECT ${s}, ${x.column(c.primary)} FROM ${tableOf(c)} WHERE ${targetCondition(x, target, scope)}`;
  return { sql, params: x.p.values };
}

/**
 * Add to `slot` every row reaching one of its keys through the self-referencing `fields`, at any
 * depth (a subtree deleted with ON DELETE CASCADE).
 */
export function stashClosure(c: QueryCollection, slot: number, fields: readonly string[]): Statement {
  const p = new Params();
  const s = p.add(slot);
  const alias = p.alias();
  const pk = `${alias}.${quoteIdent(c.primary)}`;
  const join = fields.map((f) => `${alias}.${quoteIdent(column(c, f).field)} = "_t"."k"`).join(' OR ');
  const sql =
    `WITH RECURSIVE "_t"("k") AS (SELECT "value" FROM ${quoteIdent(KEYS_TABLE)} WHERE "slot" = ${s} ` +
    `UNION SELECT ${pk} FROM ${tableOf(c)} AS ${alias} JOIN "_t" ON ${join}) ` +
    `INSERT OR IGNORE INTO ${quoteIdent(KEYS_TABLE)} ("slot", "value") SELECT ${s}, "k" FROM "_t"`;
  return { sql, params: p.values };
}

/**
 * Stash under `slot` the key of the row the previous statement inserted into `c`, whose
 * auto-increment key it didn't know: SQLite's AUTOINCREMENT gives a new row the largest key yet.
 */
export function stashNewKey(c: QueryCollection, slot: number): Statement {
  const p = new Params();
  const sql = `INSERT INTO ${quoteIdent(KEYS_TABLE)} ("slot", "value") SELECT ${p.add(slot)}, max(${quoteIdent(c.primary)}) FROM ${tableOf(c)}`;
  return { sql, params: p.values };
}

/** Empty the keys table: the last statement of a batch that stashed keys. */
export const clearKeys = (): Statement => ({ sql: `DELETE FROM ${quoteIdent(KEYS_TABLE)}`, params: [] });
