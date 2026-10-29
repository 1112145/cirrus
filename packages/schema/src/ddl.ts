import { defaultSql } from './defaults.ts';
import { quoteIdent } from './identifiers.ts';
import { type ColumnDef, type FieldDef, type TableDef, TYPE_INFO } from './types.ts';

export type ColumnField = FieldDef & { column: ColumnDef };

/** Fields that have a column (everything except aliases), in table order. */
export const columnFields = (table: TableDef): ColumnField[] =>
  table.fields.filter((f): f is ColumnField => f.column !== null);

/**
 * Column definition inside CREATE TABLE / ADD COLUMN.
 * Unique and indexed flags are not part of it: they are separate indexes, so they can be
 * added and dropped without rebuilding the table.
 */
export function columnSql(f: ColumnField): string {
  const info = TYPE_INFO[f.type];
  if (!info.sql) throw new Error(`Field "${f.field}" of type ${f.type} has no column`);

  const name = quoteIdent(f.field);
  const parts = [name, info.sql];
  const col = f.column;

  if (col.primaryKey) {
    // SQLite allows NULL in non-integer primary keys unless NOT NULL is explicit.
    parts.push(info.sql === 'INTEGER' && col.autoIncrement ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY NOT NULL');
  } else {
    if (!col.nullable) parts.push('NOT NULL');
    const dflt = defaultSql(f.type, col.defaultValue);
    if (dflt !== null) parts.push(`DEFAULT ${dflt}`);
  }

  if (info.check === 'boolean') parts.push(`CHECK (${name} IN (0, 1))`);
  if (info.check === 'json') parts.push(`CHECK (json_valid(${name}))`);

  return parts.join(' ');
}

/** STRICT tables reject values that can't be stored losslessly in the column type. */
export function createTableSql(table: TableDef, name: string = table.name): string {
  const cols = columnFields(table);
  const pks = cols.filter((f) => f.column.primaryKey);
  if (pks.length !== 1) throw new Error(`Table "${table.name}" needs exactly one primary key, got ${pks.length}`);
  return `CREATE TABLE ${quoteIdent(name)} (\n  ${cols.map(columnSql).join(',\n  ')}\n) STRICT`;
}

export type IndexKind = 'unique' | 'index';

export const indexKind = (f: FieldDef): IndexKind | null => {
  if (!f.column || f.column.primaryKey) return null;
  if (f.column.unique) return 'unique';
  if (f.column.indexed) return 'index';
  return null;
};

/**
 * Index names share SQLite's namespace with tables. Collection and field names can't contain dots,
 * so "<table>.<field>.<kind>" never collides with a table or with another index.
 */
export const indexName = (table: string, field: string, kind: IndexKind) => `${table}.${field}.${kind}`;

export function createIndexSql(table: string, field: string, kind: IndexKind): string {
  const unique = kind === 'unique' ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX ${quoteIdent(indexName(table, field, kind))} ON ${quoteIdent(table)} (${quoteIdent(field)})`;
}

export const dropIndexSql = (table: string, field: string, kind: IndexKind) =>
  `DROP INDEX ${quoteIdent(indexName(table, field, kind))}`;

export function createIndexesSql(table: TableDef): string[] {
  return columnFields(table).flatMap((f) => {
    const kind = indexKind(f);
    return kind ? [createIndexSql(table.name, f.field, kind)] : [];
  });
}

export const dropTableSql = (name: string) => `DROP TABLE ${quoteIdent(name)}`;
