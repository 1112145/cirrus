import type { Filter } from '@cirrus/query';
import { ipInNetworks, isPlainObject } from '@cirrus/shared';

/**
 * Roles, policies, access rows and permissions, loaded with the schema snapshot (spec §4, §10), so
 * checking a request's permissions needs no extra query. Every write to them replaces
 * schema_version, which makes every isolate reload the snapshot.
 */

export const ACTIONS = ['create', 'read', 'update', 'delete', 'share'] as const;
export type Action = (typeof ACTIONS)[number];

export type RoleRecord = { id: string; name: string; icon: string | null; description: string | null; parent: string | null };

export type PolicyRecord = {
  id: string;
  name: string;
  admin_access: boolean;
  app_access: boolean;
  enforce_tfa: boolean;
  /** IPs and CIDR ranges the policy is limited to; null or empty = anywhere. */
  ip_access: string[] | null;
};

/** Attaches a policy to a role or a user; neither = the public policy. */
export type AccessRecord = { id: string; role: string | null; user: string | null; policy: string; sort: number | null };

export type PermissionRecord = {
  id: number;
  policy: string;
  collection: string;
  action: Action;
  fields: string[] | null;
  permissions: Filter | null;
  validation: Filter | null;
  presets: Record<string, unknown> | null;
};

export type AccessSnapshot = {
  roles: Map<string, RoleRecord>;
  policies: Map<string, PolicyRecord>;
  /** Ordered by sort, then id. */
  access: AccessRecord[];
  /** Per policy, in id order. */
  permissions: Map<string, PermissionRecord[]>;
};

type Row = Record<string, unknown>;

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : null);
const object = (v: unknown) => {
  const parsed = json(v);
  return isPlainObject(parsed) ? parsed : null;
};

/** A string list stored as JSON; a plain CSV string is accepted too. */
function stringList(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  let parsed: unknown = v;
  try {
    parsed = json(v);
  } catch {
    // not JSON: a CSV string
  }
  if (typeof parsed === 'string') return parsed.split(',').map((s) => s.trim()).filter(Boolean);
  return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
}

export function accessFromRows(roles: Row[], policies: Row[], access: Row[], permissions: Row[]): AccessSnapshot {
  const byPolicy = new Map<string, PermissionRecord[]>();
  for (const r of permissions) {
    const p: PermissionRecord = {
      id: r.id as number,
      policy: r.policy as string,
      collection: r.collection as string,
      action: r.action as Action,
      fields: stringList(r.fields),
      permissions: object(r.permissions),
      validation: object(r.validation),
      presets: object(r.presets),
    };
    byPolicy.set(p.policy, [...(byPolicy.get(p.policy) ?? []), p]);
  }
  return {
    roles: new Map(
      roles.map((r) => [
        r.id as string,
        { id: r.id as string, name: r.name as string, icon: r.icon as string | null, description: r.description as string | null, parent: r.parent as string | null },
      ]),
    ),
    policies: new Map(
      policies.map((r) => [
        r.id as string,
        {
          id: r.id as string,
          name: r.name as string,
          admin_access: r.admin_access === 1,
          app_access: r.app_access === 1,
          enforce_tfa: r.enforce_tfa === 1,
          ip_access: stringList(r.ip_access),
        },
      ]),
    ),
    access: access.map((r) => ({
      id: r.id as string,
      role: r.role as string | null,
      user: r.user as string | null,
      policy: r.policy as string,
      sort: r.sort as number | null,
    })),
    permissions: byPolicy,
  };
}

/** The SQL that loads each part, in the order accessFromRows takes them. */
export const ACCESS_SQL = [
  'SELECT * FROM cirrus_roles ORDER BY id',
  'SELECT * FROM cirrus_policies ORDER BY id',
  'SELECT * FROM cirrus_access ORDER BY sort IS NULL, sort, id',
  'SELECT * FROM cirrus_permissions ORDER BY id',
];

/**
 * A role and its ancestors, from the top-level role down to `role` (Directus fetchRolesTree; the
 * order of `$CURRENT_ROLES`). A role that doesn't exist has no tree; a cycle stops the walk.
 */
export function roleTree(snapshot: AccessSnapshot, role: string | null): string[] {
  const tree: string[] = [];
  for (let id = role; id !== null && !tree.includes(id); ) {
    const r = snapshot.roles.get(id);
    if (!r) break;
    tree.push(id);
    id = r.parent;
  }
  return tree.reverse();
}

/**
 * The policies that apply to a request, as Directus 11 fetchPolicies collects them: the policies
 * of the user's roles (parent roles first) and of the user, or, for requests without a role, the
 * public policy plus the user's own. Policies limited to other IPs are dropped.
 */
export function policiesFor(snapshot: AccessSnapshot, who: { user: string | null; roles: string[]; ip: string | null }): string[] {
  const rows = snapshot.access.filter((a) =>
    (who.user !== null && a.user === who.user) || (who.roles.length ? a.role !== null && who.roles.includes(a.role) : a.role === null && a.user === null),
  );
  // Role policies in tree order, then the public and user policies.
  const rank = (a: AccessRecord) => (a.role === null ? who.roles.length : who.roles.indexOf(a.role));
  const sorted = rows.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i);

  const out: string[] = [];
  for (const { a } of sorted) {
    const policy = snapshot.policies.get(a.policy);
    if (!policy || out.includes(policy.id)) continue;
    if (policy.ip_access?.length && (who.ip === null || !ipInNetworks(who.ip, policy.ip_access))) continue;
    out.push(policy.id);
  }
  return out;
}
