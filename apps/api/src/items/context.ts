import { type Access, buildAccess, type FilterVariables, type QueryCollection } from '@cirrus/query';
import { forbidden } from '@cirrus/shared';
import { noPermissionReason, permissionsFor, toRule } from '../access/permissions.ts';
import { ACTIONS, type Action } from '../access/snapshot.ts';
import type { Accountability } from '../env.ts';
import type { RequestContext } from '../request.ts';
import type { CollectionRecord } from '../schema/store.ts';
import { SYSTEM_COLLECTIONS, type SystemCollection } from '../system/collections.ts';

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
  /**
   * What the request may do with an action (spec §10): null for admins (everything); FORBIDDEN
   * when no permission grants the action.
   */
  access(action: Action): Access | null;
  /** Whether some permission grants the action (always, for admins). */
  can(action: Action): boolean;
};

/**
 * The context for one collection. User collections by default; `system` allows the system
 * collections instead (their own routes and nested writes). Directus answers FORBIDDEN for
 * collections that don't exist; folders have no items either.
 */
export async function itemsContext(req: RequestContext, name: string, opts: { system?: boolean } = {}): Promise<ItemsContext> {
  const system = opts.system ? (SYSTEM_COLLECTIONS.get(name) ?? null) : null;
  const collection = opts.system ? system : req.schema.collections.get(name);
  const pk = collection?.fields.find((f) => f.column?.primaryKey);
  if (!collection || collection.folder || !pk) throw forbidden();

  const { accountability, schema } = req;
  const records = (action: Action) => (accountability.admin ? [] : permissionsFor(schema, accountability, name, action));
  // Load what `$CURRENT_USER.<field>` in these permissions needs, once.
  const vars = await req.variables.for(...ACTIONS.flatMap(records));

  const info: QueryCollection = {
    collection: collection.collection,
    ...(system ? { table: system.table } : {}),
    primary: pk.field,
    sortField: collection.meta.sort_field,
    fields: collection.fields.map((f) => ({
      field: f.field,
      type: f.type,
      searchable: f.meta.searchable,
      concealed: f.type === 'hash' || (f.meta.special?.includes('conceal') ?? false),
    })),
  };

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
