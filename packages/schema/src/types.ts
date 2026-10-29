/**
 * Field types use the Directus 11 names, so payloads from @directus/sdk work unchanged (ADR-008).
 * Each maps to a column type of a STRICT SQLite table (spec §7.1).
 */
export const FIELD_TYPES = [
  'string',
  'text',
  'uuid',
  'hash',
  'csv',
  'integer',
  'bigInteger',
  'float',
  'decimal',
  'boolean',
  'dateTime',
  'date',
  'time',
  'timestamp',
  'json',
  'alias',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const isFieldType = (v: unknown): v is FieldType => (FIELD_TYPES as readonly unknown[]).includes(v);

export type SqliteType = 'TEXT' | 'INTEGER' | 'REAL';

type TypeInfo = {
  /** Column type; null for alias fields, which have no column. */
  sql: SqliteType | null;
  /** Extra CHECK constraint on the column. */
  check?: 'boolean' | 'json';
  /** Can be the primary key. */
  primaryKey?: true;
  /** Accepts CURRENT_TIMESTAMP as a default. */
  temporal?: true;
};

export const TYPE_INFO: Record<FieldType, TypeInfo> = {
  string: { sql: 'TEXT', primaryKey: true },
  text: { sql: 'TEXT' },
  uuid: { sql: 'TEXT', primaryKey: true },
  hash: { sql: 'TEXT' },
  csv: { sql: 'TEXT' },
  integer: { sql: 'INTEGER', primaryKey: true },
  bigInteger: { sql: 'INTEGER', primaryKey: true },
  float: { sql: 'REAL' },
  // SQLite has no exact decimal type; REAL matches what Directus gets on SQLite.
  decimal: { sql: 'REAL' },
  boolean: { sql: 'INTEGER', check: 'boolean' },
  dateTime: { sql: 'TEXT', temporal: true },
  date: { sql: 'TEXT', temporal: true },
  time: { sql: 'TEXT', temporal: true },
  timestamp: { sql: 'TEXT', temporal: true },
  json: { sql: 'TEXT', check: 'json' },
  alias: { sql: null },
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Column properties (the Directus `schema` object). */
export type ColumnDef = {
  primaryKey: boolean;
  autoIncrement: boolean;
  nullable: boolean;
  unique: boolean;
  indexed: boolean;
  /** Normalized by `normalizeDefault`; null = no default. */
  defaultValue: JsonValue;
  /** Reported to clients; SQLite doesn't enforce lengths or precision. */
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
};

export type FieldDef = {
  field: string;
  type: FieldType;
  /** null exactly when type is 'alias'. */
  column: ColumnDef | null;
};

export type TableDef = {
  name: string;
  fields: readonly FieldDef[];
};
