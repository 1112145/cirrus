import type { QueryField, Row } from '@cirrus/query';
import { type DbValue, formatTemporal, fromDbValue, isIntegerString, isUuidLike, NOW, toDbValue, ValueMismatch } from '@cirrus/schema';
import { CirrusError, forbidden, hashSecret, invalidPayload, isPlainObject, uuidv7 } from '@cirrus/shared';
import type { ItemsContext } from './context.ts';

export type Item = Record<string, unknown>;
export type Key = string | number;

/**
 * API payload → column values, like Directus' PayloadService: applies field specials, checks each
 * value against its field type and hashes `hash` fields. Keys that aren't columns are ignored, as
 * in Directus; alias fields (nested relational writes) arrive with M4.
 */
export async function toRow(ctx: ItemsContext, body: unknown, action: 'create' | 'update'): Promise<Row> {
  if (!isPlainObject(body)) throw invalidPayload('An item must be an object');
  const { collection, now } = ctx;
  const row: Row = {};

  for (const f of collection.fields) {
    if (!f.column) continue;
    const special = f.meta.special ?? [];
    let value = Object.hasOwn(body, f.field) ? body[f.field] : undefined;

    // ADR-007: UUID primary keys get a UUIDv7, like fields with the `uuid` special.
    if (action === 'create' && !value && (special.includes('uuid') || (f.column.primaryKey && f.type === 'uuid'))) {
      value = uuidv7();
    }
    if (special.includes(action === 'create' ? 'date-created' : 'date-updated')) value = formatTemporal(f.type, now);
    // The current user, once there are users (M3).
    if (special.includes(action === 'create' ? 'user-created' : 'user-updated')) value = null;
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
    if (v !== null && (f.type === 'hash' || special.includes('hash'))) v = await hashSecret(String(v));
    row[f.field] = v;
  }
  return row;
}

const CONCEALED = '**********';

/** Rows → items: stored values back to their API form; `conceal` fields are masked, as in Directus. */
export function toItems(ctx: ItemsContext, fields: readonly QueryField[], rows: Array<Record<string, unknown>>): Item[] {
  const concealed = new Set(ctx.collection.fields.filter((f) => f.meta.special?.includes('conceal')).map((f) => f.field));
  return rows.map((row) => {
    const item: Item = {};
    for (const f of fields) {
      const v = fromDbValue(f.type, row[f.field]);
      item[f.field] = concealed.has(f.field) && v !== null ? CONCEALED : v;
    }
    return item;
  });
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
