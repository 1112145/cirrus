import { invalidPayload, isUuid } from '@cirrus/shared';
import { type FieldType, type JsonValue, TYPE_INFO } from './types.ts';

/** Default value meaning "the current time", for temporal fields (Directus also accepts `now()`). */
export const NOW = 'CURRENT_TIMESTAMP';

const INTEGER_RE = /^-?\d{1,19}$/;
const NUMBER_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * Validate a default value against the field type and return its normalized form.
 * Throws INVALID_PAYLOAD when the value doesn't fit the type.
 */
export function normalizeDefault(type: FieldType, value: unknown): JsonValue {
  if (value === null || value === undefined) return null;

  const fail = (expected: string) =>
    invalidPayload(`Default value for type "${type}" must be ${expected}, got ${JSON.stringify(value)}`);
  const info = TYPE_INFO[type];

  if (type === 'alias') throw invalidPayload("Alias fields can't have a default value");

  if (info.temporal && typeof value === 'string' && (value === NOW || value.toLowerCase() === 'now()')) return NOW;

  switch (type) {
    case 'integer':
    case 'bigInteger': {
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      if (typeof value === 'string' && INTEGER_RE.test(value)) {
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : value;
      }
      throw fail('an integer');
    }
    case 'float':
    case 'decimal': {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && NUMBER_RE.test(value)) return Number(value);
      throw fail('a number');
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw fail('a boolean');
    }
    case 'json':
      // Any JSON value; rendered through JSON.stringify, which escapes control characters.
      return value as JsonValue;
    case 'uuid': {
      if (isUuid(value)) return value;
      throw fail('a UUID');
    }
    default: {
      if (typeof value !== 'string' || value.includes('\u0000')) throw fail('a string');
      return value;
    }
  }
}

const quoteString = (s: string) => `'${s.replaceAll("'", "''")}'`;

const NOW_SQL: Partial<Record<FieldType, string>> = {
  timestamp: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  dateTime: "(strftime('%Y-%m-%dT%H:%M:%S', 'now'))",
  date: "(date('now'))",
  time: "(time('now'))",
};

/**
 * Render a normalized default as SQL. DDL can't take bind parameters, so this is the one place
 * values become SQL text: numbers are checked to be finite and strings are quoted.
 */
export function defaultSql(type: FieldType, value: JsonValue): string | null {
  if (value === null) return null;
  if (value === NOW && TYPE_INFO[type].temporal) return NOW_SQL[type]!;
  if (type === 'json') return quoteString(JSON.stringify(value));
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite default: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') {
    // bigInteger beyond 2^53 is kept as a digit string
    if ((type === 'integer' || type === 'bigInteger') && INTEGER_RE.test(value)) return value;
    return quoteString(value);
  }
  throw new Error(`Unsupported default for ${type}: ${JSON.stringify(value)}`);
}

/** SQLite can only ADD COLUMN with a constant default. */
export const isConstantDefault = (type: FieldType, value: JsonValue) => !(value === NOW && TYPE_INFO[type].temporal);
