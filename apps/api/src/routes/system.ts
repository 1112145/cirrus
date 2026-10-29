import { buildAccess, isEmptyFilter, selectKeys } from '@cirrus/query';
import { CirrusError, forbidden, isCirrusError } from '@cirrus/shared';
import { type Context, Hono } from 'hono';
import { permissionsFor, permittedCollections, toRule } from '../access/permissions.ts';
import { ACTIONS, type Action } from '../access/snapshot.ts';
import type { AppEnv } from '../env.ts';
import { type ItemsContext, itemsContext } from '../items/context.ts';
import { parseKey } from '../items/payload.ts';
import { readMany, readOne, updateOne } from '../items/service.ts';
import { readJson } from '../middleware/body.ts';
import { requestContext } from '../request.ts';
import { SYSTEM_COLLECTIONS } from '../system/collections.ts';
import { itemRoutes, readBack, urlQuery } from './item-routes.ts';

/**
 * The system collections' endpoints (spec §17.1): the items endpoints at their Directus paths,
 * plus the "me" endpoints. Permissions apply as for user collections; admins may do everything.
 */

const system = (name: string) => async (c: Context<AppEnv>) => itemsContext(await requestContext(c), name, { system: true });

const invalidCredentials = () => new CirrusError('INVALID_CREDENTIALS', 'Invalid user credentials.');

/** The current user, or INVALID_CREDENTIALS for requests without one (Directus /users/me). */
async function currentUser(c: Context<AppEnv>): Promise<{ ctx: ItemsContext; user: string }> {
  const ctx = await system('directus_users')(c);
  const user = ctx.accountability.user;
  if (!user) throw invalidCredentials();
  return { ctx, user };
}

// Users ------------------------------------------------------------------------------------------

/** SDK: readUsers, readUser, readMe, createUser(s), updateUser(s), updateUsersBatch, updateMe, deleteUser(s) */
export const users = new Hono<AppEnv>();

// Directus answers { id } when the user may not read their own record.
users.get('/me', async (c) => {
  const { ctx, user } = await currentUser(c);
  const q = await urlQuery(c, ctx);
  try {
    return c.json({ data: await readOne(ctx, user, q) });
  } catch (e) {
    if (isCirrusError(e) && e.code === 'FORBIDDEN') return c.json({ data: { id: user } });
    throw e;
  }
});

users.patch('/me', async (c) => {
  const { ctx, user } = await currentUser(c);
  const q = await urlQuery(c, ctx);
  await updateOne(ctx, user, await readJson(c));
  return readBack(c, () => readOne(ctx, user, q));
});

itemRoutes(users, '', system('directus_users'));

// Roles ------------------------------------------------------------------------------------------

/** SDK: readRoles, readRole, readRolesMe, createRole(s), updateRole(s), updateRolesBatch, deleteRole(s) */
export const roles = new Hono<AppEnv>();

// The current user's role and its ancestors; just their ids when they may not be read.
roles.get('/me', async (c) => {
  const ctx = await system('directus_roles')(c);
  const { roles: mine } = ctx.accountability;
  const q = await urlQuery(c, ctx);
  try {
    return c.json({ data: await readMany(ctx, mine, { ...q, limit: -1 }) });
  } catch (e) {
    if (isCirrusError(e) && e.code === 'FORBIDDEN') return c.json({ data: mine.map((id) => ({ id })) });
    throw e;
  }
});

itemRoutes(roles, '', system('directus_roles'));

// Policies ---------------------------------------------------------------------------------------

/** SDK: readPolicies, readPolicy, readPolicyGlobals, createPolicy/Policies, updatePolicy/Policies, updatePoliciesBatch, deletePolicy/Policies */
export const policies = new Hono<AppEnv>();

policies.get('/me/globals', async (c) => {
  const { accountability: a, schema } = await requestContext(c);
  const applied = a.policies.map((id) => schema.access.policies.get(id)!);
  return c.json({ data: { app_access: a.app, admin_access: a.admin, enforce_tfa: applied.some((p) => p.enforce_tfa) } });
});

itemRoutes(policies, '', system('directus_policies'));

// Permissions ------------------------------------------------------------------------------------

