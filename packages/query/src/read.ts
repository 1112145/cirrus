import { fromDbValue, quoteIdent } from '@cirrus/schema';
import { isCirrusError } from '@cirrus/shared';
import type { Access } from './access.ts';
import {
  and,
  compileFilter,
  context,
  type Ctx,
  fieldOf,
  noField,
  orderAndPage,
  orderBy,
  Params,
  queryCondition,
  rawKey,
  ref,
  type Scope,
  scopeCondition,
  type Statement,
  TRUE,
  tableOf,
  unchecked,
  visibility,
  where,
} from './sql.ts';
import type { Deep, DeepQuery, Query, QueryCollection, QueryField, QueryRelation, Related, RowQuery } from './types.ts';

/**
 * Reads with relational fields (spec §8.4, §9): `fields=title,author.name,comments.*` and `deep`.
 * Every relational field becomes one more statement, selecting the related items of the items the
 * statement before it returns; that parent selection is repeated as a subquery rather than passed
 * as keys, so all statements run in one D1 batch (one round trip, one consistent snapshot), and
 * related rows are merged in the app, so items are never repeated the way a JOIN would.
 *
 * - M2O (`author.name`): the items the parents' keys point at; null when there is none, or when
 *   the request may not read it.
 * - O2M (`comments.*`): the items pointing at the parents, at most `limit` per parent (default
 *   QUERY_LIMIT_DEFAULT, as in Directus), numbered with ROW_NUMBER() per parent.
 *   Without subfields (`comments`, and `*`), the related items' keys.
 * - M2M is an O2M to the junction collection, then its M2O (`tags.tags_id.name`).
 *
 * Each related collection is read with the request's read access to it: its row filter, its fields
 * (`*` expands to those), and its partially granted fields as CASE WHEN. Relational fields that
 * wildcards bring in are left out when the request may not read their collection; asking for one
 * explicitly is FORBIDDEN.
 */

export type Item = Record<string, unknown>;
export type Rows = ReadonlyArray<Record<string, unknown>>;

/** Turns a stored value into its API form (the default: fromDbValue). */
export type Present = (c: QueryCollection, f: QueryField, value: unknown) => unknown;

export type ReadOptions = {
  /** Related items an O2M field returns per item when its deep query sets no limit (Directus QUERY_LIMIT_DEFAULT). */
  limitDefault: number;
};

export type ReadPlan = {
  /** To run in one batch, in this order. */
  statements: Statement[];
  /** The columns the items get (relational fields aside), as `fields` asks for them. */
  fields: QueryField[];
  /** What each relational field of an item reads as when there is no item: null (M2O) or [] (O2M). */
  empty: Record<string, null | never[]>;
  /** The items, from the statements' results (same order). */
  assemble(results: readonly Rows[], present?: Present): Item[];
};

type Node = {
  c: QueryCollection;
  access: Access | null;
  /** Columns of the items, in request order. */
  columns: QueryField[];
  children: Child[];
};

type Child = {
  /** The parent's relational field, and the item key the related items go under. */
  field: QueryField;
  relation: QueryRelation;
  /** An O2M without subfields: the related items' keys. */
  keysOnly: boolean;
  node: Node;
  query: RowQuery;
};

type Request = { path: string; implicit: boolean };
type Env = { related: Related | null; limitDefault: number };

export function planRead(c: QueryCollection, q: Query, scope: Scope, opts: ReadOptions): ReadPlan {
  const env: Env = { related: scope.related ?? null, limitDefault: opts.limitDefault };
  const root = build(c, q.fields.map((path) => ({ path, implicit: false })), scope.access ?? null, q.deep ?? null, '', env);

  const statements: Statement[] = [];
  const index = new Map<Child, number>();
  const rootSource: Source = (p, columns, ordered) => {
    const x = context(c, p, scope);
    const cond = queryCondition(x, q, scope);
    const paged = q.limit !== -1 || q.offset !== 0;
    return `SELECT ${select(columns(x))} FROM ${tableOf(c)}${where(cond)}${ordered || paged ? orderAndPage(x, q) : ''}`;
  };
  const emit = (node: Node, source: Source, link: QueryRelation | null) => {
    const p = new Params();
    statements.push({ sql: source(p, nodeColumns(node, link), true), params: p.values });
    for (const child of node.children) {
      index.set(child, statements.length);
      emit(child.node, childSource(source, child, env), child.relation);
    }
  };
  emit(root, rootSource, null);

  return {
    statements,
    fields: root.columns,
    empty: Object.fromEntries(root.children.map((ch) => [ch.field.field, ch.relation.type === 'm2o' ? null : []])),
    assemble: (results, present = (_, f, v) => fromDbValue(f.type, v)) => materialize(root, results[0] ?? [], results, index, present),
  };
}

