import type { FieldType } from '@cirrus/schema';

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
};

/** What selects rows: everything but `fields` and `meta`. */
export type RowQuery = Pick<Query, 'filter' | 'search' | 'sort' | 'limit' | 'offset'>;

export type PrimaryKey = string | number;
