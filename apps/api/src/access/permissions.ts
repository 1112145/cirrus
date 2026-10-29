import { type Filter, parseFilter, parsePresets, type PermissionRule } from '@cirrus/query';
import type { FilterVariables } from '@cirrus/query';
import type { Accountability } from '../env.ts';
import type { Schema } from '../schema/store.ts';
import type { Action, PermissionRecord } from './snapshot.ts';

/**
 * Users with app access may always read themselves, their roles, policies and permissions, like
 * Directus' app access minimal permissions (for the system collections Cirrus has).
 */
const APP_MINIMAL: ReadonlyArray<Omit<PermissionRecord, 'id' | 'policy'>> = [
  { collection: 'directus_users', action: 'read', permissions: { id: { _eq: '$CURRENT_USER' } }, fields: ['*'], validation: null, presets: null },
  { collection: 'directus_roles', action: 'read', permissions: { id: { _in: '$CURRENT_ROLES' } }, fields: ['*'], validation: null, presets: null },
  { collection: 'directus_policies', action: 'read', permissions: { id: { _in: '$CURRENT_POLICIES' } }, fields: ['*'], validation: null, presets: null },
  { collection: 'directus_permissions', action: 'read', permissions: { policy: { _in: '$CURRENT_POLICIES' } }, fields: ['*'], validation: null, presets: null },
  {
    collection: 'directus_access',
    action: 'read',
    permissions: { _or: [{ user: { _eq: '$CURRENT_USER' } }, { role: { _in: '$CURRENT_ROLES' } }] },
    fields: ['*'],
    validation: null,
    presets: null,
  },
];

/** The permissions of the request's policies for one action on one collection, in policy order. Not for admins. */
export function permissionsFor(
  schema: Schema,
  a: Accountability,
  collection: string,
  action: Action,
): Array<Omit<PermissionRecord, 'id' | 'policy'>> {
  const out: Array<Omit<PermissionRecord, 'id' | 'policy'>> = a.policies.flatMap((id) =>
    (schema.access.permissions.get(id) ?? []).filter((p) => p.collection === collection && p.action === action),
  );
  if (a.app) out.push(...APP_MINIMAL.filter((p) => p.collection === collection && p.action === action));
  return out;
}

/** Every permission of the request's policies (and the app's minimal ones), on any collection. Not for admins. */
export function allPermissions(schema: Schema, a: Accountability): Array<Omit<PermissionRecord, 'id' | 'policy'>> {
  const out: Array<Omit<PermissionRecord, 'id' | 'policy'>> = a.policies.flatMap((id) => schema.access.permissions.get(id) ?? []);
  if (a.app) out.push(...APP_MINIMAL);
  return out;
}

/** Every collection the request has a permission on, with the actions. */
export function permittedCollections(schema: Schema, a: Accountability): Map<string, Set<Action>> {
  const out = new Map<string, Set<Action>>();
  const add = (p: { collection: string; action: Action }) => out.set(p.collection, (out.get(p.collection) ?? new Set()).add(p.action));
  for (const id of a.policies) for (const p of schema.access.permissions.get(id) ?? []) add(p);
  if (a.app) APP_MINIMAL.forEach(add);
  return out;
}

/** A permission with its dynamic variables resolved. */
export function toRule(p: Omit<PermissionRecord, 'id' | 'policy'>, vars: FilterVariables): PermissionRule {
  const filter = (f: Filter | null) => (f ? parseFilter(f, vars) : null);
  return {
    fields: p.fields,
    permissions: filter(p.permissions),
    validation: filter(p.validation),
    presets: p.presets ? parsePresets(p.presets, vars) : null,
  };
}

/** Directus' reason when a request has no permission for an action. */
export const noPermissionReason = (action: Action, collection: string) =>
  `You don't have permission to "${action}" from collection "${collection}" or it does not exist.`;
