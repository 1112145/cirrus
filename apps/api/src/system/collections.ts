import type { ColumnDef, FieldType, JsonValue } from '@cirrus/schema';
import { invalidPayload, isIpNetwork, isPlainObject } from '@cirrus/shared';
import { ACTIONS } from '../access/snapshot.ts';
import { COLLECTION_META, FIELD_META, type FieldMeta, metaDefaults } from '../schema/meta.ts';
import type { CollectionRecord, FieldRecord, O2M, Schema } from '../schema/store.ts';

/**
 * System collections (spec §6, §17.2): Directus' names and fields over the cirrus_* tables. They
 * are defined here rather than in cirrus_collections, and served by the same items service as user
 * collections, so permissions, queries and errors behave the same. The SDK reaches them through
 * their own paths (/users, /roles, …); /items/directus_* stays FORBIDDEN, as in Directus.
 */

export type Payload = Record<string, unknown>;

export type SystemCollection = CollectionRecord & {
  table: string;
  /** Writes change the access snapshot, so they replace schema_version. */
  snapshot: boolean;
  /** Values a create sets when the payload leaves them out. */
  defaults: Payload;
  /** Check and normalize a payload before it is converted to column values. */
  normalize?: (payload: Payload, ctx: { action: 'create' | 'update'; key: string | number | null; schema: Schema }) => Payload;
};

type Spec = {
  type: FieldType;
  primary?: boolean;
  autoIncrement?: boolean;
  required?: boolean;
  unique?: boolean;
  defaultValue?: JsonValue;
  maxLength?: number;
  special?: string[];
  searchable?: boolean;
  o2m?: O2M;
};

let nextId = -1;

function field(collection: string, name: string, s: Spec): FieldRecord {
  const column: ColumnDef | null =
    s.type === 'alias'
      ? null
      : {
          primaryKey: s.primary ?? false,
          autoIncrement: s.autoIncrement ?? false,
          nullable: !(s.primary || s.required),
          unique: s.unique ?? false,
          indexed: false,
          defaultValue: s.defaultValue ?? null,
          maxLength: s.maxLength ?? null,
          numericPrecision: null,
          numericScale: null,
        };
  const meta: FieldMeta = { ...metaDefaults(FIELD_META), special: s.special ?? null, searchable: s.searchable ?? true };
  return { id: nextId--, collection, field: name, type: s.type, column, meta, ...(s.o2m ? { o2m: s.o2m } : {}) };
}

function collection(name: string, table: string, specs: Record<string, Spec>, rest: Omit<SystemCollection, 'collection' | 'folder' | 'meta' | 'fields' | 'table'>): SystemCollection {
  return {
    collection: name,
    table,
    folder: false,
    meta: { ...metaDefaults(COLLECTION_META), hidden: true },
    fields: Object.entries(specs).map(([f, s]) => field(name, f, s)),
    ...rest,
  };
}

const ID: Spec = { type: 'uuid', primary: true, special: ['uuid'] };
const string = (maxLength: number, extra: Partial<Spec> = {}): Spec => ({ type: 'string', maxLength, ...extra });
const json: Spec = { type: 'json', special: ['cast-json'] };
const bool = (defaultValue: boolean): Spec => ({ type: 'boolean', required: true, defaultValue, special: ['cast-boolean'] });
const o2m = (collection: string, field: string, deselect: O2M['deselect']): Spec => ({ type: 'alias', special: ['o2m'], o2m: { collection, field, deselect } });

// Normalizers --------------------------------------------------------------------------------------

const has = (p: Payload, key: string) => Object.hasOwn(p, key) && p[key] !== undefined;

/** A list of strings from an array or a comma-separated string (Directus csv fields). */
function stringList(p: Payload, key: string, check?: (s: string) => boolean, expected = 'an array of strings'): Payload {
  if (!has(p, key) || p[key] === null) return p;
  const v = p[key];
  const list = typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && (!check || check(s)))) {
    throw invalidPayload(`"${key}" must be ${expected}`);
  }
  return { ...p, [key]: list.length ? list : null };
}

