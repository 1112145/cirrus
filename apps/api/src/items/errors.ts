import { GUARD_TABLE } from '@cirrus/query';
import { CirrusError, forbidden, invalidPayload } from '@cirrus/shared';
import { collectionOfTable } from '../system/collections.ts';

/** SQLite errors from item writes → Directus errors. Values are checked beforehand, so these are mostly constraints. */
export function translateItemError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  let m: RegExpExecArray | null;

  // A guard statement found a row the request may not write (or one that doesn't exist).
  if (msg.includes(`CHECK constraint failed: ${GUARD_TABLE}`)) return forbidden();
  if ((m = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [collectionOfTable(m[1]!), m[2]!];
    return new CirrusError('RECORD_NOT_UNIQUE', `Value for field "${field}" in collection "${collection}" has to be unique.`, {
      collection,
      field,
    });
  }
  if ((m = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [collectionOfTable(m[1]!), m[2]!];
    return new CirrusError('NOT_NULL_VIOLATION', `Value for field "${field}" in collection "${collection}" can't be null.`, {
      collection,
      field,
    });
  }
  // SQLite doesn't say which key; system collections are the only ones with foreign keys until M4.
  if (msg.includes('FOREIGN KEY constraint failed')) return new CirrusError('INVALID_FOREIGN_KEY', 'Invalid foreign key.');
  if ((m = /cannot store \w+ value in (\w+) column \w+\.(\w+)/.exec(msg))) {
    return invalidPayload(`"${m[2]}" can't be stored as ${m[1]}`);
  }
  if (msg.includes('CHECK constraint failed')) return invalidPayload("A value doesn't fit its field type");
  // The schema changed between reading the snapshot and running the statement.
  if (/no such (column|table)/.test(msg)) {
    return new CirrusError('SERVICE_UNAVAILABLE', 'The schema was changed by another request. Please retry.');
  }
  return err;
}
