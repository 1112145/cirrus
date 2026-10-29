/** The data model as the API describes it (Directus shapes), and what the app derives from it. */

export type FieldType =
  | 'string'
  | 'text'
  | 'uuid'
  | 'hash'
  | 'csv'
  | 'integer'
  | 'bigInteger'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'dateTime'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'json'
  | 'alias';

export type FieldMeta = {
  special: string[] | null;
  interface: string | null;
  options: Record<string, unknown> | null;
  display: string | null;
  readonly: boolean;
  hidden: boolean;
  sort: number | null;
  width: string | null;
  note: string | null;
  required: boolean;
  group: string | null;
  validation: Record<string, unknown> | null;
  searchable: boolean;
};

export type FieldSchema = {
  default_value: unknown;
  max_length: number | null;
  is_nullable: boolean;
  is_unique: boolean;
  is_indexed: boolean;
  is_primary_key: boolean;
  has_auto_increment: boolean;
};

export type Field = { collection: string; field: string; type: FieldType; meta: FieldMeta | null; schema: FieldSchema | null };

export type CollectionMeta = {
  icon: string | null;
  note: string | null;
  display_template: string | null;
  hidden: boolean;
  singleton: boolean;
  sort_field: string | null;
  group: string | null;
  sort: number | null;
};

export type Collection = { collection: string; meta: CollectionMeta | null; schema: Record<string, unknown> | null };

export type Relation = {
  collection: string;
  field: string;
  related_collection: string | null;
  meta: { one_field: string | null; junction_field: string | null; sort_field: string | null; one_deselect_action: string } | null;
  schema: { on_delete: string } | null;
};

export const FILES = 'directus_files';

/** Folders (Directus collections without schema) group collections; they have no items. */
export const isFolder = (c: Collection) => c.schema === null;

export const isAlias = (f: Field) => f.type === 'alias';

export const isPrimaryKey = (f: Field) => f.schema?.is_primary_key === true;

export const specials = (f: Field) => f.meta?.special ?? [];

/** Fields set by the server: keys it generates, created/updated dates and users. */
export const isAutomatic = (f: Field) =>
  (isPrimaryKey(f) && (f.schema?.has_auto_increment || specials(f).includes('uuid') || f.type === 'uuid')) ||
  specials(f).some((s) => ['date-created', 'date-updated', 'user-created', 'user-updated'].includes(s));

/** Fields in the order the data model gives them (meta.sort, then as listed). */
export function sortFields(fields: readonly Field[]): Field[] {
  return fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.meta?.sort ?? Infinity) - (b.f.meta?.sort ?? Infinity) || a.i - b.i)
    .map(({ f }) => f);
}

/** How a field relates to other items. */
export type RelationInfo =
  | { kind: 'm2o'; related: string; relation: Relation }
  | { kind: 'file'; related: typeof FILES; relation: Relation }
  | { kind: 'o2m'; related: string; foreignKey: string; relation: Relation }
  | { kind: 'm2m'; related: string; junction: string; foreignKey: string; junctionField: string; relation: Relation; other: Relation };

/** The relation a field takes part in, if any: an M2O (a file, when it points at directus_files), an O2M or an M2M alias. */
export function relationOf(field: Pick<Field, 'collection' | 'field'>, relations: readonly Relation[]): RelationInfo | null {
  const m2o = relations.find((r) => r.collection === field.collection && r.field === field.field);
  if (m2o?.related_collection) {
    return m2o.related_collection === FILES ? { kind: 'file', related: FILES, relation: m2o } : { kind: 'm2o', related: m2o.related_collection, relation: m2o };
  }
  const o2m = relations.find((r) => r.related_collection === field.collection && r.meta?.one_field === field.field);
  if (!o2m) return null;
  const junctionField = o2m.meta?.junction_field;
  const other = junctionField ? relations.find((r) => r.collection === o2m.collection && r.field === junctionField) : undefined;
  if (junctionField && other?.related_collection) {
    return { kind: 'm2m', related: other.related_collection, junction: o2m.collection, foreignKey: o2m.field, junctionField, relation: o2m, other };
  }
  return { kind: 'o2m', related: o2m.collection, foreignKey: o2m.field, relation: o2m };
}

/** The interface a field gets when its meta names none. */
export function defaultInterface(type: FieldType): string {
  switch (type) {
    case 'text':
      return 'input-multiline';
    case 'boolean':
      return 'boolean';
    case 'dateTime':
    case 'date':
    case 'time':
    case 'timestamp':
      return 'datetime';
    case 'json':
      return 'input-code';
    case 'csv':
      return 'tags';
    case 'alias':
      return 'presentation-divider';
    default:
      return 'input';
  }
}

/** The interface to render a field with, relations first. */
export function interfaceOf(field: Field, relations: readonly Relation[]): string {
  const rel = relationOf(field, relations);
  if (rel?.kind === 'file') return field.meta?.interface === 'file' ? 'file' : 'file-image';
  if (rel?.kind === 'm2o') return 'select-dropdown-m2o';
  if (rel?.kind === 'o2m') return 'list-o2m';
  if (rel?.kind === 'm2m') return 'list-m2m';
  return field.meta?.interface ?? defaultInterface(field.type);
}

/** A collection or field name as people read it: `blog_posts` → `Blog Posts`. */
export function titleOf(name: string): string {
  return name
    .replace(/^directus_/, '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The API's rules for collection and field names, with the app's (and Directus app's) convention
 * of lowercase snake case on top.
 */
export function nameError(name: string, kind: 'collection' | 'field'): string | null {
  if (!name) return 'A name is required.';
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return 'Use lowercase letters, digits and underscores, starting with a letter.';
  if (name.length > 64) return 'Use at most 64 characters.';
  if (kind === 'collection' && ['cirrus_', 'directus_', 'sqlite_'].some((p) => name.startsWith(p))) return 'This prefix is reserved.';
  if (kind === 'field' && ['rowid', 'oid'].includes(name)) return 'This name is reserved.';
  return null;
}

/** A name from a label: `Blog posts!` → `blog_posts`. */
export const slugify = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'n$1');