// Fields -----------------------------------------------------------------------------------------

/**
 * The tree of what `fields` asks for, following Directus' convertWildcards: `*` is every field the
 * access grants (O2M aliases included, as key lists), and `*.x` is `*` plus `x` of every relational
 * field. When a field is asked for both as a value and with subfields, the subfields win.
 */
function build(c: QueryCollection, requests: Request[], access: Access | null, deep: Deep | null, prefix: string, env: Env): Node {
  const granted = (f: QueryField) => !access || access.fields.has(f.field);
  const readable = (f: QueryField) => f.type !== 'alias' || f.relation?.type === 'o2m';
  const entries = new Map<string, { field: QueryField; plain: boolean; plainExplicit: boolean; sub: Request[] }>();
  const add = (f: QueryField, sub: Request | null, implicit: boolean) => {
    let e = entries.get(f.field);
    if (!e) entries.set(f.field, (e = { field: f, plain: false, plainExplicit: false, sub: [] }));
    if (sub) e.sub.push(sub);
    else {
      e.plain = true;
      e.plainExplicit ||= !implicit;
    }
  };

  for (const { path, implicit } of requests) {
    const [head, ...rest] = path.split('.');
    if (head === '*') {
      for (const f of c.fields) if (granted(f) && readable(f)) add(f, null, true);
      if (rest.length) for (const f of c.fields) if (granted(f) && f.relation) add(f, { path: rest.join('.'), implicit: true }, true);
      continue;
    }
    const f = fieldOf(c, head!);
    if (!f || !granted(f) || (rest.length > 0 && !f.relation)) {
      if (implicit) continue;
      throw noField(c, prefix + path);
    }
    add(f, rest.length ? { path: rest.join('.'), implicit } : null, implicit);
  }

  const node: Node = { c, access, columns: [], children: [] };
  for (const { field: f, plain, plainExplicit, sub } of entries.values()) {
    const rel = f.relation;
    if (rel && (sub.length > 0 || (rel.type === 'o2m' && plain))) {
      const explicit = sub.some((r) => !r.implicit) || (sub.length === 0 && plainExplicit);
      const child = relatedChild(c, f, rel, sub, deep?.[f.field] ?? null, `${prefix}${f.field}`, explicit, env);
      if (child) {
        node.children.push(child);
        continue;
      }
    }
    if (plain && f.type !== 'alias') node.columns.push(f);
  }
  return node;
}

/** The node for a relational field; null when only wildcards ask for it and its collection isn't readable. */
function relatedChild(
  parent: QueryCollection,
  f: QueryField,
  rel: QueryRelation,
  sub: Request[],
  deep: DeepQuery | null,
  path: string,
  explicit: boolean,
  env: Env,
): Child | null {
  let c: QueryCollection;
  let access: Access | null;
  try {
    if (!env.related) throw noField(parent, path);
    c = env.related.collection(rel.collection);
    access = env.related.readAccess(c.collection);
  } catch (err) {
    if (!explicit && isCirrusError(err) && err.code === 'FORBIDDEN') return null;
    throw err;
  }
  const keysOnly = sub.length === 0;
  const node = keysOnly ? { c, access, columns: [], children: [] } : build(c, sub, access, deep?.deep ?? null, `${path}.`, env);
  const query: RowQuery =
    rel.type === 'm2o'
      ? { filter: deep?.filter ?? null, search: null, sort: null, limit: -1, offset: 0 }
      : { filter: deep?.filter ?? null, search: deep?.search ?? null, sort: deep?.sort ?? null, limit: deep?.limit ?? env.limitDefault, offset: deep?.offset ?? 0 };
  return { field: f, relation: rel, keysOnly, node, query };
}

// Statements -------------------------------------------------------------------------------------

/** Output columns of a statement: [result name, SQL]. */
type Columns = (x: Ctx) => Array<[string, string]>;

/**
 * The rows a node returns, selecting the given columns: the node's own statement (`ordered`, so
 * related items keep their order), or a subquery giving its children their parents.
 */
type Source = (p: Params, columns: Columns, ordered: boolean) => string;

const select = (columns: Array<[string, string]>) => columns.map(([name, sql]) => `${sql} AS ${quoteIdent(name)}`).join(', ');