/** SDK: readPermissions, readPermission, readUserPermissions, readItemPermissions, create/update/delete */
export const permissions = new Hono<AppEnv>();

type ActionAccess = { access: 'none' } | { access: 'partial' | 'full'; fields: string[]; presets: Record<string, unknown> | null };

/** Directus 11 /permissions/me: per collection and action, whether the request has full, partial or no access. */
permissions.get('/me', async (c) => {
  const req = await requestContext(c);
  const { schema, accountability: a } = req;
  const names = a.admin
    ? [...[...schema.collections.values()].filter((col) => !col.folder).map((col) => col.collection), ...SYSTEM_COLLECTIONS.keys()]
    : [...permittedCollections(schema, a).keys()];

  const data: Record<string, Partial<Record<Action, ActionAccess>>> = {};
  for (const name of names) {
    const actions: Partial<Record<Action, ActionAccess>> = {};
    for (const action of ACTIONS) {
      if (a.admin) {
        actions[action] = { access: 'full', fields: ['*'], presets: null };
        continue;
      }
      const records = permissionsFor(schema, a, name, action);
      if (records.length === 0) {
        actions[action] = { access: 'none' };
        continue;
      }
      const vars = await req.variables.for(records);
      const rules = records.map((r) => toRule(r, vars));
      const fields = [...new Set(rules.flatMap((r) => r.fields ?? []))];
      const presets = Object.assign({}, ...rules.map((r) => r.presets ?? {}));
      actions[action] = {
        access: rules.some((r) => isEmptyFilter(r.permissions)) ? 'full' : 'partial',
        fields: fields.includes('*') ? ['*'] : fields,
        presets: Object.keys(presets).length ? presets : null,
      };
    }
    data[name] = actions;
  }
  return c.json({ data });
});

/**
 * Directus 11 item permissions: may the user update, delete and share this item (or the
 * collection, without a key)? For singletons, also the fields and presets of an update.
 */
async function itemPermissions(c: Context<AppEnv>) {
  const req = await requestContext(c);
  const a = req.accountability;
  if (!a.user && !a.admin) throw forbidden();
  const name = c.req.param('collection')!;
  const ctx = await itemsContext(req, name, { system: name.startsWith('directus_') });
  if (a.admin) return c.json({ data: { update: { access: true }, delete: { access: true }, share: { access: true } } });

  const raw = c.req.param('pk');
  const key = raw === undefined ? null : parseKey(ctx, raw);
  const singleton = ctx.collection.meta.singleton;
  const exists = async (action: Action) => {
    const access = ctx.access(action)!;
    const target = key === null ? { query: { filter: null, search: null, sort: null, limit: 1, offset: 0 } } : { key };
    const s = selectKeys(ctx.info, target, { restrict: access.filter, related: ctx.related });
    return (await ctx.db.prepare(s.sql).bind(...s.params).all()).results.length > 0;
  };
  const check = async (action: Action) => ctx.can(action) && (key !== null || singleton ? await exists(action) : true);

  // A singleton without its item can only be created.
  const updateAction: Action = singleton && !(await hasItem(ctx)) ? 'create' : 'update';
  const update: Record<string, unknown> = { access: await check(updateAction) };
  if (singleton && update.access) {
    const access = buildAccess(ctx.info, permissionsFor(req.schema, a, name, updateAction).map((r) => toRule(r, ctx.vars)));
    update.fields = access.allFields ? ['*'] : [...access.fields.keys()];
    update.presets = access.presets;
  }
  return c.json({ data: { update, delete: { access: await check('delete') }, share: { access: await check('share') } } });
}

async function hasItem(ctx: ItemsContext): Promise<boolean> {
  const s = selectKeys(ctx.info, { query: { filter: null, search: null, sort: null, limit: 1, offset: 0 } });
  return (await ctx.db.prepare(s.sql).bind(...s.params).all()).results.length > 0;
}

permissions.get('/me/:collection', itemPermissions);
permissions.get('/me/:collection/:pk', itemPermissions);

itemRoutes(permissions, '', system('directus_permissions'));

// Access -----------------------------------------------------------------------------------------

/** Directus 11 /access: which policies are attached to which roles and users (directus_access). */
export const access = new Hono<AppEnv>();

itemRoutes(access, '', system('directus_access'));
