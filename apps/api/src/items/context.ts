import type { QueryCollection } from '@cirrus/query';
import { forbidden } from '@cirrus/shared';
import type { CollectionRecord, Schema } from '../schema/store.ts';

export type ItemsContext = {
  db: D1Database;
  collection: CollectionRecord;
  info: QueryCollection;
  /** One timestamp per request, for date-created/date-updated and $NOW. */
  now: Date;
};

/** Directus answers FORBIDDEN for collections that don't exist; folders have no items either. */
export function itemsContext(db: D1Database, schema: Schema, name: string, now = new Date()): ItemsContext {
  const collection = schema.collections.get(name);
  const pk = collection?.fields.find((f) => f.column?.primaryKey);
  if (!collection || collection.folder || !pk) throw forbidden();
  return {
    db,
    collection,
    now,
    info: {
      collection: collection.collection,
      primary: pk.field,
      sortField: collection.meta.sort_field,
      fields: collection.fields.map((f) => ({ field: f.field, type: f.type, searchable: f.meta.searchable })),
    },
  };
}
