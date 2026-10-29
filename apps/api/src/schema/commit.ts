import { FOREIGN_KEY_CONSTRAINT } from '@cirrus/query';
import { REBUILD_PREFIX } from '@cirrus/schema';
import { CirrusError, invalidPayload, uuidv7 } from '@cirrus/shared';
import { invalidateSchema, readSchemaVersion, type Schema } from './store.ts';

/**
 * Schema changes run as one D1 batch with a compare-and-swap on schema_version (spec §7.2, ADR-012).
 */

export const prepare = (db: D1Database, sql: string[]) => sql.map((s) => db.prepare(s));

export type ErrorContext = { collection: string; field?: string | undefined };

/**
 * Run a schema change atomically. The first statement swaps schema_version for a new value only if
 * it still matches the snapshot the change was planned against; otherwise it writes invalid JSON,
 * the json_valid CHECK fails and the whole batch rolls back. D1 has no interactive transactions,
 * so this compare-and-swap is what stops two concurrent changes from overwriting each other.
 */
export async function commit(db: D1Database, schema: Pick<Schema, 'version'>, statements: D1PreparedStatement[], ctx: ErrorContext) {
  if (statements.length === 0) return;
  const bump = db
    .prepare("UPDATE cirrus_settings SET value = CASE WHEN value = ?1 THEN ?2 ELSE 'conflict' END WHERE key = 'schema_version'")
    .bind(schema.version, JSON.stringify(uuidv7()));
  try {
    await db.batch([bump, ...statements]);
  } catch (err) {
    if ((await readSchemaVersion(db)) !== schema.version) {
      throw new CirrusError('SERVICE_UNAVAILABLE', 'The schema was changed by another request. Please retry.');
    }
    throw translateDbError(err, ctx);
  } finally {
    invalidateSchema();
  }
}

const tableName = (t: string) => (t.startsWith(REBUILD_PREFIX) ? t.slice(REBUILD_PREFIX.length) : t);

/** Turn SQLite errors from DDL on existing data into Directus errors. */
export function translateDbError(err: unknown, ctx: ErrorContext): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  let m: RegExpExecArray | null;

  if ((m = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [tableName(m[1]!), m[2]!];
    return new CirrusError('CONTAINS_NULL_VALUES', `Field "${field}" in collection "${collection}" contains null values.`, {
      collection,
      field,
    });
  }
  if (msg.includes('Cannot add a NOT NULL column')) {
    return new CirrusError(
      'CONTAINS_NULL_VALUES',
      `Field "${ctx.field}" in collection "${ctx.collection}" would contain null values: make it nullable or give it a default value.`,
      { collection: ctx.collection, field: ctx.field },
    );
  }
  if ((m = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [tableName(m[1]!), m[2]!];
    return new CirrusError('RECORD_NOT_UNIQUE', `Value for field "${field}" in collection "${collection}" has to be unique.`, {
      collection,
      field,
    });
  }
  if ((m = /cannot store \w+ value in (\w+) column (\w+)\.(\w+)/.exec(msg))) {
    return invalidPayload(`Existing values of field "${m[3]}" in collection "${tableName(m[2]!)}" can't be stored as ${m[1]}`);
  }
  // A relation's guard: the field already holds keys of items that don't exist.
  if (msg.includes(`CHECK constraint failed: ${FOREIGN_KEY_CONSTRAINT}`)) {
    return new CirrusError('INVALID_FOREIGN_KEY', `Field "${ctx.field}" in collection "${ctx.collection}" holds keys of items that don't exist.`, {
      collection: ctx.collection,
      field: ctx.field,
    });
  }
  if (msg.includes('CHECK constraint failed')) {
    return invalidPayload(`Existing values in collection "${ctx.collection}" don't fit the new field type`);
  }
  return err;
}
