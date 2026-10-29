import { type Access, buildAccess, type FilterVariables, type QueryCollection, type QueryField, type Related } from '@cirrus/query';
import { forbidden } from '@cirrus/shared';
import { allPermissions, noPermissionReason, permissionsFor, toRule } from '../access/permissions.ts';
import type { Action } from '../access/snapshot.ts';
import type { Accountability, Bindings } from '../env.ts';
import type { RequestContext } from '../request.ts';
import { anyCollection, type CollectionRecord, m2oOf, o2mOf, type Schema } from '../schema/store.ts';
import { SYSTEM_COLLECTIONS, type SystemCollection } from '../system/collections.ts';

/** Query limits, from the Worker vars (Directus' names). */
export type Limits = {
  /** QUERY_LIMIT_DEFAULT: items per request, and related items per item, when none is asked for. */
  limitDefault: number;
  /** QUERY_LIMIT_MAX: the most a request may ask for; -1 = none. */
  limitMax: number;
  /** MAX_RELATIONAL_DEPTH: most segments of a path into relations. */
  maxDepth: number;
};

export type ItemsContext = {
  req: RequestContext;
  db: D1Database;
  collection: CollectionRecord;
  /** Set for system collections (directus_users, …). */
  system: SystemCollection | null;
  info: QueryCollection;
  now: Date;
  accountability: Accountability;
  vars: FilterVariables;
  /** The collections relational paths lead to, with the request's read access to each. */
  related: Related;
  limits: Limits;
  /**
   * What the request may do with an action (spec §10): null for admins (everything); FORBIDDEN
   * when no permission grants the action.
   */
  access(action: Action): Access | null;
  /** Whether some permission grants the action (always, for admins). */
  can(action: Action): boolean;
};

const intVar = (v: string | undefined, fallback: number) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : fallback);

export function limitsOf(env: Bindings): Limits {
  const limitMax = intVar(env.QUERY_LIMIT_MAX, -1);
  const limitDefault = intVar(env.QUERY_LIMIT_DEFAULT, 100);
  return {
    limitDefault: limitMax < 0 ? limitDefault : Math.min(limitDefault, limitMax),
    limitMax,
    maxDepth: intVar(env.MAX_RELATIONAL_DEPTH, 10),
  };
}

// Collections ------------------------------------------------------------------------------------

const infoCache = new WeakMap<Schema, Map<string, QueryCollection | null>>();

/**
 * What the query compiler needs to know about a collection, user or system, relations included;
 * null when it has no items (it doesn't exist, or is a folder). Cached with the snapshot.
 */
export function queryInfo(schema: Schema, name: string): QueryCollection | null {
  let cache = infoCache.get(schema);
  if (!cache) infoCache.set(schema, (cache = new Map()));
  if (cache.has(name)) return cache.get(name)!;

  const collection = anyCollection(schema, name);
  const pk = collection?.fields.find((f) => f.column?.primaryKey);
  let info: QueryCollection | null = null;
  if (collection && !collection.folder && pk) {
    const system = SYSTEM_COLLECTIONS.get(name);
    info = {
      collection: name,
      ...(system ? { table: system.table } : {}),
      primary: pk.field,
      sortField: collection.meta.sort_field,
      fields: collection.fields.map((f): QueryField => {
        const m2o = f.column ? m2oOf(schema, name, f.field) : null;
        const o2m = f.column ? null : o2mOf(schema, name, f.field);
        return {
          field: f.field,
          type: f.type,
          searchable: f.meta.searchable,
          concealed: f.type === 'hash' || (f.meta.special?.includes('conceal') ?? false),
          relation: m2o
            ? { type: 'm2o', collection: m2o.related }
            : o2m
              ? { type: 'o2m', collection: o2m.collection, field: o2m.field, sortField: o2m.sortField }
              : null,
        };
      }),
    };
  }
  cache.set(name, info);
  return info;
}

/** Directus' reason when a relational path reaches a collection the request may not read. */
const noCollection = (name: string) => forbidden(`You don't have permission to access collection "${name}" or it does not exist.`);

const relatedCache = new WeakMap<RequestContext, Related>();

/**
 * The request's view of every collection relational paths may reach: their info, and its read
 * access to them, built from its permissions with the variables itemsContext() loaded.
 */
function relatedFor(req: RequestContext): Related {
  let related = relatedCache.get(req);
  if (related) return related;
  const accesses = new Map<string, Access | null>();
  related = {
    collection(name) {
      const info = queryInfo(req.schema, name);
      if (!info) throw forbidden();
      return info;
    },
    readAccess(name) {
      if (req.accountability.admin) return null;
      if (accesses.has(name)) return accesses.get(name)!;
      const info = queryInfo(req.schema, name);
      const rules = permissionsFor(req.schema, req.accountability, name, 'read');
      if (!info || rules.length === 0) throw noCollection(name);
      const access = buildAccess(info, rules.map((r) => toRule(r, req.variables.current)));
      accesses.set(name, access);
      return access;
    },
  };
  relatedCache.set(req, related);
  return related;
}

/**
 * The context for one collection. User collections by default; `system` allows the system
 * collections instead (their own routes and nested writes). Directus answers FORBIDDEN for
 * collections that don't exist; folders have no items either.
 */
export async function itemsContext(req: RequestContext, name: string, opts: { system?: boolean } = {}): Promise<ItemsContext> {
  const system = opts.system ? (SYSTEM_COLLECTIONS.get(name) ?? null) : null;
  const collection = opts.system ? system : req.schema.collections.get(name);
  const info = collection ? queryInfo(req.schema, name) : null;
  if (!collection || !info) throw forbidden();

  const { accountability, schema } = req;
  // Load what `$CURRENT_USER.<field>` needs in any of the request's permissions, once: relational
  // paths may reach other collections, whose permissions apply too.
  const vars = await req.variables.for(...(accountability.admin ? [] : allPermissions(schema, accountability)));
  const records = (action: Action) => (accountability.admin ? [] : permissionsFor(schema, accountability, name, action));

  const cache = new Map<Action, Access>();
  return {
    req,
    db: req.db,
    collection,
    system,
    info,
    now: req.now,
    accountability,
    vars,
    related: relatedFor(req),
    limits: limitsOf(req.env),
    access(action) {
      if (accountability.admin) return null;
      let access = cache.get(action);
      if (!access) {
        const rules = records(action);
        if (rules.length === 0) throw forbidden(noPermissionReason(action, name));
        access = buildAccess(info, rules.map((r) => toRule(r, vars)));
        cache.set(action, access);
      }
      return access;
    },
    can: (action) => accountability.admin || records(action).length > 0,
  };
}

/** The context of a related collection, user or system (nested writes, on_delete). */
export const relatedContext = (req: RequestContext, name: string) => itemsContext(req, name, { system: SYSTEM_COLLECTIONS.has(name) });
