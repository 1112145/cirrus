import { type FilterVariables, recordVariables } from '@cirrus/query';
import { isCirrusError } from '@cirrus/shared';
import type { Context } from 'hono';
import { type AccessSnapshot, policiesFor, roleTree } from './access/snapshot.ts';
import type { Accountability, AppEnv, Bindings, Identity } from './env.ts';
import { itemsContext } from './items/context.ts';
import { readOne } from './items/service.ts';
import { getSchema, type Schema } from './schema/store.ts';
import { ROLES, type SystemCollection, USERS } from './system/collections.ts';

/** Everything a request's services need: the snapshot it was checked against and who is asking. */
export type RequestContext = {
  db: D1Database;
  env: Bindings;
  schema: Schema;
  accountability: Accountability;
  /** One timestamp per request, for date-created/date-updated, presets and $NOW. */
  now: Date;
  variables: RequestVariables;
};

/** The request's context, loaded once (one schema_version check) and shared by its handlers. */
export function requestContext(c: Context<AppEnv>): Promise<RequestContext> {
  let ctx = c.get('request');
  if (!ctx) {
    ctx = (async () => {
      const schema = await getSchema(c.env.DB);
      const accountability = accountabilityFor(schema.access, c.get('identity'), c.req.header('CF-Connecting-IP') ?? null);
      const now = new Date();
      return { db: c.env.DB, env: c.env, schema, accountability, now, variables: new RequestVariables(c.env.DB, c.env, schema, accountability, now) };
    })();
    c.set('request', ctx);
  }
  return ctx;
}

/** Directus getAccountabilityForToken: the role tree, the policies that apply, and admin/app access from those policies. */
export function accountabilityFor(snapshot: AccessSnapshot, identity: Identity, ip: string | null): Accountability {
  if (identity.kind === 'admin-token') return { admin: true, app: true, user: null, role: null, roles: [], policies: [], ip };
  const user = identity.kind === 'user' ? identity.user : null;
  const role = identity.kind === 'user' ? identity.role : null;
  const roles = roleTree(snapshot, role);
  const policies = policiesFor(snapshot, { user, roles, ip });
  const records = policies.map((id) => snapshot.policies.get(id)!);
  const admin = records.some((p) => p.admin_access);
  return { admin, app: admin || records.some((p) => p.app_access), user, role, roles, policies, ip };
}

/**
 * Dynamic variables for filters and presets. `$CURRENT_USER.<path>` needs the user's record, which
 * is only read when something refers to it, with just the paths referred to; paths may go through
 * relations (`$CURRENT_USER.role.name`), and so may `$CURRENT_ROLE.<path>` (the role's own fields
 * come from the snapshot). Records are read like items, as an admin, so concealed values stay masked.
 */
export class RequestVariables {
  readonly #records = new Map<'user' | 'role', { paths: Set<string>; record: Record<string, unknown> | null }>();

  constructor(
    private readonly db: D1Database,
    private readonly env: Bindings,
    private readonly schema: Schema,
    private readonly accountability: Accountability,
    private readonly now: Date,
  ) {}

  /** Variables with every record path the given values (raw filters, presets, queries) refer to. */
  async for(...values: unknown[]): Promise<FilterVariables> {
    const { user, role } = recordVariables(values);
    await this.#load('user', user);
    await this.#load('role', new Set([...role].filter((p) => p.includes('.'))));
    return this.current;
  }

  get current(): FilterVariables {
    const a = this.accountability;
    const role = a.role ? this.schema.access.roles.get(a.role) : undefined;
    const loadedRole = this.#records.get('role')?.record;
    return {
      now: this.now,
      user: a.user,
      role: a.role,
      roles: a.roles,
      policies: a.policies,
      userRecord: this.#records.get('user')?.record ?? null,
      roleRecord: role ? { ...role, ...loadedRole } : null,
    };
  }

  async #load(kind: 'user' | 'role', paths: ReadonlySet<string>) {
    const loaded = this.#records.get(kind);
    if (paths.size === 0 || (loaded && [...paths].every((p) => loaded.paths.has(p)))) return;
    const all = new Set([...(loaded?.paths ?? []), ...paths]);
    const key = kind === 'user' ? this.accountability.user : this.accountability.role;
    const record = key ? await this.#read(kind === 'user' ? USERS : ROLES, key, [...all]) : null;
    this.#records.set(kind, { paths: all, record });
  }

  async #read(collection: SystemCollection, key: string, paths: string[]): Promise<Record<string, unknown> | null> {
    // Fields that don't exist resolve to null rather than failing the others.
    const fields = paths.filter((p) => collection.fields.some((f) => f.field === p.split('.')[0]));
    if (fields.length === 0) return {};
    const admin: Accountability = { admin: true, app: true, user: null, role: null, roles: [], policies: [], ip: this.accountability.ip };
    const req: RequestContext = {
      db: this.db,
      env: this.env,
      schema: this.schema,
      accountability: admin,
      now: this.now,
      variables: new RequestVariables(this.db, this.env, this.schema, admin, this.now),
    };
    try {
      const ctx = await itemsContext(req, collection.collection, { system: true });
      return await readOne(ctx, key, { fields, filter: null, search: null, sort: null, limit: 1, offset: 0, meta: [], deep: null });
    } catch (e) {
      if (isCirrusError(e) && e.code === 'FORBIDDEN') return null;
      throw e;
    }
  }
}
