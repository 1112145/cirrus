import { isKeyRef, type Present, type QueryField, type Row } from '@cirrus/query';
import { type DbValue, formatTemporal, fromDbValue, isIntegerString, isUuidLike, NOW, toDbValue, ValueMismatch } from '@cirrus/schema';
import { CirrusError, forbidden, hashSecret, invalidPayload, isPlainObject, sha256Hex, uuidv7 } from '@cirrus/shared';
import { anyCollection, type FieldRecord, m2oOf, o2mOf, type RelationRecord, type Schema } from '../schema/store.ts';
import type { ItemsContext } from './context.ts';

export type Item = Record<string, unknown>;
export type Key = string | number;

/** A relational field in a payload: a nested write to the related items. */
export type Nested = { field: FieldRecord; relation: RelationRecord; value: unknown };

export type Converted = {
  row: Row;
  /** O2M aliases: written after the item, since the related items point at it. */
  nested: Nested[];
  /** M2O fields given as objects: written before the item, which gets their keys. */
  m2o: Array<Nested & { value: Record<string, unknown> }>;
  /** M2O fields set to keys that must reference items (relations with a schema). */
  refs: string[];
  /** Fields whose values are hashed once validation has seen them. */
  secrets: string[];
};

/**
 * API payload → column values, like Directus' PayloadService: applies field specials and checks
 * each value against its field type. Keys that aren't columns are ignored, as in Directus;
 * relational fields come back as nested writes. Values that are keys stashed in the batch
 * (KeyRef, from nested creates) are taken as they are; so are the `trusted` fields' keys (a nested
 * O2M's link to its parent), which need no foreign key check. Hashing waits for hashSecrets(), so
 * validation sees the values as sent.
 */
export async function toRow(
  ctx: ItemsContext,
  payload: Record<string, unknown>,
  action: 'create' | 'update',
  trusted: ReadonlySet<string> = new Set(),
): Promise<Converted> {
  const { collection, now } = ctx;
  const schema = ctx.req.schema;
  const out: Converted = { row: {}, nested: [], m2o: [], refs: [], secrets: [] };

  for (const f of collection.fields) {
    let value = Object.hasOwn(payload, f.field) ? payload[f.field] : undefined;
    if (!f.column) {
      const relation = o2mOf(schema, collection.collection, f.field);
      if (relation && value !== undefined) out.nested.push({ field: f, relation, value });
      continue;
    }
    if (isKeyRef(value)) {
      out.row[f.field] = value;
      continue;
    }
    const relation = m2oOf(schema, collection.collection, f.field);
    if (relation && isPlainObject(value)) {
      out.m2o.push({ field: f, relation, value });
      continue;
    }
    const special = f.meta.special ?? [];

    // ADR-007: UUID primary keys get a UUIDv7, like fields with the `uuid` special.
    if (action === 'create' && !value && (special.includes('uuid') || (f.column.primaryKey && f.type === 'uuid'))) {
      value = uuidv7();
    }
    if (special.includes(action === 'create' ? 'date-created' : 'date-updated')) value = formatTemporal(f.type, now);
    if (special.includes(action === 'create' ? 'user-created' : 'user-updated')) value = ctx.accountability.user;
    if (value === undefined) continue;

    let v: DbValue;
    try {
      v = toDbValue(f.type, value);
    } catch (e) {
      if (e instanceof ValueMismatch) throw invalidPayload(`"${f.field}" must be ${e.expected}`);
      throw e;
    }
    // SQLite doesn't enforce lengths; Directus (on Postgres) reports varchar overflows like this.
    if (typeof v === 'string' && f.column.maxLength !== null && f.type !== 'hash' && [...v].length > f.column.maxLength) {
      throw new CirrusError('VALUE_TOO_LONG', `Value for field "${f.field}" in collection "${collection.collection}" is too long.`, {
        collection: collection.collection,
        field: f.field,
      });
    }
    if (v !== null && (f.type === 'hash' || special.includes('hash') || special.includes('static-token'))) out.secrets.push(f.field);
    if (v !== null && relation && checked(relation) && !trusted.has(f.field)) out.refs.push(f.field);
    out.row[f.field] = v;
  }
  return out;
}

/** Relations whose keys Cirrus checks: user relations with a schema (system tables check their own). */
export const checked = (r: RelationRecord) => r.onDelete !== null && !r.system;

/**
 * Hash secret fields in place: `hash` fields with PBKDF2-SHA256 (PHC format); static tokens with
 * SHA-256, since they are looked up by their digest on every request.
 */
export async function hashSecrets(ctx: ItemsContext, row: Row, secrets: readonly string[]): Promise<void> {
  for (const name of secrets) {
    const v = row[name];
    if (v === null || v === undefined || isKeyRef(v)) continue;
    const f = ctx.collection.fields.find((x) => x.field === name)!;
    row[name] = f.meta.special?.includes('static-token') ? await sha256Hex(String(v)) : await hashSecret(String(v));
  }
}

const CONCEALED = '**********';

const maskedCache = new WeakMap<Schema, Map<string, Set<string>>>();

/** Stored values → API values, for any collection a read reaches: booleans, JSON, CSV; `conceal` fields are masked, as in Directus. */
export function presenter(schema: Schema): Present {
  let cache = maskedCache.get(schema);
  if (!cache) maskedCache.set(schema, (cache = new Map()));
  const masked = (collection: string) => {
    let set = cache.get(collection);
    if (!set) {
      set = new Set(anyCollection(schema, collection)?.fields.filter((f) => f.meta.special?.includes('conceal')).map((f) => f.field));
      cache.set(collection, set);
    }
    return set;
  };
  return (c, f, raw) => {
    const v = fromDbValue(f.type, raw);
    return v !== null && masked(c.collection).has(f.field) ? CONCEALED : v;
  };
}

/** A singleton without its row reads as the field defaults (Directus readSingleton). */
export function defaultItem(ctx: ItemsContext, fields: readonly QueryField[]): Item {
  const item: Item = {};
  for (const { field } of fields) {
    const f = ctx.collection.fields.find((x) => x.field === field)!;
    const d = f.column?.defaultValue ?? null;
    if (f.column?.primaryKey || d === null || d === NOW) {
      item[field] = null;
      continue;
    }
    try {
      item[field] = fromDbValue(f.type, toDbValue(f.type, d));
    } catch {
      item[field] = d;
    }
  }
  return item;
}

/** A primary key from the URL or a payload. Malformed keys are FORBIDDEN, as in Directus (validateKeys). */
export function parseKey(ctx: ItemsContext, raw: unknown): Key {
  const pk = ctx.collection.fields.find((f) => f.field === ctx.info.primary)!;
  switch (pk.type) {
    case 'uuid':
      if (isUuidLike(raw)) return raw.toLowerCase();
      break;
    case 'integer':
    case 'bigInteger': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && isIntegerString(raw) ? Number(raw) : NaN;
      if (Number.isSafeInteger(n)) return n;
      break;
    }
    default:
      if (typeof raw === 'string' && raw !== '') return raw;
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  throw forbidden();
}

export function parseKeys(ctx: ItemsContext, raw: unknown): Key[] {
  if (!Array.isArray(raw) || !raw.every((k) => typeof k === 'string' || typeof k === 'number')) {
    throw invalidPayload('"keys" must be an array of primary keys');
  }
  return raw.map((k) => parseKey(ctx, k));
}
