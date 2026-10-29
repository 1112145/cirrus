import { FILES } from './schema.ts';

/**
 * Directus' system collections as the app uses them: the SDK reaches them at their own paths
 * (/users, /roles, …), never at /items/directus_*, which the API refuses (as Directus does).
 */

export const USERS = 'directus_users';
export const ROLES = 'directus_roles';
export const POLICIES = 'directus_policies';
export const PERMISSIONS = 'directus_permissions';
export const ACCESS = 'directus_access';
export const FOLDERS = 'directus_folders';

const PATHS: Record<string, string> = {
  [USERS]: '/users',
  [ROLES]: '/roles',
  [POLICIES]: '/policies',
  [PERMISSIONS]: '/permissions',
  [ACCESS]: '/access',
  [FILES]: '/files',
  [FOLDERS]: '/folders',
};

export const isSystem = (collection: string) => collection.startsWith('directus_');

/** The API path of a collection's items. */
export const pathOf = (collection: string) => PATHS[collection] ?? `/items/${collection}`;

/** How system items are named, and the fields that takes (with their key). */
const DISPLAY: Record<string, { template: string; fields: string[] }> = {
  [USERS]: { template: '{{ first_name }} {{ last_name }}', fields: ['id', 'first_name', 'last_name', 'email', 'avatar'] },
  [ROLES]: { template: '{{ name }}', fields: ['id', 'name'] },
  [POLICIES]: { template: '{{ name }}', fields: ['id', 'name'] },
  [FILES]: { template: '{{ title }}', fields: ['id', 'title', 'type', 'filename_download'] },
  [FOLDERS]: { template: '{{ name }}', fields: ['id', 'name'] },
};

export const systemDisplay = (collection: string) => DISPLAY[collection] ?? null;

/** What names an item when its template renders nothing: a file's name, a user's email. */
export function fallbackLabel(collection: string, item: Record<string, unknown>): string | null {
  const v = collection === FILES ? item.filename_download : collection === USERS ? item.email : null;
  return typeof v === 'string' && v ? v : null;
}

/**
 * The collections a policy's permissions can name besides the user collections: the system ones
 * Cirrus serves, with what they hold.
 */
export const SYSTEM_PERMISSION_COLLECTIONS: Array<{ collection: string; label: string }> = [
  { collection: FILES, label: 'Files' },
  { collection: FOLDERS, label: 'Folders' },
  { collection: USERS, label: 'Users' },
  { collection: ROLES, label: 'Roles' },
  { collection: POLICIES, label: 'Policies' },
  { collection: PERMISSIONS, label: 'Permissions' },
  { collection: ACCESS, label: 'Access (policies of roles and users)' },
];

/** The app's page for an item, if it has one. */
export function itemRoute(collection: string, key: string | number): string | null {
  const k = encodeURIComponent(String(key));
  switch (collection) {
    case USERS:
      return `/users/${k}`;
    case FILES:
      return `/files/${k}`;
    case ROLES:
      return `/settings/roles/${k}`;
    case POLICIES:
      return `/settings/policies/${k}`;
    case FOLDERS:
      return `/files?folder=${k}`;
    default:
      return isSystem(collection) ? null : `/content/${collection}/${k}`;
  }
}

/** The fields of the system collections, for choosing which a permission allows (as the API defines them). */
export const SYSTEM_FIELDS: Record<string, string[]> = {
  [USERS]: ['id', 'first_name', 'last_name', 'email', 'password', 'location', 'title', 'description', 'tags', 'avatar', 'language', 'token', 'last_access', 'last_page', 'provider', 'external_identifier', 'auth_data', 'email_notifications', 'appearance', 'theme_dark', 'theme_light', 'theme_light_overrides', 'theme_dark_overrides', 'status', 'role', 'policies'],
  [ROLES]: ['id', 'name', 'icon', 'description', 'parent', 'children', 'policies', 'users'],
  [POLICIES]: ['id', 'name', 'icon', 'description', 'ip_access', 'enforce_tfa', 'admin_access', 'app_access', 'permissions'],
  [PERMISSIONS]: ['id', 'policy', 'collection', 'action', 'permissions', 'validation', 'presets', 'fields'],
  [ACCESS]: ['id', 'role', 'user', 'policy', 'sort'],
  [FILES]: ['id', 'title', 'description', 'tags', 'location', 'storage', 'focal_point_x', 'focal_point_y', 'filename_disk', 'filename_download', 'metadata', 'type', 'filesize', 'created_on', 'modified_by', 'modified_on', 'embed', 'uploaded_by', 'uploaded_on', 'folder', 'width', 'height', 'charset', 'duration'],
  [FOLDERS]: ['id', 'name', 'parent'],
};

/** A user's statuses (only active users may log in). */
export const USER_STATUSES = [
  { value: 'active', text: 'Active' },
  { value: 'draft', text: 'Draft' },
  { value: 'invited', text: 'Invited' },
  { value: 'unverified', text: 'Unverified' },
  { value: 'suspended', text: 'Suspended' },
  { value: 'archived', text: 'Archived' },
];
