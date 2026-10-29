import { type FieldType, TYPE_INFO } from './types.ts';

/**
 * Item values: from API payloads to what a STRICT column stores, and back (spec §7.1).
 * Checking types here gives clear errors instead of SQLite's, and keeps stored values in one
 * canonical form, so equality and ordering in filters work on the stored text.
 */

/** A column value as D1 stores and returns it. */
export type DbValue = string | number | null;

/** A value that doesn't fit the field type. `expected` completes "… must be <expected>". */
export class ValueMismatch extends Error {
  constructor(readonly expected: string) {
    super(`Value must be ${expected}`);
    this.name = 'ValueMismatch';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_RE = /^-?\d+$/;
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Any 8-4-4-4-12 hex string, like Postgres' uuid type accepts (no version check). */
export const isUuidLike = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const isIntegerString = (s: string) => INTEGER_RE.test(s) && Number.isSafeInteger(Number(s));
export const isNumberString = (s: string) => NUMBER_RE.test(s) && Number.isFinite(Number(s));

export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  throw new ValueMismatch('a string');
}

/** D1 returns INTEGER columns as JS numbers, so larger integers couldn't be read back exactly. */
export function asInteger(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && INTEGER_RE.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new ValueMismatch('an integer');
  if (!Number.isSafeInteger(n)) {
    throw new ValueMismatch(`an integer between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}`);
  }
  return n;
}

export function asNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && NUMBER_RE.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new ValueMismatch('a number');
  return n;
}

export function asBoolean(v: unknown): 0 | 1 {
  if (v === true || v === 1 || v === 'true' || v === '1') return 1;
  if (v === false || v === 0 || v === 'false' || v === '0') return 0;
  throw new ValueMismatch('a boolean');
}

// Dates ------------------------------------------------------------------------------------------

type Temporal = 'dateTime' | 'date' | 'time' | 'timestamp';

export const isTemporal = (type: FieldType): type is Temporal => TYPE_INFO[type].temporal === true;

const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;

const EXPECTED: Record<Temporal, string> = {
  timestamp: 'an ISO 8601 date and time',
  dateTime: 'a date and time (YYYY-MM-DDTHH:MM:SS)',
  date: 'a date (YYYY-MM-DD)',
  time: 'a time (HH:MM:SS)',
};

/**
 * Storage format per type: the same text SQLite's own defaults produce (`CURRENT_TIMESTAMP`
 * defaults in defaults.ts), so stored values compare correctly as strings. All in UTC.
 */
export function formatTemporal(type: FieldType, date: Date): string {
  const iso = date.toISOString();
  switch (type) {
    case 'dateTime':
      return iso.slice(0, 19);
    case 'date':
      return iso.slice(0, 10);
    case 'time':
      return iso.slice(11, 19);
    default:
      return iso;
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: string; zone: string | undefined };

function parseDateTime(s: string): Parts | null {
  const m = DATETIME_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > daysInMonth(y!, mo!) || h! > 23 || mi! > 59 || sec! > 59) return null;
  return { y: y!, mo: mo!, d: d!, h: h!, mi: mi!, s: sec!, ms: (m[7] ?? '.000').padEnd(4, '0').slice(0, 4), zone: m[8] };
}

/** The instant a parsed value stands for; no zone means UTC. */
function instant(p: Parts): Date {
  let zone = (p.zone ?? 'Z').toUpperCase();
  if (zone !== 'Z') zone = zone.length === 3 ? `${zone}:00` : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  return new Date(`${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.ms}${zone}`);
}

/** Normalize a date/time value (a string, or a Date from `$NOW`) to the storage format of `type`. */
export function normalizeTemporal(type: Temporal, v: unknown): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new ValueMismatch(EXPECTED[type]);
    return formatTemporal(type, v);
  }
  if (typeof v !== 'string') throw new ValueMismatch(EXPECTED[type]);

  if (type === 'time') {
    const m = TIME_RE.exec(v.trim());
    const [h, mi, s] = m ? [m[1], m[2], m[3] ?? '0'].map(Number) : [];
    if (!m || h! > 23 || mi! > 59 || s! > 59) throw new ValueMismatch(EXPECTED.time);
    return `${pad(h!)}:${pad(mi!)}:${pad(s!)}`;
  }

  const p = parseDateTime(v);
  if (!p) throw new ValueMismatch(EXPECTED[type]);
  switch (type) {
    case 'date':
      // The calendar date as written; a time or zone after it is ignored.
      return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
    case 'dateTime':
      // No time zone in the stored value: a given zone is converted to UTC, otherwise kept as written.
      return p.zone ? formatTemporal('dateTime', instant(p)) : `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
    case 'timestamp':
      return instant(p).toISOString();
  }
}

// Payload values ---------------------------------------------------------------------------------

/**
 * JSON fields take any JSON value. Like Directus, a string that is valid JSON text is stored as
 * that JSON (so "[1,2]" becomes an array); any other string is stored as a JSON string.
 */
function asJsonText(v: unknown): string {
  if (typeof v === 'string') {
    try {
      JSON.parse(v);
      return v;
    } catch {
      return JSON.stringify(v);
    }
  }
  return JSON.stringify(v);
}

/**
 * Check a payload value against the field type and convert it to what the column stores.
 * null stays null (the column decides whether it is allowed). Throws ValueMismatch.
 */
export function toDbValue(type: FieldType, v: unknown): DbValue {
  if (v === null) return null;
  switch (type) {
    case 'string':
    case 'text':
    case 'hash':
      return asText(v);
    case 'uuid':
      // Lowercase, as Postgres returns them, so equality filters match.
      if (isUuidLike(v)) return v.toLowerCase();
      throw new ValueMismatch('a UUID');
    case 'csv':
      if (Array.isArray(v)) return v.map(asText).join(',');
      if (typeof v === 'string') return v;
      throw new ValueMismatch('an array of strings or a comma-separated string');
    case 'integer':
    case 'bigInteger':
      return asInteger(v);
    case 'float':
    case 'decimal':
      return asNumber(v);
    case 'boolean':
      return asBoolean(v);
    case 'json':
      return asJsonText(v);
    case 'dateTime':
    case 'date':
    case 'time':
    case 'timestamp':
      return normalizeTemporal(type, v);
    case 'alias':
      throw new Error('Alias fields have no column');
  }
}

/** Convert a stored value back to its API form: booleans, parsed JSON, CSV arrays. */
export function fromDbValue(type: FieldType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'boolean':
      return v === 1 || v === true;
    case 'json':
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    case 'csv':
      if (typeof v !== 'string') return v;
      return v === '' ? [] : v.split(',');
    default:
      return v;
  }
}
