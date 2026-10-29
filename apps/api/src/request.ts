import { type FilterVariables, recordVariables } from '@cirrus/query';
import { fromDbValue } from '@cirrus/schema';
import type { Context } from 'hono';
import { type AccessSnapshot, policiesFor, roleTree } from './access/snapshot.ts';
import type { Accountability, AppEnv, Bindings, Identity } from './env.ts';
import { getSchema, type Schema } from './schema/store.ts';
import { USERS } from './system/collections.ts';

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
      return { db: c.env.DB, env: c.env, schema, accountability, now, variables: new RequestVariables(c.env.DB, schema, accountability, now) };
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
 * Dynamic variables for filters and presets. `$CURRENT_USER.<field>` needs the user's record,
 * which is only read when something refers to it.
 */
export class RequestVariables {
  #user: Record<string, unknown> | null | undefined;

  constructor(
    private readonly db: D1Database,
    private readonly schema: Schema,
    private readonly accountability: Accountability,
    private readonly now: Date,
  ) {}

  /** Variables with every record field the given values (raw filters, presets, queries) refer to. */
  async for(...values: unknown[]): Promise<FilterVariables> {
    const { user: userFields } = recordVariables(values);
    if (userFields.size && this.#user === undefined) this.#user = await this.#loadUser();
    return this.current;
  }

  get current(): FilterVariables {
    const a = this.accountability;
    const role = a.role ? this.schema.access.roles.get(a.role) : undefined;
    return {
      now: this.now,
      user: a.user,
      role: a.role,
      roles: a.roles,
      policies: a.policies,
      userRecord: this.#user ?? null,
      roleRecord: role ? { ...role } : null,
    };
  }

  async #loadUser(): Promise<Record<string, unknown> | null> {
    if (!this.accountability.user) return null;
    const row = await this.db.prepare('SELECT * FROM cirrus_users WHERE id = ?1').bind(this.accountability.user).first<Record<string, unknown>>();
    if (!row) return null;
    return Object.fromEntries(USERS.fields.filter((f) => f.column).map((f) => [f.field, fromDbValue(f.type, row[f.field])]));
  }
}