/**
 * A node's own columns: the requested ones, then what merging needs, under names no field can have
 * (fields start with a letter): `_key` its key, `_parent` (O2M) the parent's key, `_m<i>` the key
 * its i-th child (an M2O) points at, `_v<i>` whether its i-th child (an O2M) is visible.
 */
function nodeColumns(node: Node, link: QueryRelation | null): Columns {
  return (x) => {
    const cols: Array<[string, string]> = node.columns.map((f) => [f.field, ref(x, f.field).sql]);
    cols.push(['_key', rawKey(x)]);
    if (link?.type === 'o2m') cols.push(['_parent', x.column(link.field)]);
    node.children.forEach((ch, i) => {
      if (ch.relation.type === 'm2o') {
        cols.push([`_m${i}`, ref(x, ch.field.field).sql]);
      } else {
        const visible = visibility(x, ch.field.field);
        if (visible) cols.push([`_v${i}`, `(CASE WHEN ${visible} THEN 1 END)`]);
      }
    });
    return cols;
  };
}

function childSource(parent: Source, child: Child, env: Env): Source {
  const { node, query: q, relation: rel, field } = child;
  const { c, access } = node;
  const scope: Scope = { access, related: env.related };

  if (rel.type === 'm2o') {
    return (p, columns) => {
      const x = context(c, p, scope);
      const keys = parent(p, (px) => [['_k', ref(px, field.field).sql]], false);
      const cond = and([`${x.column(c.primary)} IN (${keys})`, scopeCondition(x, scope), q.filter ? compileFilter(x, q.filter) : TRUE]);
      return `SELECT ${select(columns(x))} FROM ${tableOf(c)}${where(cond)}`;
    };
  }

  return (p, columns, ordered) => {
    const x = context(c, p, scope);
    // Parents where the request may not see the field have no related items.
    const keys = parent(
      p,
      (px) => {
        const visible = visibility(px, field.field);
        return [['_k', visible ? `(CASE WHEN ${visible} THEN ${rawKey(px)} END)` : rawKey(px)]];
      },
      false,
    );
    const fk = x.column(rel.field);
    const cond = and([`${fk} IN (${keys})`, queryCondition(x, q, scope)]);
    // The default order (the relation's sort field, else the key) needs no access, like a collection's default sort.
    const sort = q.sort ? orderBy(x, q.sort) : orderBy(unchecked(x), [rel.sortField ?? c.primary]);
    const cols = columns(x);
    if (q.limit === -1 && q.offset === 0) return `SELECT ${select(cols)} FROM ${tableOf(c)}${where(cond)}${ordered ? ` ORDER BY ${sort}` : ''}`;
    const numbered = `SELECT ${select(cols)}, ROW_NUMBER() OVER (PARTITION BY ${fk} ORDER BY ${sort}) AS "_n" FROM ${tableOf(c)}${where(cond)}`;
    const range = q.limit === -1 ? `"_n" > ${p.add(q.offset)}` : `"_n" > ${p.add(q.offset)} AND "_n" <= ${p.add(q.offset + q.limit)}`;
    return `SELECT ${cols.map(([name]) => quoteIdent(name)).join(', ')} FROM (${numbered}) WHERE ${range}${ordered ? ' ORDER BY "_parent", "_n"' : ''}`;
  };
}

// Results ----------------------------------------------------------------------------------------

function materialize(node: Node, rows: Rows, results: readonly Rows[], index: ReadonlyMap<Child, number>, present: Present): Item[] {
  const items: Item[] = rows.map((r) => Object.fromEntries(node.columns.map((f) => [f.field, present(node.c, f, r[f.field])])));
  node.children.forEach((child, i) => {
    const childRows = results[index.get(child)!] ?? [];
    const childItems: unknown[] = child.keysOnly ? childRows.map((r) => r._key) : materialize(child.node, childRows, results, index, present);
    const key = child.field.field;
    if (child.relation.type === 'm2o') {
      const byKey = new Map(childRows.map((r, j) => [r._key, childItems[j]]));
      rows.forEach((r, j) => {
        const fk = r[`_m${i}`];
        items[j]![key] = fk === null || fk === undefined ? null : (byKey.get(fk) ?? null);
      });
      return;
    }
    const groups = new Map<unknown, unknown[]>();
    childRows.forEach((r, j) => {
      const list = groups.get(r._parent);
      if (list) list.push(childItems[j]);
      else groups.set(r._parent, [childItems[j]]);
    });
    rows.forEach((r, j) => {
      items[j]![key] = `_v${i}` in r && r[`_v${i}`] === null ? null : (groups.get(r._key) ?? []);
    });
  });
  return items;
}
