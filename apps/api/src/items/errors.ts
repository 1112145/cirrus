import { CirrusError, invalidPayload } from '@cirrus/shared';

/** SQLite errors from item writes → Directus errors. Values are checked beforehand, so these are mostly constraints. */
export function translateItemError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  let m: RegExpExecArray | null;

  if ((m = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [m[1]!, m[2]!];
    return new CirrusError('RECORD_NOT_UNIQUE', `Value for field "${field}" in collection "${collection}" has to be unique.`, {
      collection,
      field,
    });
  }
  if ((m = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(msg))) {
    const [collection, field] = [m[1]!, m[2]!];
    return new CirrusError('NOT_NULL_VIOLATION', `Value for field "${field}" in collection "${collection}" can't be null.`, {
      collection,
      field,
    });
  }
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
