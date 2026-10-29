import { readCollections, readFields, readItemPermissions, readRelations, readUserPermissions } from '@directus/sdk';
import { reactive } from 'vue';
import { request } from '../api.ts';
import { type Collection, type Field, FILES, isFolder, isPrimaryKey, type Relation, sortFields } from '../lib/schema.ts';
import { session } from './session.ts';

/**
 * The data model the logged-in user may see (collections, fields, relations) and what they may do
 * with each collection. Loaded after login; reloaded after every data model change.
 */

export type Action = 'create' | 'read' | 'update' | 'delete';
type Permissions = Record<string, Partial<Record<Action, { access: 'none' | 'partial' | 'full'; fields?: string[] }>>>;

export const schema = reactive({
  collections: [] as Collection[],
  fields: [] as Field[],
  relations: [] as Relation[],
  permissions: {} as Permissions,
  loaded: false,
});

export async function loadSchema(): Promise<void> {
  const [collections, fields, relations, permissions] = await Promise.all([
    request<Collection[]>(readCollections()),
    request<Field[]>(readFields()),
    request<Relation[]>(readRelations()),
    request<Permissions>(readUserPermissions()),
  ]);
  Object.assign(schema, { collections, fields, relations, permissions, loaded: true });
}

export const collectionOf = (name: string) => schema.collections.find((c) => c.collection === name);

/** The fields of a collection in data model order. directus_files' are known to the app. */
export const fieldsOf = (collection: string): Field[] => (collection === FILES ? FILE_FIELDS : sortFields(schema.fields.filter((f) => f.collection === collection)));

export const fieldOf = (collection: string, field: string) => fieldsOf(collection).find((f) => f.field === field);

export const primaryKeyOf = (collection: string) => fieldsOf(collection).find(isPrimaryKey)?.field ?? 'id';

/** Whether the user may do an action on a collection (admins may do everything). */
export function can(collection: string, action: Action): boolean {
  if (session.admin) return true;
  const access = schema.permissions[collection]?.[action]?.access;
  return access !== undefined && access !== 'none';
}

export type ItemAccess = { update: boolean; delete: boolean };

/**
 * Whether the user may update and delete one item (or a singleton, with a null key): a policy may
 * allow some items only. Directus' /permissions/me/:collection/:key; admins may do everything.
 */
export async function itemAccess(collection: string, key: string | number | null): Promise<ItemAccess> {
  if (session.admin) return { update: true, delete: true };
  try {
    const r = await request<{ update?: { access?: boolean }; delete?: { access?: boolean } }>(
      key === null ? readItemPermissions(collection) : readItemPermissions(collection, String(key)),
    );
    return { update: r.update?.access === true, delete: r.delete?.access === true };
  } catch {
    // Unknown: let the API decide when saving.
    return { update: can(collection, 'update'), delete: can(collection, 'delete') };
  }
}

/** Collections with items the user may read, for navigation: not folders, not hidden. */
export const contentCollections = () =>
  schema.collections
    .filter((c) => !isFolder(c) && !c.meta?.hidden && can(c.collection, 'read'))
    .sort((a, b) => (a.meta?.sort ?? Infinity) - (b.meta?.sort ?? Infinity) || a.collection.localeCompare(b.collection));

const meta = (sort: number, extra: Partial<Field['meta'] & object> = {}): Field['meta'] => ({
  special: null,
  interface: 'input',
  options: null,
  display: null,
  readonly: false,
  hidden: false,
  sort,
  width: 'full',
  note: null,
  required: false,
  group: null,
  validation: null,
  searchable: true,
  ...extra,
});

/** A system collection's field as the app shows it (the API doesn't list system collections' fields). */
export const systemField = (collection: string, field: string, type: Field['type'], sort: number, extra: Partial<Field['meta'] & object> = {}, pk = false): Field => ({
  collection,
  field,
  type,
  meta: meta(sort, extra),
  schema: pk
    ? { default_value: null, max_length: null, is_nullable: false, is_unique: true, is_indexed: false, is_primary_key: true, has_auto_increment: false }
    : null,
});

/** directus_files as the app shows it (the API doesn't list system collections' fields). */
const FILE_FIELDS: Field[] = [
  systemField(FILES, 'id', 'uuid', 1, { hidden: true, readonly: true, special: ['uuid'] }, true),
  systemField(FILES, 'title', 'string', 2),
  systemField(FILES, 'description', 'text', 3, { interface: 'input-multiline' }),
  systemField(FILES, 'tags', 'json', 4, { interface: 'tags', special: ['cast-json'] }),
  systemField(FILES, 'location', 'text', 5, { width: 'half' }),
  systemField(FILES, 'filename_download', 'string', 6, { width: 'half' }),
  systemField(FILES, 'type', 'string', 7, { readonly: true, width: 'half' }),
  systemField(FILES, 'filesize', 'bigInteger', 8, { readonly: true, width: 'half' }),
  systemField(FILES, 'width', 'integer', 9, { readonly: true, width: 'half' }),
  systemField(FILES, 'height', 'integer', 10, { readonly: true, width: 'half' }),
  systemField(FILES, 'folder', 'uuid', 11, { hidden: true }),
  systemField(FILES, 'uploaded_on', 'timestamp', 12, { readonly: true, width: 'half' }),
  systemField(FILES, 'modified_on', 'timestamp', 13, { readonly: true, width: 'half' }),
];
