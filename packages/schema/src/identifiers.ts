import { invalidPayload } from '@cirrus/shared';

/**
 * Collection and field names become SQL identifiers, so they are restricted to a safe charset.
 * SQLite compares identifiers case-insensitively: callers must also reject names that only differ in case.
 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// cirrus_: system tables. directus_: reserved by Directus. sqlite_: reserved by SQLite.
const RESERVED_COLLECTION_PREFIXES = ['cirrus_', 'directus_', 'sqlite_'];
// SQLite resolves these to the hidden rowid.
const RESERVED_FIELD_NAMES = ['rowid', 'oid'];

const describe = (v: unknown) => (typeof v === 'string' ? `"${v}"` : String(v));

export function assertCollectionName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw invalidPayload(
      `Collection name ${describe(name)} is invalid. Use up to 64 letters, digits and underscores, starting with a letter`,
    );
  }
  const prefix = RESERVED_COLLECTION_PREFIXES.find((p) => name.toLowerCase().startsWith(p));
  if (prefix) throw invalidPayload(`Collections can't start with "${prefix}"`);
}

export function assertFieldName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw invalidPayload(
      `Field name ${describe(name)} is invalid. Use up to 64 letters, digits and underscores, starting with a letter`,
    );
  }
  if (RESERVED_FIELD_NAMES.includes(name.toLowerCase())) throw invalidPayload(`Field name "${name}" is reserved`);
}

/** Quote an identifier for SQLite. Names are validated first; quoting is defense in depth. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