function objectOrNull(p: Payload, key: string) {
  if (has(p, key) && p[key] !== null && !isPlainObject(p[key])) throw invalidPayload(`"${key}" must be an object or null`);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const USER_STATUSES = ['draft', 'invited', 'unverified', 'active', 'suspended', 'archived'];

function normalizeUser(p: Payload): Payload {
  if (has(p, 'email') && p.email !== null && (typeof p.email !== 'string' || !EMAIL_RE.test(p.email))) {
    throw invalidPayload('"email" must be a valid email');
  }
  if (has(p, 'status') && !USER_STATUSES.includes(p.status as string)) {
    throw invalidPayload(`"status" must be one of ${USER_STATUSES.join(', ')}`);
  }
  return p;
}

function normalizeRole(p: Payload, { key, schema }: { key: string | number | null; schema: Schema }): Payload {
  if (!has(p, 'parent') || p.parent === null || typeof p.parent !== 'string') return p;
  const self = (key ?? p.id) as string | undefined;
  // Walk up from the new parent: reaching this role would make a cycle.
  const seen = new Set<string>();
  for (let id: string | null = p.parent.toLowerCase(); id !== null && !seen.has(id); id = schema.access.roles.get(id)?.parent ?? null) {
    if (typeof self === 'string' && id === self.toLowerCase()) throw invalidPayload("A role can't be its own parent or ancestor");
    seen.add(id);
  }
  return p;
}

function normalizePolicy(p: Payload): Payload {
  return stringList(p, 'ip_access', isIpNetwork, 'a list of IP addresses or CIDR ranges');
}

function normalizePermission(p: Payload): Payload {
  if (has(p, 'action') && !(ACTIONS as readonly unknown[]).includes(p.action)) {
    throw invalidPayload(`"action" must be one of ${ACTIONS.join(', ')}`);
  }
  for (const key of ['permissions', 'validation', 'presets']) objectOrNull(p, key);
  return stringList(p, 'fields');
}

function normalizeAccess(p: Payload): Payload {
  if (p.role != null && p.user != null) throw invalidPayload('An access entry belongs to a role or a user, not both');
  return p;
}

// Collections ------------------------------------------------------------------------------------

export const USERS = collection(
  'directus_users',
  'cirrus_users',
  {
    id: ID,
    first_name: string(50),
    last_name: string(50),
    email: string(128, { required: true, unique: true }),
    password: { type: 'hash', special: ['hash', 'conceal'], searchable: false },
    location: string(255),
    title: string(50),
    description: { type: 'text' },
    tags: json,
    avatar: { type: 'uuid' },
    language: string(255),
    // Stored as its SHA-256; reads are concealed.
    token: string(255, { unique: true, special: ['conceal', 'static-token'], searchable: false }),
    last_access: { type: 'timestamp' },
    last_page: string(255),
    provider: string(128, { required: true, defaultValue: 'default' }),
    external_identifier: string(255, { unique: true }),
    auth_data: { ...json, searchable: false },
    email_notifications: { type: 'boolean', defaultValue: true, special: ['cast-boolean'] },
    appearance: string(255),
    theme_dark: string(255),
    theme_light: string(255),
    theme_light_overrides: json,
    theme_dark_overrides: json,
    status: string(16, { required: true, defaultValue: 'active' }),
    role: { type: 'uuid' },
    policies: o2m('directus_access', 'user', 'delete'),
  },
  { snapshot: false, defaults: {}, normalize: normalizeUser },
);

export const ROLES = collection(
  'directus_roles',
  'cirrus_roles',
  {
    id: ID,
    name: string(100, { required: true }),
    icon: string(64, { defaultValue: 'supervised_user_circle' }),
    description: { type: 'text' },
    parent: { type: 'uuid' },
    children: o2m('directus_roles', 'parent', 'nullify'),
    policies: o2m('directus_access', 'role', 'delete'),
    users: o2m('directus_users', 'role', 'nullify'),
  },
  { snapshot: true, defaults: { icon: 'supervised_user_circle' }, normalize: normalizeRole },
);

export const POLICIES = collection(
  'directus_policies',
  'cirrus_policies',
  {
    id: ID,
    name: string(100, { required: true }),
    icon: string(64, { defaultValue: 'badge' }),
    description: { type: 'text' },
    ip_access: json,
    enforce_tfa: bool(false),
    admin_access: bool(false),
    app_access: bool(false),
    permissions: o2m('directus_permissions', 'policy', 'delete'),
  },
  { snapshot: true, defaults: { icon: 'badge' }, normalize: normalizePolicy },
);

export const PERMISSIONS = collection(
  'directus_permissions',
  'cirrus_permissions',
  {
    id: { type: 'integer', primary: true, autoIncrement: true },
    policy: { type: 'uuid', required: true },
    collection: string(64, { required: true }),
    action: string(10, { required: true }),
    permissions: json,
    validation: json,
    presets: json,
    fields: json,
  },
  { snapshot: true, defaults: {}, normalize: normalizePermission },
);

export const ACCESS = collection(
  'directus_access',
  'cirrus_access',
  {
    id: ID,
    role: { type: 'uuid' },
    user: { type: 'uuid' },
    policy: { type: 'uuid', required: true },
    sort: { type: 'integer' },
  },
  { snapshot: true, defaults: {}, normalize: normalizeAccess },
);

export const SYSTEM_COLLECTIONS: ReadonlyMap<string, SystemCollection> = new Map(
  [USERS, ROLES, POLICIES, PERMISSIONS, ACCESS].map((c) => [c.collection, c]),
);

/** Map SQLite table names in error messages back to collection names. */
export const collectionOfTable = (table: string) => [...SYSTEM_COLLECTIONS.values()].find((c) => c.table === table)?.collection ?? table;
