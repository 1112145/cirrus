import type { JsonValue } from '@cirrus/schema';
import { invalidPayload } from '@cirrus/shared';

/**
 * Directus collection/field `meta` properties. One spec per property drives API validation,
 * defaults, and the flat column it is stored in (spec §17.2).
 */

type DbValue = string | number | null;
const INVALID = Symbol('invalid');

type Codec<T> = {
  expected: string;
  parse(v: unknown): T | typeof INVALID;
  toDb(v: T): DbValue;
  fromDb(v: unknown): T;
};

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text: Codec<string | null> = {
  expected: 'a string or null',
  parse: (v) => (v === null || typeof v === 'string' ? v : INVALID),
  toDb: (v) => v,
  fromDb: (v) => v as string | null,
};

const bool: Codec<boolean> = {
  expected: 'a boolean',
  parse: (v) => (typeof v === 'boolean' ? v : INVALID),
  toDb: (v) => (v ? 1 : 0),
  fromDb: (v) => v === 1,
};

const int: Codec<number | null> = {
  expected: 'an integer or null',
  parse: (v) => (v === null || Number.isSafeInteger(v) ? (v as number | null) : INVALID),
  toDb: (v) => v,
  fromDb: (v) => v as number | null,
};

const json = <T extends JsonValue>(expected: string, accept: (v: unknown) => boolean): Codec<T | null> => ({
  expected,
  parse: (v) => (v === null || accept(v) ? (v as T | null) : INVALID),
  toDb: (v) => (v === null ? null : JSON.stringify(v)),
  fromDb: (v) => (v === null ? null : (JSON.parse(v as string) as T)),
});

const jsonObject = json<{ [key: string]: JsonValue }>('an object or null', isPlainObject);
const jsonArray = json<JsonValue[]>('an array or null', Array.isArray);

const oneOf = <T extends string | null>(values: readonly T[]): Codec<T> => ({
  expected: `one of ${values.map((v) => JSON.stringify(v)).join(', ')}`,
  parse: (v) => (values.includes(v as T) ? (v as T) : INVALID),
  toDb: (v) => v,
  fromDb: (v) => v as T,
});

/** Directus accepts an array or a CSV string and always returns an array (or null when empty). */
const special: Codec<string[] | null> = {
  expected: 'an array of strings, a comma-separated string or null',
  parse(v) {
    const list =
      typeof v === 'string'
        ? v.split(',').map((s) => s.trim()).filter(Boolean)
        : Array.isArray(v) && v.every((s) => typeof s === 'string')
          ? v
          : v === null
            ? []
            : null;
    if (list === null) return INVALID;
    return list.length ? list : null;
  },
  toDb: (v) => (v === null ? null : JSON.stringify(v)),
  fromDb: (v) => (v === null ? null : (JSON.parse(v as string) as string[])),
};

type Spec<T> = { column: string; codec: Codec<T>; default: T };
type Specs = Record<string, Spec<any>>;
export type MetaOf<S extends Specs> = { [K in keyof S]: S[K] extends Spec<infer T> ? T : never };

const spec = <T>(column: string, codec: Codec<T>, dflt: NoInfer<T>): Spec<T> => ({ column, codec, default: dflt });

export const COLLECTION_META = {
  icon: spec('icon', text, null),
  note: spec('note', text, null),
  display_template: spec('display_template', text, null),
  hidden: spec('hidden', bool, false),
  singleton: spec('singleton', bool, false),
  translations: spec('translations', jsonArray, null),
  archive_field: spec('archive_field', text, null),
  archive_app_filter: spec('archive_app_filter', bool, true),
  archive_value: spec('archive_value', text, null),
  unarchive_value: spec('unarchive_value', text, null),
  sort_field: spec('sort_field', text, null),
  accountability: spec('accountability', oneOf(['all', 'activity', null]), 'all'),
  color: spec('color', text, null),
  item_duplication_fields: spec('item_duplication_fields', jsonArray, null),
  sort: spec('sort', int, null),
  group: spec('parent', text, null),
  collapse: spec('collapse', oneOf(['open', 'closed', 'locked']), 'open'),
  preview_url: spec('preview_url', text, null),
  versioning: spec('versioning', bool, false),
};

export const FIELD_META = {
  special: spec('special', special, null),
  interface: spec('interface', text, null),
  options: spec('options', jsonObject, null),
  display: spec('display', text, null),
  display_options: spec('display_options', jsonObject, null),
  readonly: spec('readonly', bool, false),
  hidden: spec('hidden', bool, false),
  sort: spec('sort', int, null),
  width: spec('width', text, 'full'),
  translations: spec('translations', jsonArray, null),
  note: spec('note', text, null),
  conditions: spec('conditions', jsonArray, null),
  required: spec('required', bool, false),
  group: spec('parent', text, null),
  validation: spec('validation', jsonObject, null),
  validation_message: spec('validation_message', text, null),
  searchable: spec('searchable', bool, true),
};

/** Column properties (the Directus `schema` object) a client may set. */
export const COLUMN_INPUT = {
  is_primary_key: spec('is_primary', bool, false),
  has_auto_increment: spec('auto_increment', bool, false),
  is_nullable: spec('nullable', bool, true),
  is_unique: spec('is_unique', bool, false),
  is_indexed: spec('is_indexed', bool, false),
  max_length: spec('max_length', int, null),
  numeric_precision: spec('numeric_precision', int, null),
  numeric_scale: spec('numeric_scale', int, null),
};

export type CollectionMeta = MetaOf<typeof COLLECTION_META>;
export type FieldMeta = MetaOf<typeof FIELD_META>;

export const metaDefaults = <S extends Specs>(specs: S): MetaOf<S> =>
  Object.fromEntries(Object.entries(specs).map(([key, s]) => [key, s.default])) as MetaOf<S>;

/** Validate the known properties present in `input`. Unknown properties are ignored, as in Directus. */
export function parseMeta<S extends Specs>(specs: S, input: unknown, path: string): Partial<MetaOf<S>> {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) throw invalidPayload(`"${path}" must be an object`);
  const out: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(specs)) {
    if (input[key] === undefined) continue;
    const value = s.codec.parse(input[key]);
    if (value === INVALID) throw invalidPayload(`"${path}.${key}" must be ${s.codec.expected}`);
    out[key] = value;
  }
  return out as Partial<MetaOf<S>>;
}

export const metaFromRow = <S extends Specs>(specs: S, row: Record<string, unknown>): MetaOf<S> =>
  Object.fromEntries(Object.entries(specs).map(([key, s]) => [key, s.codec.fromDb(row[s.column])])) as MetaOf<S>;

/** [column, value] pairs for INSERT/UPDATE. Column names come from the specs, never from input. */
export const metaToColumns = <S extends Specs>(specs: S, meta: MetaOf<S>): Array<[string, DbValue]> =>
  Object.entries(specs).map(([key, s]) => [s.column, s.codec.toDb(meta[key as keyof S])]);
