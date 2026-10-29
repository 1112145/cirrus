import type { DbValue, FieldType } from '@cirrus/schema';
import type { Access } from './access.ts';

/** What the query compiler needs to know about a collection, taken from the schema snapshot. */
export type QueryCollection = {
  collection: string;
  /** Table name when it isn't the collection name (system collections: directus_users → cirrus_users). */
  table?: string;
  primary: string;
  /** Default sort (Directus meta.sort_field); null sorts by the primary key. */
  sortField: string | null;
  /** In schema order, alias fields included. */
  fields: readonly QueryField[];
};

export type QueryField = {
  field: string;
  type: FieldType;
  /** Directus meta.searchable: included in `search`. */
  searchable: boolean;
  /**
   * Hashed or concealed values (passwords, tokens): requests may only test them for null, so their
   * values can't be recovered by filtering (`_starts_with` …) or sorting on them.
   */
  concealed?: boolean;
  /** The relation the field belongs to, if any (spec §9). */
  relation?: QueryRelation | null;
};

/**
 * A field's relation, seen from its collection:
 * - m2o: a column holding the primary key of an item of `collection`;
 * - o2m: an alias listing the items of `collection` whose `field` holds this item's key.
 * M2M is an O2M to the junction collection, whose M2O points at the other side.
 */
export type QueryRelation =
  | { type: 'm2o'; collection: string }
  | { type: 'o2m'; collection: string; field: string; sortField: string | null };

/** Resolves the collections relational paths lead to (fields, filters, sorts, deep). */
export type Related = {
  /** A collection by name; throws FORBIDDEN when it doesn't exist. */
  collection(name: string): QueryCollection;
  /**
   * The request's read access to a collection, which applies to the related items its query
   * reaches: null for everything (admins); throws FORBIDDEN without a read permission.
   */
  readAccess(name: string): Access | null;
};

/** A Directus filter; values have been through `parseFilter`, so dynamic variables are resolved. */
export type Filter = { [key: string]: unknown };

export type MetaKey = 'total_count' | 'filter_count';

/** A sanitized Directus query (spec §8.2). */
export type Query = {
  fields: string[];
  filter: Filter | null;
  search: string | null;
  /** null = the collection's default sort. */
  sort: string[] | null;
  /** -1 = no limit. */
  limit: number;
  offset: number;
  meta: MetaKey[];
  /** Queries for relational fields (Directus `deep`); null when there are none. */
  deep?: Deep | null;
};

/** What selects rows: everything but `fields` and `meta`. */
export type RowQuery = Pick<Query, 'filter' | 'search' | 'sort' | 'limit' | 'offset'>;

/**
 * Directus `deep`, by relational field: the query for the related items (`_filter`, `_search`,
 * `_sort`, `_limit`, `_offset`, `_page`) and the deep queries of their own relational fields.
 * `limit` is null when the request leaves it to the default.
 */
export type Deep = { [field: string]: DeepQuery };

export type DeepQuery = Omit<RowQuery, 'limit'> & { limit: number | null; deep: Deep | null };

export type PrimaryKey = string | number;

/**
 * A key a statement earlier in the same batch stashed (`stashKeys`, `stashNewKey`): the key of an
 * item a nested write creates with an auto-increment key, so it isn't known when the batch is built.
 */
export type KeyRef = { slot: number };

export const isKeyRef = (v: unknown): v is KeyRef =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as KeyRef).slot === 'number';

/** Column values for a write. Names must be columns of the collection. */
export type Row = Record<string, DbValue | KeyRef>;
