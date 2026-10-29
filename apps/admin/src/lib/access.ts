import { InputError } from './values.ts';

/**
 * Directus 11 access control as the app edits it: policies hold permissions (one per collection and
 * action), and are attached to roles or users through access rows (spec §10).
 */

export type Action = 'create' | 'read' | 'update' | 'delete';

/** The actions the app manages. (`share` exists in the model, but Cirrus has no shares yet.) */
export const ACTIONS: Action[] = ['create', 'read', 'update', 'delete'];

type Json = Record<string, unknown>;

export type Permission = {
  id?: number;
  policy: string;
  collection: string;
  action: string;
  permissions: Json | null;
  validation: Json | null;
  presets: Json | null;
  fields: string[] | null;
};

export type Policy = {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  ip_access: string[] | null;
  enforce_tfa: boolean;
  admin_access: boolean;
  app_access: boolean;
};

export type Role = { id: string; name: string; icon: string | null; description: string | null; parent: string | null };

/** An access row: a policy attached to a role, a user, or (neither) everyone: the public policy. */
export type Access = { id: string; role: string | null; user: string | null; policy: string; sort: number | null };

/** The public policy seeded by the migrations (Directus' id). */
export const PUBLIC_POLICY = 'abf8a154-5b1c-4a46-ac9c-7300570f4f17';

/** How much a policy allows for a collection and action. */
export type Level = 'none' | 'all' | 'custom';

export const isEmptyObject = (v: unknown) => v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/** None without a permission; all for every field and item without validation or presets; custom otherwise. */
export function levelOf(p: Permission | undefined): Level {
  if (!p) return 'none';
  const allFields = p.fields?.includes('*') ?? false;
  return allFields && isEmptyObject(p.permissions) && isEmptyObject(p.validation) && isEmptyObject(p.presets) ? 'all' : 'custom';
}

/** A permission giving everything, as the Directus app creates it. */
export const fullPermission = (policy: string, collection: string, action: Action): Permission => ({
  policy,
  collection,
  action,
  fields: ['*'],
  permissions: {},
  validation: {},
  presets: null,
});

/** A policy's permissions by collection and action. */
export function byCollection(permissions: readonly Permission[]): Map<string, Partial<Record<Action, Permission>>> {
  const out = new Map<string, Partial<Record<Action, Permission>>>();
  for (const p of permissions) {
    if (!(ACTIONS as string[]).includes(p.action)) continue;
    const row = out.get(p.collection) ?? {};
    row[p.action as Action] ??= p;
    out.set(p.collection, row);
  }
  return out;
}

/** A JSON object typed in a text area: null when empty. */
export function parseObject(text: string, what = 'This'): Json | null {
  if (!text.trim()) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new InputError(`${what} isn't valid JSON.`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InputError(`${what} must be a JSON object.`);
  return v as Json;
}

export const objectText = (v: unknown) => (isEmptyObject(v) ? '' : JSON.stringify(v, null, 2));

/** Ready-made item filters for a collection with these fields. */
export function filterSuggestions(collection: string, fields: readonly string[]): Array<{ label: string; filter: Json }> {
  const out: Array<{ label: string; filter: Json }> = [];
  if (collection === 'directus_users') out.push({ label: 'Only themselves', filter: { id: { _eq: '$CURRENT_USER' } } });
  if (collection === 'directus_files') out.push({ label: 'Files they uploaded', filter: { uploaded_by: { _eq: '$CURRENT_USER' } } });
  if (fields.includes('user_created')) out.push({ label: 'Items they created', filter: { user_created: { _eq: '$CURRENT_USER' } } });
  if (fields.includes('status')) out.push({ label: 'Published items', filter: { status: { _eq: 'published' } } });
  return out;
}

/** Directus' translation keys used by the seeded roles and policies, in English. */
const TRANSLATIONS: Record<string, string> = {
  public_label: 'Public',
  public_description: 'Controls what API data is publicly available without authenticating',
  admin_description: 'Initial administrative role with unrestricted App/API access',
};

/** A name or description as people read it: `$t:public_label` → `Public`. */
export function translate(text: string | null | undefined): string {
  if (!text) return '';
  const m = /^\$t:(.+)$/.exec(text);
  return m ? (TRANSLATIONS[m[1]!] ?? m[1]!.replace(/_/g, ' ')) : text;
}

/** A random static token for a user, shown once (the API keeps only its SHA-256). */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The roles a role may take as parent: not itself, nor any role below it (that would make a cycle). */
export function parentChoices(roles: readonly Role[], self: string | null): Role[] {
  if (!self) return [...roles];
  const below = new Set([self]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of roles) {
      if (r.parent && below.has(r.parent) && !below.has(r.id)) {
        below.add(r.id);
        grew = true;
      }
    }
  }
  return roles.filter((r) => !below.has(r.id));
}

/**
 * The `policies` of a role or user as the API takes them: access rows to keep (by key) and to
 * create (`{ policy }`); rows left out are deleted.
 */
export function accessPayload(rows: ReadonlyArray<{ id?: string; policy: { id: string } | string }>): Array<string | { policy: string }> {
  return rows.map((r) => (r.id ? r.id : { policy: typeof r.policy === 'object' ? r.policy.id : r.policy }));
}
